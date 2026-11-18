import { createHash } from "node:crypto";
import {
  type Clock,
  type CursorStore,
  type EngineTarget,
  type ReadRow,
  type RecordKey,
  STATE_HASH_COLUMN,
  STATUS_COLUMN,
} from "@facetdb/core";
import {
  type CatalogColumn,
  columnType,
  keyText,
  QUEUE_KEY_COLLATION,
  QUEUE_KEY_LENGTH,
  readMark,
  type TableNames,
  versionText,
} from "../install/index.ts";
import { type MssqlClient, type MssqlRow, quoteName, quoteString } from "../sql/index.ts";

/**
 * The worker's half of Change Tracking as the capture. With no trigger on the table, the
 * connector's `watch` fills the queue itself before it announces it: every poll reads the
 * database's current version first, then `changetable(changes <table>, @since)`, keeps the inserts
 * and the updates whose changed columns include a state column
 * (`change_tracking_is_column_in_mask`; a NULL mask names no column, so it counts as a change of
 * every one), sets those rows pending and queues them in one transaction, and only then stores the
 * version it read first in the FacetDB store's cursors under `ct:<project>:<source>`: a crash in
 * between reads the same changes again, at least once, and the queue's key makes a key queued twice
 * one job. A change committed between the version's read and the changes' is not lost: its version
 * is greater, so the next poll reads it. What the pages cannot see is a cleanup that ran between
 * the oldest-valid-version check and them, so that version is read again after the pages and a move
 * past `since` reconciles. A row an application transaction holds is read past and the version not
 * stored, so the next poll reads the same changes again; a deadlock or lock timeout the poll meets
 * is retried the same way. An uncommitted change holds its row of the table's change tracking too,
 * and `changetable` waits for that commit: a wait that holds no lock of the table's rows, so no
 * application write waits behind it. The worker's own writes set FacetDB's columns only, never a
 * state column, so they never queue a row.
 *
 * A row is queued only when the hash of its state differs from `facetdb_state_hash`, the hash
 * `write` stores with each decision, or it has none: the poll runs after the application's commit,
 * not inside it as a trigger does, so a worker may have read and answered the new state already;
 * the comparison, under an update lock in the queuing transaction, keeps that state from being
 * asked twice. A queued key's job, if it is there and claimed, has its claim cleared, as the
 * trigger clears it: the worker that claimed it at an older state then acks nothing by its token,
 * and the job stays for the new state (a worker that read the old state is refused by the hash
 * guard at its write and releases the job, by the worker's rule, either way). A claim is cleared
 * only at the poller's first sight of that change (the key at that state hash): a poll that reads
 * the same changes again (its version held back by a held row or a retry) leaves a claim taken
 * since alone, or a worker would be handed a record it already has in flight.
 *
 * One process polls a source: the one whose session holds the application lock
 * `facetdb:ct:<schema>.<table>` (`sp_getapplock`, owned by the session, on a connection of its own
 * kept for the watch's life; application locks belong to the database, so the name needs no
 * database). The others' `watch` announces what the queue holds, as every worker does, and asks for
 * the lock again each tick, so one takes over within a tick when the poller stops (its session, and
 * so its lock, ends with it). Two pollers would read the same changes and clear each other's claims.
 *
 * Retention is the risk: the database keeps changes for its retention (two days at least, install
 * refuses less), and a stored version older than `change_tracking_min_valid_version` means the
 * changes since are gone. That is never skipped quietly: a warning line says what was lost, then
 * one pass over every row queues each whose state hash differs from the stored one or that has
 * none, then the poll goes on from the version read before that pass. A first start, with no stored
 * version, follows changes from the version FacetDB's install marked on the table, so nothing
 * changed between the install and the worker's start is missed; the same pass runs when that
 * version is gone too. A deleted row queues nothing: a job it still had reads as missing, which the
 * worker drops, and its decision log stays.
 */

/** Keys of changes, and rows of a reconcile, per page. */
const PAGE = 1_000;

/** Keys per queuing statement: three parameters each, under the 2,100 of one request. */
const QUEUE_CHUNK = 500;

