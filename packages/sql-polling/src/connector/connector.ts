import {
  answerColumns,
  type Capabilities,
  type Clock,
  type Connector,
  type CurrentDecision,
  type EngineTarget,
  parseCurrent,
  REVIEWED_COLUMN,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  type ScanCursor,
  type ScanPage,
  STATE_HASH_COLUMN,
  STATUS_COLUMN,
  type StateValue,
  stateHash,
  UPDATED_AT_COLUMN,
  type WriteResult,
} from "@facetdb/core";
import type { PollingClient, PollingQuery, PollingRow, SqlDialect } from "../dialect/index.ts";
import {
  columnStatements,
  labelOf,
  markStatements,
  readTable,
  tableOf,
  uninstallStatements,
} from "../install/index.ts";
import { currentColumns } from "./current.ts";

/**
 * The table a polling connector watches: the source's table and question set (core's
 * `EngineTarget`), with its single-column key, which the engine reads from the catalog.
 */
export type PollingTarget = Pick<
  EngineTarget,
  "project" | "table" | "schema" | "onChange" | "questionSet"
> & {
  readonly key: string;
};

export type PollingConnectorOptions = {
  /**
   * A column the application bumps on every change (`updated_at`), which the engine finds in the
   * catalog. Without one the connector reads the whole table once an hour and says so. It must
   * refuse NULL: a row whose value is NULL is never polled again after the first poll.
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
};

export type PollingConnector = Connector & {
  /** Lets go of the database connection. Nothing else holds one. */
  close(): Promise<void>;
};

/** Every 10 seconds by default. */
export const POLL_INTERVAL_MS = 10_000;

/** Without a last-changed column, a full scan every hour, with a warning. */
export const FULL_SCAN_INTERVAL_MS = 3_600_000;

const DEFAULT_PAGE_SIZE = 500;

/**
 * What a polled database can do: the answers in the table's own columns, no push (the poll is the
 * wake-up), and one worker, because the queue is this process's own.
 */
export const POLLING_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: false,
  transactions: true,
  sideTable: false,
  multipleWorkers: false,
};

/** A row of the state select, after the boundary check. `changed` is the last-changed column as text. */
type Polled = ReadRow & { readonly stored: string | null; readonly changed: string | null };

/**
 * Polling with a state hash, through the dialect's SQL. No trigger and no jobs table; `watch` reads
 * rows changed since the last poll (or the whole table hourly), hashes their state fields with
 * core's `stateHash` and yields only the keys whose hash differs from the stored
 * `facetdb_state_hash`. `write` stores that hash with the decision, so a restart, an `updated_at`
 * bump or FacetDB's own status update never asks a row again for a state it already answered. The
 * queue is an in-process set; the stored hash is the only durable memory. The connector owns
 * `client` from here on: `close` closes it.
 */
