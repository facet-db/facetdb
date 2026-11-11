import { randomUUID } from "node:crypto";
import {
  answerColumns,
  type Capabilities,
  type Clock,
  type Connector,
  type QuestionSet,
  REVIEWED_COLUMN,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  STATUS_COLUMN,
  type StateValue,
  stateHash,
  UPDATED_AT_COLUMN,
  type WriteResult,
} from "@facetdb/core";
import { queueKeyPrefix, type TableSource } from "../install/index.ts";
import { answerTarget, createScan } from "../scan/index.ts";
import {
  CLAIM_LEASE_MS,
  connectPostgres,
  jobsQueries,
  quoteIdent,
  quoteTable,
  type SqlClient,
  type SqlConnect,
  type SqlRow,
} from "../sql/index.ts";
import { stateHashSql } from "./hash-sql.ts";

/**
 * The Postgres connector runtime: the trigger the install adds queues a changed record's key in
 * `facetdb.jobs` and notifies `facetdb_jobs`; this connector wakes on that notification or on a
 * 2-second poll, claims jobs with `for update skip locked`, reads the state fields and hashes them
 * with core's `stateHash`, and writes a decision in one statement that checks the hash in SQL. It
 * runs as the worker login and holds nothing else: install and uninstall need the admin credential,
 * which the composition root passes through an `installer` for the moment of the call and never to
 * this object.
 */

/** The notification channel the trigger raises (install/sql.ts). */
export const JOBS_CHANNEL = "facetdb_jobs";

/** The poll that backs the notification: a 2-second poll as a fallback. */
export const DEFAULT_POLL_MS = 2000;

/** Keys a watch announces per pass; a worker claims smaller batches from them. */
const WATCH_BATCH = 200;

/** Install and uninstall for `Connector.install`/`uninstall`, with the admin credential inside. */
export type Installer = {
  install(): Promise<void>;
  uninstall(): Promise<void>;
};

export type PostgresConnectorOptions = {
  /** The worker login's connection string: the only credential kept. */
  readonly workerUrl: string;
  readonly source: TableSource;
  readonly questionSet: QuestionSet;
  readonly clock: Clock;
  /** Names this worker's claims; two workers never share one. Defaults to a random id. */
  readonly workerId?: string;
  /** The fallback poll of `watch`. Defaults to 2 seconds. */
  readonly pollMs?: number;
  /** Rows per `scan` page. Defaults to 500; a test pages smaller to cross page boundaries. */
  readonly scanPageSize?: number;
  /** Runs `facetdb migrate` / `uninstall` with the admin credential; without it, both throw. */
  readonly installer?: Installer;
  /** Opens the driver; defaults to postgres.js. Tests pass PGlite through the same type. */
  readonly connect?: SqlConnect;
};

export type PostgresConnector = Connector & {
  /** The id this worker claims with. */
  readonly workerId: string;
  /** Ends a running `watch` and lets go of the connection. */
  close(): Promise<void>;
};

type Parsed = ReadRow;