/**
 * The most changes the poller remembers as seen (key and state hash) while its version is
 * held back; the oldest are forgotten first, and every entry once the version moves past it.
 */
const SEEN_LIMIT = 100_000;

/** The application lock of a source's poller: at most 255 characters, as `sp_getapplock` takes it. */
export function pollerLock(names: Pick<TableNames, "schema" | "table">): string {
  const name = `facetdb:ct:${names.schema}.${names.table}`;
  return name.length <= 255
    ? name
    : `facetdb:ct:${createHash("sha256").update(`${names.schema}.${names.table}`).digest("hex")}`;
}

/**
 * Holds the poller's lock, or takes it when it is free: the session's lock already held answers
 * at once, else `sp_getapplock` with no wait (0 granted, below 0 not).
 */
export const POLLER_LOCK = `declare @result int;
if applock_mode(N'public', @p1, N'Session') = N'Exclusive'
  set @result = 0;
else
  exec @result = sp_getapplock @Resource = @p1, @LockMode = N'Exclusive', @LockOwner = N'Session', @LockTimeout = 0;
select cast(case when @result >= 0 then 1 else 0 end as int) as held;`;

/**
 * How often the version is stored when the poll queued nothing: the database's version moves with
 * every table's changes, and a version a minute behind costs only a re-read of a minute's changes.
 */
export const VERSION_SAVE_MS = 60_000;

/** Where a source's version is stored in the store's cursors, by `<project>:<source>`. */
export function versionRun(target: Pick<EngineTarget, "project" | "source">): string {
  return `ct:${target.project.id}:${target.source}`;
}

/** The cursors of a connector made without the store's: `watch` with this capture refuses in words. */
export const NO_CURSORS: CursorStore = {
  load: () => Promise.reject(noCursors()),
  save: () => Promise.reject(noCursors()),
};

function noCursors(): Error {
  return new Error(
    'this SQL Server connector was made without the store\'s cursors, where capture: "change-tracking" keeps the version it has read up to: the composition root passes them (createMssqlEngine({ cursors }))',
  );
}

/** Where a line of the worker's goes when the composition root names no place: stderr, as it is. */
export function noteOnStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Where a warning goes when the composition root names no place: the process's stderr. */
export function warnOnStderr(line: string): void {
  process.stderr.write(`warning: ${line}\n`);
}

export type TrackedCaptureDeps = {
  readonly pool: MssqlClient;
  /**
   * One connection of its own, kept for the watch's life: its session holds the poller's lock.
   * A pool of one, so every statement runs in the same session while it lives.
   */
  readonly lockSession: MssqlClient;
  /** Where the line that says whether this process polls goes (not a warning). */
  readonly note: (line: string) => void;
  readonly target: EngineTarget;
  readonly names: TableNames;
  readonly key: CatalogColumn;
  /** The select list `read` reads a row with (`k`, `s0…`, `x`), aliased `t`. */
  readonly rowColumns: string;
  readonly parseRow: (row: MssqlRow) => ReadRow;
  readonly cursors: CursorStore;
  readonly warn: (line: string) => void;
  readonly clock: Clock;
};

export type TrackedCapture = {
  /**
   * One tick: the poller's lock held or taken, then, by the process that holds it, the changes
   * since the stored version queued and the version stored; nothing more by any other.
   */
  poll(): Promise<void>;
  /** Whether this process held the poller's lock at its last tick. */
  polling(): boolean;
};

/** A version as SQL Server compares it: a `bigint`, beyond a JavaScript number. */
function asNumber(version: string): bigint {
  return BigInt(version);
}

