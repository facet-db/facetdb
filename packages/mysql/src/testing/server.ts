import type { StateValue } from "@facetdb/core";
import type {
  MysqlPool,
  MysqlPoolConnect,
  MysqlPoolOptions,
  MysqlResult,
} from "../connector/index.ts";
import type { MysqlRow } from "../sql/index.ts";
import { mysqlError } from "./recording.ts";

/**
 * A MySQL server as the runtime connector talks to it, in memory: one installed table with a text
 * key, the shared `facetdb_jobs`, and the triggers' effect on an application write. It answers the
 * connector's statements by their shape and records every one, so a unit test asserts what was sent
 * and sees the queue move under the fake clock, with no server; the real servers prove the SQL in
 * `connector.db.test.ts`. Anything it does not recognise is an error, never a silent empty answer.
 */

/** One statement as the pool received it. */
export type PoolSent = {
  readonly text: string;
  readonly params: readonly unknown[] | undefined;
};

/** A job of the fake queue, as `facetdb_jobs` holds it. */
export type FakeJob = {
  readonly tableName: string;
  readonly recordKey: string;
  /** The queue's `enqueued_at`, as an insertion counter. */
  readonly enqueuedAt: number;
  claimedBy: string | null;
  claimedAt: string | null;
  claimToken: string | null;
};

export type FakeServerOptions = {
  /** What `database()` answers; undefined for a connection string naming none. */
  readonly database?: string | undefined;
  /** The installed table's name and key column (its primary key). */
  readonly table: string;
  readonly key?: string;
  /** The state columns, in the order install's `read` names them. */
  readonly state: readonly string[];
  /** The table's `created_at` type (`datetime`), when it has one the worker may read. */
  readonly createdAtType?: string;
  /** Whether the install exists at all: an uninstalled table has no primary key the worker can see. */
  readonly installed?: boolean;
  /** The source's `onChange`: under `reset` the update trigger sets a changed row pending. */
  readonly onChange?: "keep" | "reset";
  /**
   * Whether side-table mode's `facetdb_<table>_answers` is there for the worker: the catalog lists
   * it, so the connector opens in that mode. Its statements are not simulated; a test scripts their
   * failures with `failWhen`.
   */
  readonly sideTable?: boolean;
};

export type FakeServer = {
  readonly connect: MysqlPoolConnect;
  /** Every statement, in the order sent. */
  readonly sent: readonly PoolSent[];
  /** The pool options of each `connect` call. */
  readonly pools: readonly MysqlPoolOptions[];
  /** How many pools were closed. */
  readonly closed: number;
  readonly jobs: FakeJob[];
  /** The table's rows by key: the state columns, FacetDB's columns and `created_at` when set. */
  readonly rows: Map<string, Record<string, unknown>>;
  /** The application's write, with the triggers' effect: queued, and a held claim cleared. */
  edit(key: string, state: Readonly<Record<string, StateValue>>, createdAt?: string | null): void;
  /**
   * Job rows an open application transaction holds: a `for update nowait` naming one fails as the
   * server's does (error 3572). The one-key statements the connector falls back to are answered as
   * if that transaction had committed by then.
   */
  readonly locked: Set<string>;
  /** An error the next statement throws instead of answering (a lost connection), then cleared. */
  failNext: Error | undefined;
  /** An error each statement it returns one for throws instead of answering (a server's refusal). */
  failWhen: ((text: string) => Error | undefined) | undefined;
};

/** The columns of the queue that the trigger's upsert clears. */
function clearClaim(job: FakeJob): void {
  job.claimedBy = null;
  job.claimedAt = null;
  job.claimToken = null;
}