export function createPostgresConnector(options: PostgresConnectorOptions): PostgresConnector {
  const { source, questionSet, clock, installer, connect = connectPostgres } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error(`the poll interval is a positive number of milliseconds, not ${pollMs}`);
  }
  const client: SqlClient = connect(options.workerUrl);
  const fields = questionSet.read;
  const table = quoteTable({ schema: source.schema, name: source.table });
  const keyColumn = quoteIdent(source.key);
  const target = answerTarget(source);
  const targetRelation = quoteTable({ schema: target.schema, name: target.table });
  const sideMode = source.storage === "side-table";
  const prefix = queueKeyPrefix(source);
  const queued = (key: RecordKey): string => prefix + key;
  const unqueued = (queuedKey: string): RecordKey => queuedKey.slice(prefix.length);
  const capabilities: Capabilities = {
    inlineColumns: true,
    pushWakeup: client.listen !== undefined,
    transactions: true,
    sideTable: true,
    multipleWorkers: true,
  };
  // `close()` sets the flag while `watch` awaits; the loop reads it through a call because
  // TypeScript narrows a bare flag to `false` inside `while (!closed)` and would call the later
  // check dead.
  let closed = false;
  const isClosed = () => closed;
  let wake: (() => void) | undefined;

  // Every state column is cast to text in SQL so the hash is over the database's own text.
  // `where` is the source's own SQL filter from the config file, spliced as written (as the scan
  // and the polling connector do): the config is the operator's code, not a user value.
  const excluded =
    questionSet.where === undefined ? "false" : `not coalesce((${questionSet.where}), false)`;
  const rowColumns = [
    `${keyColumn}::text as k`,
    ...fields.map((field, index) => `${quoteIdent(field)}::text as s${index}`),
    `${excluded} as x`,
  ].join(", ");

  /** The database boundary: a driver row becomes a `ReadRow`, or an error that names the column. */
  function parseRow(row: SqlRow): Parsed {
    const state: Record<string, StateValue> = {};
    fields.forEach((field, index) => {
      state[field] = textOrNull(row[`s${index}`], field);
    });
    return {
      key: requireText(row["k"], source.key),
      state,
      hash: stateHash(fields, state),
      excluded: row["x"] === true,
    };
  }

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    // A notification sets the flag; a pass that found it skips the sleep. Keys already announced
    // and still waiting are not announced again; a key claimed and queued again is.
    let signalled = false as boolean; // set by the listener below
    const unlisten = await client.listen?.(JOBS_CHANNEL, () => {
      signalled = true;
      wake?.();
    });
    try {
      let announced = new Set<RecordKey>();
      while (!isClosed()) {
        const rows = await client.query(jobsQueries.waiting, [prefix, WATCH_BATCH]);
        const waiting = rows.map((row) => unqueued(requireText(row["record_key"], "record_key")));
        const fresh = waiting.filter((key) => !announced.has(key));
        announced = new Set(waiting);
        if (fresh.length > 0) {
          yield fresh;
        }
        if (isClosed()) {
          return;
        }
        if (!signalled) {
          await Promise.race([
            clock.sleep(pollMs),
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
          ]);
          wake = undefined;
        }
        signalled = false;
      }
    } finally {
      // After `close()` the connection is gone and so is the subscription; nothing to undo.
      if (!isClosed()) {
        await unlisten?.();
      }
    }
  }

  async function read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) {
      return { rows: [], missing: [] };
    }
    const result = await client.query(
      // The parameter takes the key column's own type, so the primary-key index serves the lookup.
      `select ${rowColumns} from ${table} where ${keyColumn} = any($1)`,
      [wanted],
    );
    const found = new Map(result.map(parseRow).map((row) => [row.key, row]));
    const rows: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const key of wanted) {
      const row = found.get(key);
      if (row === undefined) {
        missing.push(key);
      } else {
        rows.push(row);
      }
    }
    return { rows, missing };
  }

  /**
   * The columns a decision sets, with their parameters: answer columns per question role, the
   * status, the update time, and the reviewed flag only when the decision carries it (set once,
   * never cleared).
   */
  function assignmentsFor(
    decision: RecordDecision,
    params: unknown[],
  ): readonly (readonly [column: string, placeholder: string])[] {
    const out: (readonly [string, string])[] = [];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      out.push([column, `$${params.length}`]);
    };
    for (const [name, answer] of Object.entries(decision.decisions)) {
      const question = questionSet.questions.find((candidate) => candidate.name === name);
      if (question === undefined) {
        throw new Error(`a decision names "${name}", which is not a question of this source`);
      }
      const decided = answer.kind === "decided";
      for (const column of answerColumns(question)) {
        switch (column.role) {
          case "value":
            set(column.name, decided ? answer.value : null);
            break;
          case "probability":
          case "confidence":
            set(column.name, decided ? answer.probabilityOrConfidence : null);
            break;
          case "expected":
            set(column.name, decided ? (answer.expected ?? null) : null);
            break;
          case "probabilities":
            // The decision carries no probability list; the column keeps what it holds.
            break;
        }
      }
    }
    set(STATUS_COLUMN, decision.status);
    params.push(clock.now());
    out.push([UPDATED_AT_COLUMN, `to_timestamp($${params.length}::double precision / 1000)`]);
    if (decision.reviewed === true) {
      set(REVIEWED_COLUMN, true);
    }
    return out;
  }

  /**
   * One statement: the row is updated only where its state still hashes to `expectedHash`
   * (hash-sql.ts). Inline, the database checks that on the very row it locks, so a change that
   * lands between the read and this write leaves the row alone and `written` false. In side-table
   * mode the check reads the source row under the statement's snapshot (the worker login holds no
   * lock right on the source); a change committed during that instant can still be written over,
   * but the trigger has cleared the job's claim by then, so the record is asked again and the next
   * write corrects it. Only FacetDB's own columns appear in either statement.
   */
  async function write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const params: unknown[] = [key, expectedHash];
    const assignments = assignmentsFor(decision, params);
    const guard = (alias: string) =>
      `${alias}.${keyColumn} = $1 and ${stateHashSql(fields, alias)} = $2`;
    let rows: readonly SqlRow[];
    if (!sideMode) {
      rows = await client.query(
        `update ${table} as t set ${assignments
          .map(([column, value]) => `${quoteIdent(column)} = ${value}`)
          .join(", ")}
          where ${guard("t")} returning 1 as written`,
        params,
      );
    } else {
      // The side row may not exist yet (a first answer): insert it from the source row that still
      // hashes right, or update it under the same test. `facetdb_reviewed` starts false and only
      // a reviewed decision sets it.
      const columns = assignments.map(([column]) => column);
      const values = assignments.map(([, value]) => value);
      const reviewedInsert = decision.reviewed === true ? "" : `, ${quoteIdent(REVIEWED_COLUMN)}`;
      const reviewedValue = decision.reviewed === true ? "" : ", false";
      rows = await client.query(
        `insert into ${targetRelation} (${quoteIdent(target.keyColumn)}, ${columns.map(quoteIdent).join(", ")}${reviewedInsert})
          select s.${keyColumn}, ${values.join(", ")}${reviewedValue} from ${table} s where ${guard("s")}
          on conflict (${quoteIdent(target.keyColumn)}) do update set ${assignments
            .map(([column, value]) => `${quoteIdent(column)} = ${value}`)
            .join(", ")}
          where exists (select 1 from ${table} s where s.${keyColumn} = ${targetRelation}.${quoteIdent(target.keyColumn)} and ${stateHashSql(fields, "s")} = $2)
          returning 1 as written`,
        params,
      );
    }
    return { written: rows.length > 0 };
  }

  const scan = createScan({
    query: client.query,
    source,
    questionSet,
    ...(options.scanPageSize === undefined ? {} : { pageSize: options.scanPageSize }),
  });

  return {
    capabilities,
    workerId,
    install() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "install needs the admin credential, which this connector never holds: run `facetdb migrate`, or pass an installer",
          ),
        );
      }
      return installer.install();
    },
    uninstall() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "uninstall needs the admin credential, which this connector never holds: run `facetdb uninstall`, or pass an installer",
          ),
        );
      }
      return installer.uninstall();
    },
    watch,
    read,
    write,
    scan,
    async enqueue(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.enqueue, [keys.map(queued)]);
      }
    },
    async claim(limit) {
      if (limit < 1) {
        return [];
      }
      const rows = await client.query(jobsQueries.claim, [
        prefix,
        workerId,
        limit,
        clock.now(),
        CLAIM_LEASE_MS,
      ]);
      return rows.map((row) => unqueued(requireText(row["record_key"], "record_key")));
    },
    async claimKey(key) {
      const rows = await client.query(jobsQueries.claimKey, [queued(key), workerId, clock.now()]);
      return rows.length > 0;
    },
    async ack(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.ack, [workerId, keys.map(queued)]);
      }
    },
    async release(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.release, [workerId, keys.map(queued)]);
      }
    },
    async close() {
      closed = true;
      wake?.();
      await client.close();
    },
  };
}

function textOrNull(value: unknown, column: string): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value, column);
}

function requireText(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}