export function createTrackedCapture(deps: TrackedCaptureDeps): TrackedCapture {
  const {
    pool,
    lockSession,
    note,
    target,
    names,
    key,
    rowColumns,
    parseRow,
    cursors,
    warn,
    clock,
  } = deps;
  const run = versionRun(target);
  const lock = pollerLock(names);
  const table = names.relation;
  const label = names.label;
  const id = quoteName(key.name);
  const keyType = columnType(key);
  const status = quoteName(STATUS_COLUMN);
  const hash = quoteName(STATE_HASH_COLUMN);
  /** The row's key as the queue's text, read off `changetable`. */
  const changedKey = keyText("ct", key);
  const rowKey = keyText("t", key);
  /**
   * A queued key, in the queue's code-point collation, as the key's own type: a text key takes its
   * column's collation back, or the comparison with the column is a conflict of two (error 468).
   */
  const queuedKey = `try_convert(${keyType}, q.[k])${key.collation === null ? "" : ` collate ${key.collation}`}`;
  // Each state column's id, looked up by the server: a mask holds column ids, not names.
  const stateChanged = target.questionSet.read
    .map(
      (column) =>
        `change_tracking_is_column_in_mask(columnproperty(object_id(${quoteString(table)}, N'U'), ${quoteString(column)}, 'ColumnId'), ct.sys_change_columns) = 1`,
    )
    .join(" or ");
  // `onChange: "keep"` sets pending only a row that has no status yet (the trigger's rule).
  const unsettled =
    target.onChange === "reset"
      ? `t.${status} is null or t.${status} <> 'pending'`
      : `t.${status} is null`;

  /** The version read before anything else, and the oldest the table's changes still reach. */
  async function versions(): Promise<{ readonly now: string; readonly min: string }> {
    const [row] = await pool.query(
      "select convert(nvarchar(20), change_tracking_current_version()) as now, convert(nvarchar(20), change_tracking_min_valid_version(object_id(@p1, N'U'))) as min",
      [table],
    );
    if (row === undefined || row["now"] === null || row["min"] === null) {
      throw new Error(
        `${target.source}: Change Tracking is off for ${label}, or the worker login may not read it (view change tracking), so no change of the table reaches the queue; run facetdb doctor, which says which, then facetdb migrate`,
      );
    }
    return {
      now: versionText(row["now"], "change_tracking_current_version()"),
      min: versionText(row["min"], "change_tracking_min_valid_version()"),
    };
  }

  /**
   * Queues the keys whose stored hash differs from `hashes` (the state as just read), or that have
   * none, sets them pending, and clears the claim of a job already there, in one transaction (the
   * trigger's three steps): a worker that claimed the key at an older state and wrote its answer
   * then finds its ack matching no token, so the job stays and the next claim reads the new state
   * (the worker's already-answered check keeps a state it answered from being asked twice). The
   * update lock on the rows holds off a worker's write until the job is in, so a decision written
   * meanwhile is compared, not overrun.
   *
   * With `skipHeld`, a row an open application transaction holds is read past (`readpast`), not
   * waited on while the others' locks are held (which would stall the application's other writes
   * behind the poll, and lose a deadlock at `deadlock_priority low`); the count of such rows comes
   * back, and the poll reads from the same version again rather than store past them. Without it
   * (the reconcile, which reads no version to come back to) the statement waits. The status update
   * reads past too: the rows it sets are this transaction's own, which `readpast` never passes, and
   * any other row its plan meets (a scan, through the converted key) is passed, not waited on.
   *
   * A row's `clear` says whether its job's claim may be cleared: only at the poller's first sight
   * of that change, so a re-read never takes a claim a worker took since.
   */
  async function queue(
    rows: readonly { readonly key: RecordKey; readonly hash: string; readonly clear: boolean }[],
    skipHeld: boolean,
  ): Promise<ReadonlySet<RecordKey>> {
    const skipped = new Set<RecordKey>();
    for (let from = 0; from < rows.length; from += QUEUE_CHUNK) {
      const part = rows.slice(from, from + QUEUE_CHUNK);
      const values = part
        .map((_, index) => `(@p${3 * index + 2}, @p${3 * index + 3}, @p${3 * index + 4})`)
        .join(", ");
      const locks = skipHeld ? "updlock, rowlock, readpast" : "updlock, rowlock";
      const result = await pool.transaction((query) =>
        query(
          `declare @seen table ([k] nvarchar(${QUEUE_KEY_LENGTH}) collate ${QUEUE_KEY_COLLATION} primary key, [moved] bit not null, [clear] bit not null);
insert into @seen ([k], [moved], [clear])
select distinct v.[k], cast(case when t.${hash} is null or t.${hash} <> v.[h] then 1 else 0 end as bit), cast(v.[c] as bit)
  from (values ${values}) v ([k], [h], [c])
  join ${table} t with (${locks}) on t.${id} = try_convert(${keyType}, v.[k]) and ${rowKey} = v.[k];
update t set ${status} = 'pending'
  from ${table} t with (rowlock, readpast)
  join @seen q on t.${id} = ${queuedKey}
 where q.[moved] = 1 and (${unsettled});
update j set [claimed_by] = null, [claimed_at] = null, [claim_token] = null
  from ${names.jobsRelation} j
  join @seen q on j.[table_name] = @p1 and j.[record_key] = q.[k]
 where q.[moved] = 1 and q.[clear] = 1 and j.[claim_token] is not null;
insert into ${names.jobsRelation} ([table_name], [record_key])
select @p1, q.[k]
  from @seen q
 where q.[moved] = 1
   and not exists (select 1 from ${names.jobsRelation} j where j.[table_name] = @p1 and j.[record_key] = q.[k]);
select v.[k] as skipped
  from (values ${values}) v ([k], [h], [c])
 where not exists (select 1 from @seen s where s.[k] = v.[k]);`,
          [table, ...part.flatMap((row) => [row.key, row.hash, row.clear])],
        ),
      );
      for (const row of result) {
        if ("skipped" in row) {
          skipped.add(String(row["skipped"]));
        }
      }
    }
    return skipped;
  }

  /**
   * The rows of `keys` as they are now, with their state hashes; a deleted one is not among them,
   * nor one an open application transaction holds, which is read past (a locking read, so under
   * READ_COMMITTED_SNAPSHOT too) rather than waited on: the poll counts it as left for later.
   */
  async function statesOf(
    keys: readonly RecordKey[],
  ): Promise<readonly { readonly key: RecordKey; readonly hash: string }[]> {
    const out: { key: RecordKey; hash: string }[] = [];
    for (let from = 0; from < keys.length; from += QUEUE_CHUNK) {
      const part = keys.slice(from, from + QUEUE_CHUNK);
      const rows = await pool.query(
        `select ${rowColumns} from ${table} t with (readcommittedlock, readpast) where t.${id} in (${part.map((_, index) => `try_convert(${keyType}, @p${index + 1})`).join(", ")})`,
        part,
      );
      for (const row of rows) {
        const read = parseRow(row);
        out.push({ key: read.key, hash: read.hash });
      }
    }
    return out;
  }

  /** The keys of the inserts and the state updates since `since`, a page after `after`. */
  async function changedKeys(since: string, after: RecordKey | undefined) {
    const rows = await pool.query(
      `declare @since bigint = convert(bigint, @p1);
select top (@p2) ${changedKey} as k, convert(nvarchar(20), ct.sys_change_version) as v
  from changetable(changes ${table}, @since) ct
 where ct.sys_change_operation <> N'D'
   and (ct.sys_change_operation = N'I' or ct.sys_change_columns is null or ${stateChanged})${after === undefined ? "" : `\n   and ct.${id} > try_convert(${keyType}, @p3)`}
 order by ct.${id}`,
      after === undefined ? [since, PAGE] : [since, PAGE, after],
    );
    return rows.map((row) => {
      const value = row["k"];
      if (typeof value !== "string") {
        throw new Error(`a change's key came back as ${typeof value}, expected text`);
      }
      return { key: value, version: versionText(row["v"], "a change's sys_change_version") };
    });
  }

  let lastSaved: { readonly version: string; readonly at: number } | undefined;
  async function save(version: string, queued: boolean): Promise<void> {
    if (version === lastSaved?.version) {
      return;
    }
    if (!queued && lastSaved !== undefined && clock.now() - lastSaved.at < VERSION_SAVE_MS) {
      return;
    }
    await cursors.save(run, { cursor: version, done: false });
    lastSaved = { version, at: clock.now() };
  }

  /**
   * The lost-version pass: the warning, the version read first, then every row once, queuing those
   * whose state moved since their last answer or that have none; the poll goes on from that version.
   */
  async function reconcile(why: string): Promise<string> {
    const { now } = await versions();
    warn(
      `${target.source}: ${why}. FacetDB reads every row of ${label} once and queues each whose state changed since its last answer, or that has none, then follows changes again from version ${now}`,
    );
    let after: RecordKey | undefined;
    for (;;) {
      const rows = await pool.query(
        `select top (@p1) ${rowColumns}, t.${hash} as h from ${table} t${after === undefined ? "" : ` where t.${id} > try_convert(${keyType}, @p2)`} order by t.${id}`,
        after === undefined ? [PAGE] : [PAGE, after],
      );
      const moved = rows.flatMap((row) => {
        const read = parseRow(row);
        // No change version to tell a first sight by: the claim is cleared, at least once.
        return row["h"] === read.hash ? [] : [{ key: read.key, hash: read.hash, clear: true }];
      });
      await queue(moved, false);
      const last = rows.at(-1);
      if (rows.length < PAGE || last === undefined) {
        break;
      }
      after = parseRow(last).key;
    }
    await save(now, true);
    advance(now);
    return now;
  }

  /** Where the first poll starts: the stored version, or the install's mark on a first start. */
  async function opening(): Promise<{ readonly since: string; readonly first: boolean } | string> {
    const saved = await cursors.load(run);
    if (saved !== undefined && saved.cursor !== null) {
      return /^\d+$/.test(saved.cursor)
        ? { since: saved.cursor, first: false }
        : `the version stored for ${label} under ${run}, "${saved.cursor}", is not a Change Tracking version, so FacetDB cannot tell which changes it has read`;
    }
    const mark = await readMark(pool.query, names);
    if (mark === undefined) {
      throw new Error(
        `${target.source}: ${label} carries no mark of FacetDB's Change Tracking install, so there is no version to start following its changes from; run facetdb migrate with capture: "change-tracking", then start the worker again`,
      );
    }
    return { since: mark.since, first: true };
  }

  let since: string | undefined;
  /** One pass at a time: `watch` and a caller driving the poll itself share `since`. */
  let running: Promise<void> = Promise.resolve();
  /**
   * The changes this poller has seen and acted on, by key: the state hash it queued the key at, and
   * the change's `sys_change_version`. A claim is cleared at the first sight of a state only. The
   * hash decides, not the version: the poller's own pending update, and any write of FacetDB's
   * columns, moves the row's change version on, so a re-read would read as a new sight by it, where
   * the state is the one already queued (the db suite caught it). The version says when an entry can
   * go (once `since` passes it). The newest last; the oldest go past the bound.
   */
  const seen = new Map<RecordKey, { readonly hash: string; readonly version: string }>();
  function see(changed: RecordKey, hash: string, version: string): void {
    seen.delete(changed);
    seen.set(changed, { hash, version });
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.keys().next();
      if (oldest.done !== true) {
        seen.delete(oldest.value);
      }
    }
  }

  async function once(): Promise<void> {
    if (since === undefined) {
      const start = await opening();
      if (typeof start === "string") {
        since = await reconcile(start);
        return;
      }
      const { min } = await versions();
      if (asNumber(start.since) < asNumber(min)) {
        since = await reconcile(
          start.first
            ? `the changes of ${label} since FacetDB's install (version ${start.since}) are gone: the database keeps them for its retention, and the oldest it still has is version ${min}`
            : `the changes of ${label} since version ${start.since}, where the worker stopped, are gone: the database keeps them for its retention, and the oldest it still has is version ${min}; the worker was stopped longer than that`,
        );
        return;
      }
      since = start.since;
    }
    const { now, min } = await versions();
    if (asNumber(since) < asNumber(min)) {
      since = await reconcile(
        `the changes of ${label} since version ${since} are gone while the worker ran: the database keeps them for its retention, and the oldest it still has is version ${min}`,
      );
      return;
    }
    if (asNumber(since) > asNumber(now)) {
      since = await reconcile(
        `the version stored for ${label}, ${since}, is ahead of the database's own, ${now} (a database restored from a backup, or its tracking turned off and on), so the changes since cannot be read`,
      );
      return;
    }
    if (now === since) {
      return;
    }
    let queued = false;
    let skipped = 0;
    let after: RecordKey | undefined;
    for (;;) {
      const changes = await changedKeys(since, after);
      if (changes.length > 0) {
        const versionOf = new Map(changes.map((change) => [change.key, change.version]));
        const rows = (await statesOf(changes.map((change) => change.key))).map((row) => ({
          ...row,
          version: versionOf.get(row.key) ?? "",
          clear: seen.get(row.key)?.hash !== row.hash,
        }));
        const held = await queue(rows, true);
        // A key with no row read was held (or deleted since, which the next poll reads as such).
        skipped += changes.length - rows.length + held.size;
        for (const row of rows) {
          if (!held.has(row.key)) {
            see(row.key, row.hash, row.version);
          }
        }
        queued = queued || rows.length > 0;
      }
      const last = changes.at(-1);
      if (changes.length < PAGE || last === undefined) {
        break;
      }
      after = last.key;
    }
    // A cleanup between the first check and the pages may have taken changes past `since` with
    // it: the pages could not tell, so the oldest valid version is read again after them.
    const { min: still } = await versions();
    if (asNumber(since) < asNumber(still)) {
      since = await reconcile(
        `the changes of ${label} since version ${since} were cleaned up while the worker read them: the oldest the database still has is version ${still}`,
      );
      return;
    }
    // A row an application transaction held was left: the next poll reads from the same version.
    if (skipped > 0) {
      return;
    }
    // Saved at once after a poll that queued or cleared anything, so a poller that takes over
    // re-reads only what a crash between the queue and the save left (at least once).
    await save(now, queued);
    advance(now);
  }

  /** Moves `since` on, and forgets the changes seen at or below it: no poll reads them again. */
  function advance(version: string): void {
    since = version;
    for (const [key, at] of seen) {
      if (asNumber(at.version) <= asNumber(version)) {
        seen.delete(key);
      }
    }
  }

  /** Whether this process's session holds the poller's lock, taking it when free; said once a change. */
  let polling: boolean | undefined;
  async function holdLock(): Promise<boolean> {
    const [row] = await lockSession.query(POLLER_LOCK, [lock]);
    const held = row?.["held"] === 1;
    if (held && polling !== true) {
      // A poller starts from what the store holds, whatever it read before it lost the lock.
      since = undefined;
      seen.clear();
      note(
        polling === false
          ? `${target.source}: this worker takes over polling Change Tracking for ${label}: the worker that polled it stopped`
          : `${target.source}: this worker polls Change Tracking for ${label}`,
      );
    } else if (!held && polling !== false) {
      note(
        `${target.source}: claiming only: another worker polls Change Tracking for ${label}; this one takes over if it stops`,
      );
    }
    polling = held;
    return held;
  }

  /** One tick: the changes, when this process polls; nothing else otherwise. */
  async function tick(): Promise<void> {
    if (await holdLock()) {
      await once();
    }
  }

  return {
    poll() {
      const turn = running.then(tick).catch((error: unknown) => {
        // A deadlock the poll lost (it runs at deadlock_priority low) or a lock it gave up on rolls
        // its transaction back and leaves `since` where it was: the next tick reads the same
        // changes again, so nothing is lost and the watch goes on.
        if (RETRIED.has(errorNumber(error) ?? 0)) {
          return;
        }
        throw error;
      });
      running = turn.catch(() => undefined);
      return turn;
    },
    polling: () => polling === true,
  };
}

/** A deadlock victim (1205) and a lock timeout (1222): the poll is tried again on the next tick. */
const RETRIED: ReadonlySet<number> = new Set([1205, 1222]);

/** The server's error number on a driver's error (a boundary), when it has one. */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("number" in error)) {
    return undefined;
  }
  return typeof error.number === "number" ? error.number : undefined;
}