export function createPollingConnector(
  dialect: SqlDialect,
  client: PollingClient,
  target: PollingTarget,
  options: PollingConnectorOptions,
): PollingConnector {
  const {
    lastChangedColumn,
    clock,
    warn,
    intervalMs = POLL_INTERVAL_MS,
    fullScanIntervalMs = FULL_SCAN_INTERVAL_MS,
    pageSize = DEFAULT_PAGE_SIZE,
  } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const { questionSet, onChange } = target;
  const fields = questionSet.read;
  const ref = tableOf(dialect, target);
  const table = dialect.quoteTable(ref.schema, ref.name);
  const keyColumn = dialect.quoteIdent(target.key);
  const changedColumn =
    lastChangedColumn === undefined ? undefined : dialect.quoteIdent(lastChangedColumn);
  const placeholder = (index: number) => dialect.placeholder(index);

  // The in-process queue: one entry per record, waiting or claimed by this worker.
  const waiting = new Set<RecordKey>();
  const claimed = new Set<RecordKey>();
  // `close()` sets the flag while `watch` awaits; the loop reads it through a call because
  // TypeScript narrows a bare flag to `false` inside `while (!closing)` and would call the later
  // check dead.
  let closing = false;
  const isClosing = () => closing;

  // Every column is read as the database's own text, so the hash is over that text.
  const rowColumns = [
    `${dialect.keyAsText(target.key)} as k`,
    ...fields.map((field, index) => `${dialect.keyAsText(field)} as s${index}`),
    `${dialect.quoteIdent(STATE_HASH_COLUMN)} as h`,
    `${dialect.excluded(questionSet.where)} as x`,
    ...(lastChangedColumn === undefined ? [] : [`${dialect.keyAsText(lastChangedColumn)} as c`]),
  ].join(", ");

  /** The database boundary: a row from the driver becomes a `Polled`, or an error that names the column. */
  function parseRow(row: PollingRow): Polled {
    const state: Record<string, StateValue> = {};
    fields.forEach((field, index) => {
      state[field] = textOrNull(row[`s${index}`], field);
    });
    return {
      key: requireText(row["k"], target.key),
      state,
      hash: stateHash(fields, state),
      excluded: row["x"] === true,
      stored: textOrNull(row["h"], STATE_HASH_COLUMN),
      changed: lastChangedColumn === undefined ? null : textOrNull(row["c"], lastChangedColumn),
    };
  }

  /** Runs `work` as one transaction where the dialect's DDL is transactional, statement by statement otherwise. */
  function inTransaction<T>(work: (query: PollingQuery) => Promise<T>): Promise<T> {
    return dialect.transactionalDdl ? client.transaction(work) : work(client.query);
  }

  /** One page of the table in the order the caller's keyset needs, `limit` rows at most. */
  async function page(where: string, params: readonly unknown[], order: string, limit: number) {
    const rows = await client.query(
      `select ${rowColumns} from ${table}${where === "" ? "" : ` where ${where}`} order by ${order} ${dialect.limit(placeholder(params.length + 1))}`,
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
            ? await page(`${changedColumn} >= ${placeholder(1)}`, [cursor], order, pageSize)
            : await page("", [], order, pageSize);
      } else if (lastChangedColumn === undefined) {
        batch = await page(`${keyColumn} > ${placeholder(1)}`, [after.key], order, pageSize);
      } else {
        // Keyset paging with the key as the tie-breaker: many rows may share one updated_at.
        batch = await page(
          dialect.after([lastChangedColumn, target.key], [placeholder(1), placeholder(2)]),
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
    const status = dialect.quoteIdent(STATUS_COLUMN);
    const pending = dialect.quoteLiteral("pending");
    const condition =
      onChange === "reset" ? `(${status} is null or ${status} <> ${pending})` : `${status} is null`;
    for (const chunk of inChunks(keys, dialect.maxInList)) {
      await client.query(
        `update ${table} set ${status} = ${pending} where ${keyColumn} ${dialect.inList(chunk.length)} and ${condition}`,
        chunk,
      );
    }
  }

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    if (changedColumn === undefined) {
      warn(
        `${labelOf(ref)} has no last-changed column, so FacetDB reads the whole table every ${fullScanIntervalMs / 60_000} minutes; give it an updated_at the application sets on every insert and every update (NOT NULL) to notice changes within ${intervalMs / 1000} seconds`,
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
    for (const chunk of inChunks(wanted, dialect.maxInList)) {
      const result = await client.query(
        `select ${rowColumns} from ${table} where ${keyColumn} ${dialect.inList(chunk.length)}`,
        chunk,
      );
      for (const row of result.map(parseRow)) {
        found.set(row.key, toReadRow(row));
      }
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
        `select ${rowColumns} from ${table} where ${keyColumn} = ${placeholder(1)} for update`,
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
        assignments.push(`${dialect.quoteIdent(column)} = ${placeholder(params.length)}`);
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
        `${dialect.quoteIdent(UPDATED_AT_COLUMN)} = ${dialect.timeFromMs(placeholder(params.length))}`,
      );
      if (decision.reviewed === true) {
        // Once a person decided any question the flag stays true; a write without it leaves it be.
        set(REVIEWED_COLUMN, true);
      }
      set(STATE_HASH_COLUMN, expectedHash);
      await query(
        `update ${table} set ${assignments.join(", ")} where ${keyColumn} = ${placeholder(1)}`,
        params,
      );
      return { written: true };
    });
  }

  /**
   * The record's own columns; a row whose status FacetDB never set (it never saw it) is absent.
   * Keys compare as text, as `explain` does, so a key the column's type cannot hold is absent, not
   * an error.
   */
  async function current(
    keys: readonly RecordKey[],
  ): Promise<ReadonlyMap<RecordKey, CurrentDecision>> {
    const wanted = [...new Set(keys)];
    const found = new Map<RecordKey, CurrentDecision>();
    if (wanted.length === 0) {
      return found;
    }
    const keyText = dialect.keyAsText(target.key);
    for (const chunk of inChunks(wanted, dialect.maxInList)) {
      const rows = await client.query(
        `select ${keyText} as k, ${currentColumns(dialect, questionSet.questions)}
         from ${table} where ${keyText} ${dialect.inList(chunk.length)}`,
        chunk,
      );
      for (const row of rows) {
        const decision = parseCurrent(row, questionSet.questions);
        if (decision !== undefined) {
          found.set(requireText(row["k"], target.key), decision);
        }
      }
    }
    return found;
  }

  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    // Keyset paging by key, newest (highest) first: rows added meanwhile never shift a page.
    const rows =
      cursor === null
        ? await page("", [], `${keyColumn} desc`, pageSize + 1)
        : await page(
            `${keyColumn} < ${placeholder(1)}`,
            [cursor],
            `${keyColumn} desc`,
            pageSize + 1,
          );
    const visible = rows.slice(0, pageSize);
    const last = visible.at(-1);
    return {
      rows: visible.map(toReadRow),
      next: rows.length > pageSize && last !== undefined ? last.key : null,
    };
  }

  return {
    capabilities: POLLING_CAPABILITIES,
    // Install and uninstall each run as one transaction where the dialect's DDL is transactional (a
    // failure midway leaves the table exactly as it was, never FacetDB columns without their mark,
    // which every later install would refuse as the application's); elsewhere each column is marked
    // as it is added. `facetdb migrate` runs the engine's plan instead, with the worker login too.
    install() {
      return inTransaction(async (query) => {
        const found = await readTable(dialect, query, target);
        if (found === undefined) {
          throw new Error(
            `install refused: ${labelOf(ref)} does not exist; FacetDB adds columns to a table, it does not create one`,
          );
        }
        // A column the application already owns is never adopted; the question or the column must
        // be renamed. FacetDB's own columns (marked at a previous install) pass.
        if (found.collisions.length > 0) {
          throw new Error(
            `install refused: ${table} already has ${found.collisions
              .map((name) => `"${name}"`)
              .join(", ")}, which FacetDB did not create; rename the question or the column`,
          );
        }
        if (found.project !== undefined && found.project !== target.project.id) {
          throw new Error(
            `install refused: ${labelOf(ref)} is marked as project ${found.project}'s; one table belongs to one project`,
          );
        }
        const present = new Set(found.facts.columns.map((column) => column.name));
        for (const statement of [
          ...columnStatements(dialect, ref, questionSet, present),
          ...markStatements(dialect, ref, target.project.id),
        ]) {
          await query(statement.text);
        }
      });
    },
    async uninstall() {
      await inTransaction(async (query) => {
        // Only the columns that carry FacetDB's mark: a same-named column of the app's survives.
        const found = await readTable(dialect, query, target);
        for (const statement of uninstallStatements(dialect, ref, found?.owned ?? [], undefined)) {
          await query(statement.text);
        }
      });
      // After the commit: a failed uninstall keeps the queue, so a running watch loses nothing.
      waiting.clear();
      claimed.clear();
    },
    watch,
    read,
    write,
    current,
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

/**
 * `items` in runs of at most `size`, each one `in` list: a list never outgrows what the dialect
 * allows (Oracle: 1000), and the statements a driver prepares come in `size` lengths at most.
 */
function inChunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
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
