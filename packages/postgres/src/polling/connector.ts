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
  type ScanCursor,
  type ScanPage,
  STATUS_COLUMN,
  type StateValue,
  stateHash,
  UPDATED_AT_COLUMN,
  type WriteResult,
} from "@facetdb/core";
import {
  connectPostgres,
  quoteIdent,
  quoteTable,
  type SqlClient,
  type SqlConnect,
  type SqlQuery,
  type SqlRow,
} from "../sql/index.ts";
import {
  type PollingSource,
  pollingInstallSql,
  pollingOwnedColumnsQuery,
  pollingUninstallSql,
  STATE_HASH_COLUMN,
} from "./install.ts";

export type PollingConnectorOptions = {
  /** The worker login's connection string (install runs with whichever credential the caller passes). */
  readonly url: string;
  readonly source: PollingSource;
  readonly questionSet: QuestionSet;
  /**
   * A column the application bumps on every change (`updated_at`). Without one the connector
   * reads the whole table once an hour and says so. Keep it NOT NULL: a NULL is never polled.
   */
  readonly lastChangedColumn?: string;
  /** How often `watch` polls with a last-changed column. Defaults to 10 seconds. */
  readonly intervalMs?: number;
  /** How often `watch` reads the whole table without one. Defaults to one hour. */
  readonly fullScanIntervalMs?: number;
  /** Rows per database page, for polls and for `scan`. Defaults to 500. */
  readonly pageSize?: number;
  readonly clock: Clock;
  /** Where the no-column warning goes; the composition root passes its logger. */
  readonly warn: (message: string) => void;
  /** Opens the driver; defaults to postgres.js. Tests pass PGlite through the same type. */
  readonly connect?: SqlConnect;
};

export type PollingConnector = Connector & {
  /** Lets go of the database connection. Nothing else holds one. */
  close(): Promise<void>;
};

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_FULL_SCAN_INTERVAL_MS = 3_600_000;
const DEFAULT_PAGE_SIZE = 500;

const CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: false,
  transactions: true,
  sideTable: false,
  multipleWorkers: false,
};

/** A row of the state select, after the boundary check. `changed` is the last-changed column as text. */
type Polled = ReadRow & { readonly stored: string | null; readonly changed: string | null };

/**
 * Polling with a state hash. No trigger and no jobs table; `watch` reads rows changed since the
 * last poll (or the whole table hourly), hashes their state fields with core's `stateHash` and
 * yields only the keys whose hash differs from the stored `facetdb_state_hash`. `write` stores
 * that hash with the decision, so a restart, an `updated_at` bump or FacetDB's own status update
 * never asks a row again for a state it already answered. The queue is an in-process set; the
 * stored hash is the only durable memory.
 */