/** `cast(x as char)` of a stored value, as the server prints it: a boolean as 1 or 0. */
function printed(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

export function fakeServer(options: FakeServerOptions): FakeServer {
  const key = options.key ?? "id";
  const installed = options.installed ?? true;
  const sent: PoolSent[] = [];
  const pools: MysqlPoolOptions[] = [];
  let closed = 0;
  let sequence = 0;
  const jobs: FakeJob[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const locked = new Set<string>();
  const jobsOf = (tableName: unknown) => jobs.filter((job) => job.tableName === tableName);
  /** The queue's order: `enqueued_at`, then `record_key`. */
  const inQueueOrder = (a: FakeJob, b: FakeJob): number =>
    a.enqueuedAt === b.enqueuedAt
      ? a.recordKey.localeCompare(b.recordKey)
      : a.enqueuedAt - b.enqueuedAt;

  function enqueue(tableName: string, recordKey: string, clear: boolean): FakeJob {
    const found = jobs.find((job) => job.tableName === tableName && job.recordKey === recordKey);
    if (found !== undefined) {
      if (clear) {
        clearClaim(found);
      }
      return found;
    }
    sequence += 1;
    const job: FakeJob = {
      tableName,
      recordKey,
      enqueuedAt: sequence,
      claimedBy: null,
      claimedAt: null,
      claimToken: null,
    };
    jobs.push(job);
    return job;
  }

  /** A row of the table as the connector's selects alias it. */
  function readRow(recordKey: string, row: Record<string, unknown>, text: string): MysqlRow {
    const out: Record<string, unknown> = { k: recordKey };
    if (text.includes(" as s0") || text.includes(" as x")) {
      options.state.forEach((column, index) => {
        out[`s${index}`] = printed(row[column]);
      });
      out["x"] = row["excluded"] === true ? 1 : 0;
    }
    if (text.includes(" as o,")) {
      out["o"] = printed(row["created_at"]);
    }
    if (text.includes(" as cs")) {
      out["cs"] = row["facetdb_status"] ?? "pending";
      out["cu"] = printed(row["facetdb_updated_at"]);
      out["cr"] = row["facetdb_reviewed"] === true ? 1 : 0;
      for (const match of text.matchAll(
        /cast\(`([^`]+)` as char character set utf8mb4\) as (q\d[vpe])/g,
      )) {
        out[match[2] ?? ""] = printed(row[match[1] ?? ""]);
      }
    }
    return out;
  }

  /** The keys an `in (?)` or `= ?` names: the first array parameter, or the given one. */
  function keysOf(params: readonly unknown[]): string[] {
    const list = params.find((param) => Array.isArray(param));
    if (Array.isArray(list)) {
      return list.map(String);
    }
    // A one-key queue statement: (table_name, claim_token, record_key).
    return params.length === 3 ? [String(params[2])] : [];
  }

  function answer(text: string, params: readonly unknown[]): MysqlResult {
    const none: MysqlResult = { rows: [], affectedRows: 0 };
    const some = (found: readonly MysqlRow[]): MysqlResult => ({ rows: found, affectedRows: 0 });
    const matched = (count: number): MysqlResult => ({ rows: [], affectedRows: count });
    if (text === "select database() as name") {
      return some([{ name: options.database ?? null }]);
    }
    if (text.includes("from information_schema.tables")) {
      const listed =
        params[1] === options.table ||
        (options.sideTable === true && params[1] === `facetdb_${options.table}_answers`);
      return installed && listed ? some([{ type: "BASE TABLE" }]) : none;
    }
    if (text.includes("from information_schema.key_column_usage")) {
      return installed && params[1] === options.table ? some([{ name: key }]) : none;
    }
    if (text.includes("from information_schema.columns")) {
      return options.createdAtType === undefined || params[2] !== "created_at"
        ? none
        : some([{ data_type: options.createdAtType }]);
    }
    // The queue.
    if (text.startsWith("select record_key from") && text.includes("claimed_at is null")) {
      const [tableName, limit] = params;
      const waiting = jobsOf(tableName)
        .filter((job) => job.claimedAt === null)
        .sort(inQueueOrder)
        .slice(0, Number(limit));
      return some(waiting.map((job) => ({ record_key: Buffer.from(job.recordKey, "utf8") })));
    }
    if (text.startsWith("update") && text.includes("set claim_token = ?")) {
      const [token, workerId, now, tableName, expired, limit] = params;
      const claimable = jobsOf(tableName)
        .filter((job) => job.claimedAt === null || job.claimedAt < String(expired))
        .sort(inQueueOrder)
        .slice(0, Number(limit));
      for (const job of claimable) {
        job.claimToken = String(token);
        job.claimedBy = String(workerId);
        job.claimedAt = String(now);
      }
      return matched(claimable.length);
    }
    if (
      text.startsWith("select record_key from") &&
      text.includes("claim_token = ?") &&
      !text.endsWith("for update nowait")
    ) {
      const [tableName, token] = params;
      return some(
        jobsOf(tableName)
          .filter((job) => job.claimToken === token)
          .map((job) => ({ record_key: Buffer.from(job.recordKey, "utf8") })),
      );
    }
    if (text.startsWith("insert into") && text.includes("claim_token) values")) {
      const [tableName, recordKey, workerId, now, token] = params;
      if (jobs.some((job) => job.tableName === tableName && job.recordKey === recordKey)) {
        throw mysqlError(
          1062,
          "ER_DUP_ENTRY",
          `Duplicate entry '${String(tableName)}-${String(recordKey)}' for key 'facetdb_jobs.PRIMARY'`,
        );
      }
      const job = enqueue(String(tableName), String(recordKey), false);
      job.claimedBy = String(workerId);
      job.claimedAt = String(now);
      job.claimToken = String(token);
      return matched(1);
    }
    if (
      text.startsWith("insert into") &&
      text.includes("on duplicate key update table_name = table_name")
    ) {
      const [tableName, recordKey] = params;
      const before = jobs.length;
      enqueue(String(tableName), String(recordKey), false);
      return matched(jobs.length - before);
    }
    if (text === "begin" || text === "commit" || text === "rollback") {
      return none;
    }
    if (text.startsWith("select record_key from") && text.endsWith("for update nowait")) {
      const [tableName, token] = params;
      const keys = keysOf(params);
      const held = keys.find((key) => locked.has(key));
      if (held !== undefined) {
        throw mysqlError(
          3572,
          "ER_LOCK_NOWAIT",
          "Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set.",
        );
      }
      return some(
        jobsOf(tableName)
          .filter((job) => job.claimToken === token && keys.includes(job.recordKey))
          .map((job) => ({ record_key: Buffer.from(job.recordKey, "utf8") })),
      );
    }
    if (text.startsWith("delete from") && text.includes("claim_token = ?")) {
      const [tableName, token] = params;
      const keys = new Set(keysOf(params));
      let count = 0;
      for (let index = jobs.length - 1; index >= 0; index -= 1) {
        const job = jobs[index];
        if (
          job !== undefined &&
          job.tableName === tableName &&
          job.claimToken === token &&
          keys.has(job.recordKey)
        ) {
          jobs.splice(index, 1);
          count += 1;
        }
      }
      return matched(count);
    }
    if (text.startsWith("update") && text.includes("set claimed_at = null")) {
      const [tableName, token] = params;
      const keys = new Set(keysOf(params));
      const held = jobsOf(tableName).filter(
        (job) => job.claimToken === token && keys.has(job.recordKey),
      );
      for (const job of held) {
        clearClaim(job);
      }
      return matched(held.length);
    }
    // The table.
    if (text.startsWith("select") && text.includes(` in (?)`)) {
      const found = keysOf(params).flatMap((recordKey) => {
        const row = rows.get(recordKey);
        return row === undefined ? [] : [readRow(recordKey, row, text)];
      });
      return some(found);
    }
    if (text.startsWith("select") && text.includes(` = ?`) && !text.includes("order by")) {
      const row = rows.get(String(params[0]));
      return row === undefined ? none : some([readRow(String(params[0]), row, text)]);
    }
    if (text.startsWith("update") && text.includes("<=> cast(? as binary)")) {
      const assignments = text.slice(text.indexOf(" set ") + 5, text.indexOf(" where "));
      const columns = [...assignments.matchAll(/`([^`]+)` = \?/g)].map((match) => match[1] ?? "");
      const values = params.slice(0, columns.length);
      const recordKey = String(params[columns.length]);
      const expected = params.slice(columns.length + 1);
      const row = rows.get(recordKey);
      if (row === undefined) {
        return matched(0);
      }
      const same = options.state.every(
        (column, index) => printed(row[column]) === (expected[index] ?? null),
      );
      if (!same) {
        return matched(0);
      }
      columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return matched(1);
    }
    if (text.startsWith("select") && text.includes("order by")) {
      const byCreation = text.includes(" as o,");
      const limit = Number(params.at(-1));
      let candidates = [...rows.entries()];
      if (text.includes(" where ")) {
        if (!byCreation) {
          const after = String(params[0]);
          candidates = candidates.filter(([recordKey]) => recordKey < after);
        } else if (text.includes("is null and")) {
          const after = String(params[0]);
          candidates = candidates.filter(
            ([recordKey, row]) => row["created_at"] === null && recordKey < after,
          );
        } else {
          const [created, , after] = params.map(String);
          candidates = candidates.filter(
            ([recordKey, row]) =>
              row["created_at"] === null ||
              String(row["created_at"]) < String(created) ||
              (String(row["created_at"]) === String(created) && recordKey < String(after)),
          );
        }
      }
      candidates.sort(([ka, a], [kb, b]) => {
        if (byCreation) {
          const ca = a["created_at"] === null ? "" : String(a["created_at"]);
          const cb = b["created_at"] === null ? "" : String(b["created_at"]);
          if (ca !== cb) {
            return ca < cb ? 1 : -1;
          }
        }
        return ka < kb ? 1 : ka > kb ? -1 : 0;
      });
      return some(
        candidates.slice(0, limit).map(([recordKey, row]) => readRow(recordKey, row, text)),
      );
    }
    throw new Error(`the fake server has no answer for: ${text}`);
  }

  const query: MysqlPool["query"] = async (text, params) => {
    sent.push({ text, params });
    const failure = server.failNext;
    if (failure !== undefined) {
      server.failNext = undefined;
      throw failure;
    }
    const refused = server.failWhen?.(text);
    if (refused !== undefined) {
      throw refused;
    }
    return answer(text, params ?? []);
  };
  const connect: MysqlPoolConnect = (_url, poolOptions) => {
    pools.push(poolOptions);
    const pool: MysqlPool = {
      query,
      // A transaction is its statements in order, `begin` and `commit` recorded like the real
      // pool's; the fake has no isolation to roll back, since a probe fails before anything is written.
      transaction: async (work) => {
        await query("begin");
        try {
          const result = await work(query);
          await query("commit");
          return result;
        } catch (error) {
          await query("rollback");
          throw error;
        }
      },
      close: async () => {
        closed += 1;
      },
    };
    return pool;
  };

  const server: FakeServer = {
    connect,
    sent,
    pools,
    get closed() {
      return closed;
    },
    jobs,
    rows,
    locked,
    failNext: undefined,
    failWhen: undefined,
    edit(recordKey, state, createdAt) {
      const row = rows.get(recordKey);
      if (row === undefined) {
        rows.set(recordKey, {
          ...state,
          created_at: createdAt ?? null,
          facetdb_status: "pending",
          facetdb_updated_at: null,
          facetdb_reviewed: false,
        });
        enqueue(options.table, recordKey, false);
        return;
      }
      const changed = options.state.some(
        (column) => (row[column] ?? null) !== (state[column] ?? null),
      );
      Object.assign(row, state);
      if (changed) {
        if (options.onChange === "reset") {
          row["facetdb_status"] = "pending";
        }
        enqueue(options.table, recordKey, true);
      }
    },
  };
  return server;
}