export function createPollingConnector(options: PollingConnectorOptions): PollingConnector {
  const {
    source,
    questionSet,
    lastChangedColumn,
    clock,
    warn,
    intervalMs = DEFAULT_INTERVAL_MS,
    fullScanIntervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
    pageSize = DEFAULT_PAGE_SIZE,
    connect = connectPostgres,
  } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const client: SqlClient = connect(options.url);
  const fields = questionSet.read;
  const onChange = source.onChange ?? "reset";
  const table = quoteTable({ schema: source.schema, name: source.table });
  const keyColumn = quoteIdent(source.key);
  const changedColumn = lastChangedColumn === undefined ? undefined : quoteIdent(lastChangedColumn);

  // The in-process queue: one entry per record, waiting or claimed by this worker.
  const waiting = new Set<RecordKey>();
  const claimed = new Set<RecordKey>();
  // `close()` sets the flag while `watch` awaits; the loop reads it through a call because
  // TypeScript narrows a bare flag to `false` inside `while (!closing)` and would call the later
  // check dead.
  let closing = false;
  const isClosing = () => closing;

  // Every column is cast to text in SQL so the hash is over the database's own text.
  const stateColumns = fields.map((field, index) => `${quoteIdent(field)}::text as s${index}`);
  const excluded =
    questionSet.where === undefined ? "false" : `not coalesce((${questionSet.where}), false)`;
  const rowColumns = [
    `${keyColumn}::text as k`,
    ...stateColumns,
    `${quoteIdent(STATE_HASH_COLUMN)} as h`,
    `${excluded} as x`,
    ...(changedColumn === undefined ? [] : [`${changedColumn}::text as c`]),
  ].join(", ");

  /** The database boundary: a row from the driver becomes a `Polled`, or an error that names the column. */
  function parseRow(row: SqlRow): Polled {
    const state: Record<string, StateValue> = {};
    fields.forEach((field, index) => {
      state[field] = textOrNull(row[`s${index}`], field);
    });
    return {
      key: requireText(row["k"], source.key),
      state,
      hash: stateHash(fields, state),
      excluded: row["x"] === true,
      stored: textOrNull(row["h"], STATE_HASH_COLUMN),
      changed: changedColumn === undefined ? null : textOrNull(row["c"], lastChangedColumn ?? ""),
    };
  }

  /** The table's columns with FacetDB-owned names, by whether they carry FacetDB's mark. */
  async function ownedColumns(
    query: SqlQuery,
    options: { readonly marked: boolean },
  ): Promise<string[]> {
    const { text, params } = pollingOwnedColumnsQuery(source, questionSet, options);
    return (await query(text, params)).map((row) => String(row["name"]));
  }

  /** One page of the table in the order the caller's keyset needs, `limit` rows at most. */
  async function page(where: string, params: readonly unknown[], order: string, limit: number) {
    const rows = await client.query(
      `select ${rowColumns} from ${table}${where === "" ? "" : ` where ${where}`} order by ${order} limit $${params.length + 1}`,
      [...params, limit],
    );
    return rows.map(parseRow);
  }

  /**
   * Reads what changed since `cursor` (a last-changed value; null on the first poll and always
   * without a column), queues the keys whose hash differs from the stored one and returns them with
   * the new cursor. Rows at the cursor's own value are read again: the hash makes that harmless and
   * it catches a row committed late with the same timestamp.
   */
  async function detect(
    cursor: string | null,
  ): Promise<{ keys: RecordKey[]; cursor: string | null }> {
    const order = changedColumn === undefined ? keyColumn : `${changedColumn}, ${keyColumn}`;
    let next = cursor;
    let after: Polled | undefined;
    const found: RecordKey[] = [];
    for (;;) {
      let batch: Polled[];
      if (after === undefined) {
        batch =
          changedColumn !== undefined && cursor !== null
            ? await page(`${changedColumn} >= $1`, [cursor], order, pageSize)
            : await page("", [], order, pageSize);
      } else if (changedColumn === undefined) {
        batch = await page(`${keyColumn} > $1`, [after.key], order, pageSize);
      } else {
        batch = await page(
          `(${changedColumn}, ${keyColumn}) > ($1, $2)`,
          [after.changed, after.key],
          order,
          pageSize,
        );
      }
      const fresh = batch.filter(
        (row) => row.stored !== row.hash && !waiting.has(row.key) && !claimed.has(row.key),
      );
      await markPending(fresh.map((row) => row.key));
      for (const row of fresh) {
        waiting.add(row.key);
        found.push(row.key);
      }
      const last = batch.at(-1);
      if (last === undefined) {
        break;
      }
      next = last.changed ?? next;
      after = last;
      if (batch.length < pageSize) {
        break;
      }
    }
    return { keys: found, cursor: next };
  }

  /** A changed record is pending until its new decision lands (`keep` leaves a decided one). */
  async function markPending(keys: readonly RecordKey[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const status = quoteIdent(STATUS_COLUMN);
    const condition =
      onChange === "reset" ? `${status} is distinct from 'pending'` : `${status} is null`;
    await client.query(
      `update ${table} set ${status} = 'pending' where ${keyColumn} = any($1) and ${condition}`,
      [keys],
    );
  }

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    if (changedColumn === undefined) {
      warn(
        `source "${source.table}" has no last-changed column, so FacetDB reads the whole table every ${fullScanIntervalMs / 60_000} minutes; name one (an updated_at the app bumps) to notice changes within ${intervalMs / 1000} seconds`,
      );
    }
    let cursor: string | null = null;
    while (!isClosing()) {
      let polled: { keys: RecordKey[]; cursor: string | null };
      try {
        polled = await detect(cursor);
      } catch (error) {
        if (isClosing()) {
          return;
        }
        throw error;
      }
      cursor = polled.cursor;
      if (polled.keys.length > 0) {
        yield polled.keys;
      }
      await clock.sleep(changedColumn === undefined ? fullScanIntervalMs : intervalMs);
    }
  }

  async function read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) {
      return { rows: [], missing: [] };
    }
    const found = new Map<RecordKey, ReadRow>();
    const result = await client.query(
      `select ${rowColumns} from ${table} where ${keyColumn} = any($1)`,
      [wanted],
    );
    for (const row of result.map(parseRow)) {
      found.set(row.key, toReadRow(row));
    }
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

  async function write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    return client.transaction(async (query) => {
      // The row lock holds the state still between the hash check and the update.
      const current = await query(
        `select ${rowColumns} from ${table} where ${keyColumn} = $1 for update`,
        [key],
      );
      const row = current[0];
      if (row === undefined || parseRow(row).hash !== expectedHash) {
        return { written: false };
      }
      const assignments: string[] = [];
      const params: unknown[] = [key];
      const set = (column: string, value: unknown): void => {
        params.push(value);
        assignments.push(`${quoteIdent(column)} = $${params.length}`);
      };
      for (const [name, answer] of Object.entries(decision.decisions)) {
        const question = questionSet.questions.find((candidate) => candidate.name === name);
        if (question === undefined) {
          throw new Error(`a decision names "${name}", which is not a question of this source`);
        }
        for (const column of answerColumns(question)) {
          const decided = answer.kind === "decided";
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
      assignments.push(
        `${quoteIdent(UPDATED_AT_COLUMN)} = to_timestamp($${params.length}::double precision / 1000)`,
      );
      if (decision.reviewed === true) {
        // Once a person decided any question the flag stays true; a write without it leaves it be.
        set(REVIEWED_COLUMN, true);
      }
      set(STATE_HASH_COLUMN, expectedHash);
      await query(`update ${table} set ${assignments.join(", ")} where ${keyColumn} = $1`, params);
      return { written: true };
    });
  }

  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    // Keyset paging by key, newest (highest) first: rows added meanwhile never shift a page.
    const rows =
      cursor === null
        ? await page("", [], `${keyColumn} desc`, pageSize + 1)
        : await page(`${keyColumn} < $1`, [cursor], `${keyColumn} desc`, pageSize + 1);
    const visible = rows.slice(0, pageSize);
    const last = visible.at(-1);
    return {
      rows: visible.map(toReadRow),
      next: rows.length > pageSize && last !== undefined ? last.key : null,
    };
  }

  return {
    capabilities: CAPABILITIES,
    // Install and uninstall each run as one transaction (DDL is transactional in Postgres): a
    // failure midway leaves the table exactly as it was, never FacetDB columns without their mark,
    // which every later install would refuse as the application's.
    install() {
      return client.transaction(async (query) => {
        // A column the application already owns is never adopted; the question or the column
        // must be renamed. FacetDB's own columns (marked at a previous install) pass.
        const taken = await ownedColumns(query, { marked: false });
        if (taken.length > 0) {
          throw new Error(
            `install refused: ${quoteTable({ schema: source.schema, name: source.table })} already has ${taken
              .map((name) => `"${name}"`)
              .join(", ")}, which FacetDB did not create; rename the question or the column`,
          );
        }
        for (const statement of pollingInstallSql(source, questionSet)) {
          await query(statement);
        }
      });
    },
    async uninstall() {
      await client.transaction(async (query) => {
        // Only the columns that carry FacetDB's mark: a same-named column of the app's survives.
        for (const statement of pollingUninstallSql(
          source,
          await ownedColumns(query, { marked: true }),
        )) {
          await query(statement);
        }
      });
      // After the commit: a failed uninstall keeps the queue, so a running watch loses nothing.
      waiting.clear();
      claimed.clear();
    },
    watch,
    read,
    write,
    scan,
    enqueue(keys) {
      for (const key of keys) {
        if (!claimed.has(key)) {
          waiting.add(key);
        }
      }
      return Promise.resolve();
    },
    claim(limit) {
      const taken = [...waiting].slice(0, limit);
      for (const key of taken) {
        waiting.delete(key);
        claimed.add(key);
      }
      return Promise.resolve(taken);
    },
    claimKey(key) {
      if (waiting.has(key) || claimed.has(key)) {
        return Promise.resolve(false);
      }
      claimed.add(key);
      return Promise.resolve(true);
    },
    ack(keys) {
      for (const key of keys) {
        claimed.delete(key);
      }
      return Promise.resolve();
    },
    release(keys) {
      for (const key of keys) {
        if (claimed.delete(key)) {
          waiting.add(key);
        }
      }
      return Promise.resolve();
    },
    close() {
      // A running `watch` ends at its next turn instead of polling a closed connection.
      closing = true;
      return client.close();
    },
  };
}

function toReadRow(row: Polled): ReadRow {
  return { key: row.key, state: row.state, hash: row.hash, excluded: row.excluded };
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
