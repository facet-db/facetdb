import { randomUUID } from "node:crypto";
import {
  answerColumns,
  type Capabilities,
  type Clock,
  type CurrentDecision,
  type CursorStore,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  parseCurrent,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  type Refusal,
  type ScanCursor,
  type ScanPage,
  stateHash,
  type WriteResult,
} from "@facetdb/core";
import { BSON, Double, Int32, Long, ObjectId, Timestamp } from "mongodb";
import {
  belowFloor,
  driverFloor,
  JOB_COLLECTION_FIELD,
  JOBS_COLLECTION,
  META_COLLECTION,
  markerId,
  type Sent,
  type ServerDocument,
  SUBDOCUMENT,
  serverCode,
  WORKER_USER,
} from "../install/index.ts";
import { databaseOf, plainMessage, subjectOf, tlsVerdict, urlProblem } from "../urls/index.ts";
import {
  type ChangeFeed,
  connectWorker,
  type FeedStart,
  type WorkerClient,
  type WorkerConnect,
} from "./client.ts";
import { idOf, keyOf, stateOf, stateProjection } from "./keys.ts";
import { changePipeline, ENDING } from "./pipeline.ts";

/**
 * The MongoDB runtime connector. A collection has no trigger, so the queue is filled by `watch`
 * itself: it follows the collection's change stream (one per collection: the worker's role is per
 * collection), and for every change that touches a state field it queues the key in the database's
 * one `facetdb_jobs`, `{ collection, record_key }` unique, then hands the batch to the worker, then
 * stores the stream's resume token in the FacetDB store's cursors (the store keeps every cursor),
 * under `mongo:<project>:<source>`. A crash between the queue and the token replays the batch: at
 * least once, and the unique index makes a replayed key the same one job.
 *
 * The oplog is a window. A token it no longer holds (`ChangeStreamHistoryLost`), or one the server
 * cannot read, is never skipped past quietly: a warning line, then one pass over every document
 * queuing each whose stored `facetdb.state_hash` differs from the hash of its state now, or that
 * has none, then a new stream from a cluster time taken before that pass, so nothing changed during
 * it is missed either. The same pass runs on the first start when the oplog no longer reaches back
 * to the install.
 *
 * Claims are MongoDB's atomic find-and-update: one job at a time, stamped with this worker, the
 * clock's time and a claim token; `ack` and `release` settle by the token, which the change path
 * clears with the claim, so a batch read before a change can never delete the job that change
 * queued. Only a change takes a claim away: `enqueue` (a backfill) and `claimKey` keep a held one,
 * as the SQL engines do. `write` reads the state and sets the `facetdb` fields in one transaction,
 * which a concurrent application write turns into a conflict the driver runs again, so a decision
 * lands only on the state it was asked about. Every field the worker writes is under `facetdb`
 * (`ownedFields`), which the pipeline never keeps.
 */

/** Longer than the 10-minute retry window, as on Postgres and MySQL. */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** How long a change stream's `getMore` waits on the server: a change arrives as it happens. */
export const AWAIT_MS = 1_000;

/**
 * How often an idle stream stores its high-water mark, so a collection that changes rarely keeps a
 * token inside the oplog window and a restart resumes instead of reconciling.
 */
export const TOKEN_REFRESH_MS = 60_000;

/** What MongoDB can do: the subdocument, change streams, transactions. */
export const MONGO_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: true,
  transactions: true,
  sideTable: false,
  multipleWorkers: true,
};

/** Changes handed to the worker per batch. */
const WATCH_BATCH = 200;

/** Documents per `scan` page, as on the SQL engines. */
const SCAN_PAGE_SIZE = 500;

/** Keys per `$in`. */
const IN_LIST = 1_000;

/** The `_id` types a key has (keys.ts), and the numeric ones a number key brackets with. */
const NUMBER_TYPES = ["int", "long", "double"];
const KEY_TYPES = ["objectId", "string", ...NUMBER_TYPES];

/** `DocumentValidationFailure`: the collection's validator refused FacetDB's fields. */
const VALIDATION_FAILED = 121;

/**
 * The server refusing to start a stream after a stored token: the oplog no longer holds it
 * (`ChangeStreamHistoryLost` 286, `ChangeStreamFatalError` 280, 40576 before 4.2's codes), or the
 * token is not one (`InvalidResumeToken` 260, `BadValue` 2, `FailedToParse` 9, `Overflow` 15,
 * `InvalidBSON` 22, and the parser's 40647 and 50811). Read only on the stream's first batch, where
 * the token is all that differs from a stream that starts now.
 */
const TOKEN_REFUSED: ReadonlySet<number> = new Set([
  286, 280, 40576, 260, 2, 9, 15, 22, 40647, 50811,
]);

/** The history the oplog no longer holds: the first start's install time, past the window. */
const HISTORY_LOST: ReadonlySet<number> = new Set([286, 280]);

export type MongoConnectorDeps = {
  readonly clock: Clock;
  /** The store's cursors: where the resume token survives a restart. */
  readonly cursors: CursorStore;
  /** The operator's `--allow-insecure`, for the TLS rule of the worker's connection string. */
  readonly allowInsecure: boolean;
  /** Where the connector says what no return value can: a lost token, a document it cannot key. */
  readonly warn: (line: string) => void;
  /** Names this worker's claims; a fresh id when absent. */
  readonly workerId?: string;
  /** Opens the worker's connection: the mongodb driver by default, a test passes its own. */
  readonly connect?: WorkerConnect;
  /** The most connections the driver's pool opens at once. */
  readonly maxConnections?: number;
  /** Documents per `scan` page; 500 by default, a test pages smaller to cross page boundaries. */
  readonly scanPageSize?: number;
  /**
   * `facetdb migrate` and `facetdb uninstall` for `Connector.install` and `uninstall`; without it
   * both reject: the CLI installs through the engine's plans, shown before they run.
   */
  readonly installer?: {
    install(): Promise<void>;
    uninstall(): Promise<void>;
  };
};

export type MongoConnector = OpenConnector & {
  readonly workerId: string;
};

/** Where a source's resume token is stored in the store's cursors, by `<project>:<name>`. */
export function tokenRun(target: Pick<EngineTarget, "project" | "source">): string {
  return `mongo:${target.project.id}:${target.source}`;
}

/**
 * The worker login's connection string's refusal, before `open` or `doctor` connects (and
 * `checkUrl`'s), under the code the SQL engines give it.
 */
export function workerUrlRefusal(
  url: string,
  allowInsecure: boolean,
  subject: string,
): Refusal | undefined {
  const problem = urlProblem(url, subject, allowInsecure);
  return problem === undefined
    ? undefined
    : {
        code: "database-url-tls",
        message: `${problem.problem}; no connection was made`,
        fix: problem.fix,
      };
}

/** A claim token: 32 hex characters, unique across every worker. */
function claimToken(): string {
  return randomUUID().replaceAll("-", "");
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let from = 0; from < items.length; from += size) {
    out.push(items.slice(from, from + size));
  }
  return out;
}

const isRecord = (value: unknown): value is ServerDocument =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A document's `facetdb` subdocument, or an empty one where it has none. */
function subdocumentOf(document: ServerDocument): ServerDocument {
  const sub = document[SUBDOCUMENT];
  return isRecord(sub) ? sub : {};
}

/** An `_id` in words for a warning: its type and value, never more than a line. */
function describeId(id: unknown): string {
  const type =
    typeof id === "object" && id !== null
      ? String(Reflect.get(id, "_bsontype") ?? (id instanceof Date ? "Date" : "document"))
      : typeof id;
  let text: string;
  try {
    text = id instanceof Date ? id.toISOString() : JSON.stringify(id);
  } catch {
    text = String(id);
  }
  return `${text.length > 80 ? `${text.slice(0, 77)}...` : text} (a ${type})`;
}

/**
 * BSON values as text and back, exactly: canonical Extended JSON keeps a Binary a Binary and a
 * Long a Long, where `JSON.stringify` would turn a resume token's `_typeBits` (a Binary, present
 * for a Long, double or Decimal `_id`) into a base64 string the server cannot resume from.
 */
const CANONICAL = { relaxed: false } as const;
const { EJSON } = BSON;

/** A resume token or a scan position as stored text. */
export function storedText(value: unknown): string {
  return EJSON.stringify(value, CANONICAL);
}

/** Stored text read back, or undefined when it is not Extended JSON. */
export function storedValue(text: string): unknown {
  try {
    return EJSON.parse(text, CANONICAL);
  } catch {
    return undefined;
  }
}

/** Where a page starts after: the last `_id` read, of a type the pages select. */
type After = ObjectId | string | number | Long | Int32 | Double;

/**
 * A scan cursor: the last document's raw `_id` in canonical Extended JSON, whether or not it has a
 * key, so a page ending on a document left out (a double past 2^53, NaN) still leads to the next.
 */
function cursorOf(id: After): ScanCursor {
  // A plain number as a Double: Extended JSON would write an integral one past 2^31 as a Long of
  // its printed digits (2^60 as ...847000, not ...846976), and the next page would read it again.
  return storedText({ after: typeof id === "number" ? new Double(id) : id });
}

function isAfter(value: unknown): value is After {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof ObjectId ||
    value instanceof Long ||
    value instanceof Int32 ||
    value instanceof Double
  );
}

/** A cursor is a boundary: it may come from a saved backfill. */
function parseCursor(cursor: ScanCursor): After {
  const parsed = storedValue(cursor);
  const after = isRecord(parsed) ? parsed["after"] : undefined;
  if (!isAfter(after)) {
    throw new Error(`"${cursor}" is not a scan cursor of a MongoDB source`);
  }
  return after;
}

/**
 * The documents after `after` in `_id` descending order, MongoDB's order across types (an ObjectId
 * above a string above a number): a range compares within one type only, so each lower type is a
 * branch of its own, and the planner merges the branches along the `_id` index.
 */
function afterFilter(after: After | undefined): Sent {
  if (after === undefined) {
    return { _id: { $type: KEY_TYPES } };
  }
  if (after instanceof ObjectId) {
    return {
      $or: [
        { _id: { $lt: after } },
        { _id: { $type: "string" } },
        { _id: { $type: NUMBER_TYPES } },
      ],
    };
  }
  if (typeof after === "string") {
    return { $or: [{ _id: { $lt: after, $type: "string" } }, { _id: { $type: NUMBER_TYPES } }] };
  }
  return { _id: { $lt: after, $type: NUMBER_TYPES } };
}

/** What `watch` resumes from, decided once at its start. */
type Opening =
  | { readonly kind: "token"; readonly token: Sent }
  | { readonly kind: "install"; readonly since: Date }
  | { readonly kind: "unreadable"; readonly why: string };

/** How a stream began, so a refusal of its first batch is read as what it is. */
type Began = "token" | "install" | "now";

/**
 * The runtime connector of one installed collection, under the worker login's `url`. The install
 * is checked as the worker sees it (the project's marker, the jobs collection) before anything
 * else, so a worker never makes `facetdb_jobs` by its first upsert, without the unique index that
 * keeps one job per record. The driver's pool opens here and closes with `close`.
 */
export async function createMongoConnector(
  target: EngineTarget,
  url: string,
  deps: MongoConnectorDeps,
): Promise<MongoConnector> {
  const { clock, cursors, installer, warn } = deps;
  const subject = subjectOf(target);
  const refused = workerUrlRefusal(url, deps.allowInsecure, subject);
  if (refused !== undefined) {
    throw new EngineRefusal(refused);
  }
  const collection = target.table;
  if (target.storage === "side-table") {
    throw new EngineRefusal({
      code: "side-table",
      message: `${collection}: MongoDB keeps the answers in each document's ${SUBDOCUMENT} field, and has no side-table mode`,
      fix: 'remove storage: "side-table" from the source in facetdb.config.ts',
    });
  }
  const { questionSet } = target;
  if (questionSet.where !== undefined) {
    // The filter is SQL on every other engine; asking every document instead would spend on the
    // records the operator meant to leave out.
    throw new EngineRefusal({
      code: "where-unsupported",
      message: `the source ${target.source} has a where filter, and a MongoDB source cannot apply one yet: it is SQL, which MongoDB does not run`,
      fix: "remove where from the source in facetdb.config.ts, or keep the records it would leave out in another collection",
    });
  }
  const named = target.schema ?? databaseOf(url);
  if (named === undefined) {
    throw new EngineRefusal({
      code: "no-database",
      message: `${subject} names no database, and the source names no database for the collection ${collection}`,
      fix: `add the database to ${subject} (mongodb://${WORKER_USER}:<password>@host/<database>), or name the collection as <database>.${collection} in the config`,
    });
  }
  const database: string = named;
  const label = `${database}.${collection}`;
  const verdict = tlsVerdict(url, deps.allowInsecure);
  const client: WorkerClient = (deps.connect ?? connectWorker)(url, database, {
    forceTls: verdict.kind === "ok" && verdict.forceTls,
    ...(deps.maxConnections === undefined ? {} : { maxConnections: deps.maxConnections }),
    maxAwaitMs: AWAIT_MS,
  });
  let installedAt: Date | undefined;
  try {
    installedAt = await checkInstall();
  } catch (error) {
    await client.close();
    const floor = driverFloor(error);
    if (floor !== undefined) {
      throw new EngineRefusal(belowFloor(url, floor));
    }
    throw error;
  }

  /** The project's marker and the jobs collection, as the worker login sees them. */
  async function checkInstall(): Promise<Date | undefined> {
    const notInstalled = (why: string) =>
      new EngineRefusal({
        code: "not-installed",
        message: `FacetDB is not installed on ${label}: ${why}`,
        fix: "run facetdb migrate on the source first",
      });
    const [marker] = await client.find(
      META_COLLECTION,
      { _id: markerId(collection) },
      { projection: { project: 1, installedAt: 1 }, limit: 1 },
    );
    if (marker === undefined) {
      throw notInstalled(
        `${META_COLLECTION} holds no marker for it, or the worker login may not read it`,
      );
    }
    if (marker["project"] !== target.project.id) {
      throw new EngineRefusal({
        code: "another-project",
        message: `${label} belongs to another project (${String(marker["project"])})`,
        fix: "run the worker from that project's directory, or point the source at another collection",
      });
    }
    const listed = await client.command(database, {
      listCollections: 1,
      filter: { name: JOBS_COLLECTION },
      nameOnly: true,
      authorizedCollections: true,
    });
    const batch = isRecord(listed["cursor"]) ? listed["cursor"]["firstBatch"] : undefined;
    if (!Array.isArray(batch) || batch.length === 0) {
      throw notInstalled(
        `${database}.${JOBS_COLLECTION} is missing, and the worker never makes it: made by a write it would lack the unique index that keeps one job per record`,
      );
    }
    const since = marker["installedAt"];
    return since instanceof Date ? since : undefined;
  }

  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const pageSize = deps.scanPageSize ?? SCAN_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    await client.close();
    throw new Error(`a page holds at least one document, not ${pageSize}`);
  }
  const fields = questionSet.read;
  const projection = stateProjection(fields);
  const pipeline = changePipeline(fields);
  const run = tokenRun(target);
  const reset = target.onChange === "reset";
  /** Every queue filter names the collection by equality first: both jobs indexes lead with it. */
  const jobOf = (key: RecordKey): Sent => ({ [JOB_COLLECTION_FIELD]: collection, record_key: key });

  function rowOf(document: ServerDocument, key: RecordKey): ReadRow {
    const state = stateOf(document, fields);
    return { key, state, hash: stateHash(fields, state), excluded: false };
  }

  /**
   * The change path's queue entry (the trigger's upsert on the SQL engines): a new job, or the job
   * there with its claim cleared, so a worker holding it settles nothing and the record is asked
   * again at its new state.
   */
  const changed = (key: RecordKey) => ({
    filter: jobOf(key),
    update: {
      $set: { claimed_at: null, claimed_by: null, claim_token: null },
      $setOnInsert: { enqueued_at: new Date(clock.now()) },
    },
    upsert: true,
  });

  /** A backfill's queue entry: a new job, or none where one is there, its claim kept. */
  const queued = (key: RecordKey) => ({
    filter: jobOf(key),
    update: {
      $setOnInsert: {
        claimed_at: null,
        claimed_by: null,
        claim_token: null,
        enqueued_at: new Date(clock.now()),
      },
    },
    upsert: true,
  });

  // `close()` sets the flag while `watch` awaits; read through a call so TypeScript does not narrow it.
  let closed = false;
  const isClosed = () => closed;
  /** The stream `watch` follows now, so `close` ends a `getMore` waiting on the server. */
  let following: ChangeFeed | undefined;

  /** Where `watch` starts: the stored token, the install on a first start, or a reconcile. */
  async function opening(): Promise<Opening> {
    const saved = await cursors.load(run);
    if (saved === undefined || saved.cursor === null) {
      return installedAt === undefined
        ? {
            kind: "unreadable",
            why: `${META_COLLECTION} does not say when ${label} was installed, so there is no point to start following changes from`,
          }
        : { kind: "install", since: installedAt };
    }
    const token = storedValue(saved.cursor);
    return isRecord(token)
      ? { kind: "token", token }
      : {
          kind: "unreadable",
          why: `the stored resume point "${saved.cursor}" is not a resume token`,
        };
  }

  function follow(start: FeedStart): ChangeFeed {
    const feed = client.watch(collection, pipeline, start);
    following = feed;
    return feed;
  }

  /** Stores the stream's point; at least once, so a crash before it replays, never skips. */
  let lastSaved: { readonly text: string; readonly at: number } | undefined;
  async function saveToken(feed: ChangeFeed, onlyIfDue: boolean): Promise<void> {
    const token = feed.resumeToken();
    if (!isRecord(token)) {
      return;
    }
    const text = storedText(token);
    if (text === lastSaved?.text) {
      return;
    }
    if (onlyIfDue && lastSaved !== undefined && clock.now() - lastSaved.at < TOKEN_REFRESH_MS) {
      return;
    }
    await cursors.save(run, { cursor: text, done: false });
    lastSaved = { text, at: clock.now() };
  }

  /**
   * Queues the documents of a batch of changes and sets each pending under `onChange: "reset"` (the
   * trigger's `facetdb_status := 'pending'`); `updated_at` stays the time of the last decision
   * (`CurrentDecision.updatedAt`). A change ending the stream throws: following nothing quietly
   * would lose every later change.
   */
  async function capture(changes: readonly ServerDocument[]): Promise<readonly RecordKey[]> {
    const keys: RecordKey[] = [];
    const ids: unknown[] = [];
    for (const change of changes) {
      const type = String(change["operationType"]);
      if (ENDING.has(type)) {
        throw new Error(
          `${label} was ${type === "rename" ? "renamed" : "dropped"} (${type}), and its change stream ended: FacetDB follows one collection by name. Run facetdb migrate on the collection the source names, then start the worker again`,
        );
      }
      const documentKey = change["documentKey"];
      const id = isRecord(documentKey) ? documentKey["_id"] : undefined;
      const key = keyOf(id);
      if (key === undefined) {
        warn(
          `${target.source}: a document of ${label} with the _id ${describeId(id)} changed, and FacetDB cannot queue it: it keys documents by an ObjectId, a string or a number up to 2^53 as their _id`,
        );
        continue;
      }
      if (!keys.includes(key)) {
        keys.push(key);
        ids.push(id);
      }
    }
    if (keys.length === 0) {
      return keys;
    }
    if (reset) {
      await client.updateMany(
        collection,
        { _id: { $in: ids } },
        {
          $set: { [`${SUBDOCUMENT}.status`]: "pending" },
        },
      );
    }
    await client.bulkUpdate(JOBS_COLLECTION, keys.map(changed));
    return keys;
  }

  /** One page of documents after `after`, newest first, the skipped `_id`s said aloud. */
  async function pageAfter(
    after: After | undefined,
    extra: Sent,
  ): Promise<{
    readonly documents: readonly { readonly key: RecordKey; readonly document: ServerDocument }[];
    readonly next: ScanCursor | null;
  }> {
    const found = await client.find(collection, afterFilter(after), {
      projection: { ...projection, ...extra },
      sort: { _id: -1 },
      limit: pageSize,
    });
    const documents: { key: RecordKey; document: ServerDocument }[] = [];
    for (const document of found) {
      const key = keyOf(document["_id"]);
      if (key === undefined) {
        warn(
          `${target.source}: the document of ${label} with the _id ${describeId(document["_id"])} is left out: FacetDB keys documents by an ObjectId, a string or a number up to 2^53 as their _id`,
        );
        continue;
      }
      documents.push({ key, document });
    }
    const last = found.at(-1);
    if (found.length < pageSize || last === undefined) {
      return { documents, next: null };
    }
    // The next page starts after the raw `_id`, keyed or not: a page never ends a pass early.
    const lastId = last["_id"];
    if (!isAfter(lastId)) {
      throw new Error(
        `the page of ${label} ended on the _id ${describeId(lastId)}, which its selection of ObjectId, string and number _ids should not have returned; the pass stops here rather than report every document read`,
      );
    }
    return { documents, next: cursorOf(lastId) };
  }

  /**
   * Says, once per pass, that documents with an `_id` of another type are left out of it: the
   * pages select the three types a key has, so they never see them.
   */
  async function sayOtherIds(): Promise<void> {
    const [other] = await client.find(
      collection,
      { _id: { $not: { $type: KEY_TYPES } } },
      { projection: { _id: 1 }, limit: 1 },
    );
    if (other !== undefined) {
      warn(
        `${target.source}: ${label} holds documents whose _id is neither an ObjectId, a string nor a number (such as ${describeId(other["_id"])}); FacetDB leaves them out, since it keys documents by their _id`,
      );
    }
  }

  /**
   * The lost-token pass: a warning, a stream from a cluster time taken first, then every document
   * once, queuing those whose state moved since their last answer or that have none. The stream is
   * returned for `watch` to follow from that time on.
   */
  async function* reconcile(
    why: string,
  ): AsyncGenerator<readonly RecordKey[], ChangeFeed, undefined> {
    warn(
      `${target.source}: ${why}. FacetDB reads every document of ${label} once and queues each whose state changed since its last answer, or that has none, then follows changes again from before that pass`,
    );
    const feed = follow({ kind: "at", time: await client.operationTime() });
    let read = 0;
    let queuedCount = 0;
    await sayOtherIds();
    let after: After | undefined;
    let next: ScanCursor | null;
    do {
      const page = await pageAfter(after, { [`${SUBDOCUMENT}.state_hash`]: 1 });
      read += page.documents.length;
      const moved: RecordKey[] = [];
      const decided: { readonly id: unknown; readonly stored: string }[] = [];
      for (const { key, document } of page.documents) {
        const stored = subdocumentOf(document)["state_hash"];
        if (stored === rowOf(document, key).hash) {
          continue;
        }
        moved.push(key);
        if (typeof stored === "string") {
          decided.push({ id: document["_id"], stored });
        }
      }
      if (reset) {
        // Only while the stored hash is still the one read: a decision written since is current.
        await client.bulkUpdate(
          collection,
          decided.map(({ id, stored }) => ({
            filter: { _id: id, [`${SUBDOCUMENT}.state_hash`]: stored },
            update: { $set: { [`${SUBDOCUMENT}.status`]: "pending" } },
            upsert: false,
          })),
        );
      }
      // A held claim stays: the hash guard keeps its write honest, and the stream catches what
      // changes from here on.
      await client.bulkUpdate(JOBS_COLLECTION, moved.map(queued));
      queuedCount += moved.length;
      if (moved.length > 0) {
        yield moved;
      }
      next = page.next;
      after = next === null ? undefined : parseCursor(next);
    } while (next !== null);
    warn(
      `${target.source}: the pass over ${label} is done: ${queuedCount} of ${read} documents queued to be asked again; following changes`,
    );
    return feed;
  }

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    if (isClosed()) {
      return;
    }
    const start = await opening();
    let began: Began;
    let feed: ChangeFeed | undefined;
    try {
      if (start.kind === "unreadable") {
        feed = yield* reconcile(start.why);
        began = "now";
      } else if (start.kind === "token") {
        feed = follow({ kind: "after", token: start.token });
        began = "token";
      } else {
        // The first start: from the second the install ran, so a change between `facetdb migrate`
        // and the worker's first start is queued too, as a trigger would have queued it.
        const seconds = Math.floor(start.since.getTime() / 1000);
        feed = follow({ kind: "at", time: new Timestamp({ t: seconds, i: 0 }) });
        began = "install";
      }
      let first = true;
      while (!isClosed()) {
        let change: ServerDocument | null;
        try {
          change = await feed.tryNext();
        } catch (error) {
          if (isClosed()) {
            return;
          }
          const code = serverCode(error);
          const refusedStart =
            first &&
            code !== undefined &&
            ((began === "token" && TOKEN_REFUSED.has(code)) ||
              (began === "install" && HISTORY_LOST.has(code)));
          if (!refusedStart) {
            throw error;
          }
          await feed.close().catch(() => undefined);
          const words = plainMessage(error, [url]);
          feed = yield* reconcile(
            began === "token"
              ? `the change stream cannot resume from its stored point (MongoDB: ${words}), so changes made while the worker was away may be missing`
              : `the oplog no longer reaches back to the install of ${label} at ${installedAt?.toISOString() ?? "its time"} (MongoDB: ${words}), so changes made before this first start may be missing`,
          );
          began = "now";
          continue;
        }
        first = false;
        if (change === null) {
          await saveToken(feed, true);
          continue;
        }
        const batch = [change];
        while (feed.bufferedCount() > 0 && batch.length < WATCH_BATCH) {
          const more = await feed.tryNext();
          if (more === null) {
            break;
          }
          batch.push(more);
        }
        const keys = await capture(batch);
        if (keys.length > 0) {
          yield keys;
        }
        if (isClosed()) {
          return;
        }
        await saveToken(feed, false);
      }
    } finally {
      // `following` is a reconcile's new stream when the worker stopped in the middle of its pass.
      for (const open of new Set([feed, following])) {
        await open?.close().catch(() => undefined);
      }
      following = undefined;
    }
  }

  async function read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const wanted = [...new Set(keys)];
    const ids = wanted.flatMap((key) => {
      const id = idOf(key);
      return id === undefined ? [] : [id];
    });
    const found = new Map<RecordKey, ReadRow>();
    for (const part of chunks(ids, IN_LIST)) {
      for (const document of await client.find(
        collection,
        { _id: { $in: part } },
        { projection },
      )) {
        const key = keyOf(document["_id"]);
        if (key !== undefined) {
          found.set(key, rowOf(document, key));
        }
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

  /**
   * The fields a decision sets, each under `facetdb` (`ownedFields`): every answer field per
   * question role, the status, the decision's time, the state hash it was decided at (what a
   * reconcile compares), and `reviewed` only when the decision carries it (set once, never
   * cleared). A choice's probability list is not in a decision; its field keeps what it has.
   */
  function fieldsFor(decision: RecordDecision, expectedHash: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [question, answer] of Object.entries(decision.decisions)) {
      const asked = questionSet.questions.find((candidate) => candidate.name === question);
      if (asked === undefined) {
        throw new Error(`a decision names "${question}", which is not a question of this source`);
      }
      const decided = answer.kind === "decided" ? answer : undefined;
      for (const column of answerColumns(asked)) {
        const path = `${SUBDOCUMENT}.${column.name}`;
        switch (column.role) {
          case "value":
            out[path] = decided?.value ?? null;
            break;
          case "probability":
          case "confidence":
            out[path] = decided?.probabilityOrConfidence ?? null;
            break;
          case "expected":
            out[path] = decided?.expected ?? null;
            break;
          case "probabilities":
            break;
        }
      }
    }
    out[`${SUBDOCUMENT}.status`] = decision.status;
    out[`${SUBDOCUMENT}.updated_at`] = new Date(clock.now());
    out[`${SUBDOCUMENT}.state_hash`] = expectedHash;
    if (decision.reviewed === true) {
      out[`${SUBDOCUMENT}.reviewed`] = true;
    }
    return out;
  }

  /**
   * In one transaction, the state is read and hashed, and the `facetdb` fields are set only while
   * the hash is the one sent to the model. An application write to the document after the
   * transaction's read makes the update a write conflict, and the driver runs the transaction
   * again, which then finds the new state and writes nothing.
   */
  async function write(
    recordKey: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const set = fieldsFor(decision, expectedHash);
    const id = idOf(recordKey);
    if (id === undefined) {
      return { written: false };
    }
    try {
      const written = await client.transaction(async (tx) => {
        const document = await tx.findOne(collection, { _id: id }, projection);
        if (document === null || rowOf(document, recordKey).hash !== expectedHash) {
          return false;
        }
        return (await tx.updateOne(collection, { _id: id }, { $set: set })) > 0;
      });
      return { written };
    } catch (error) {
      if (serverCode(error) === VALIDATION_FAILED) {
        throw new Error(
          `the validator of ${label} refused FacetDB's ${SUBDOCUMENT} fields for ${recordKey}: let the validator accept an object named ${SUBDOCUMENT} (MongoDB: ${plainMessage(error, [url])})`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** A stored answer as the text `parseCurrent` reads, or null; anything else is an error. */
  function answerText(value: unknown, field: string): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    throw new Error(
      `the field ${SUBDOCUMENT}.${field} of ${label} holds ${JSON.stringify(value)}, not an answer`,
    );
  }

  async function current(
    keys: readonly RecordKey[],
  ): Promise<ReadonlyMap<RecordKey, CurrentDecision>> {
    const ids = [...new Set(keys)].flatMap((key) => {
      const id = idOf(key);
      return id === undefined ? [] : [id];
    });
    const found = new Map<RecordKey, CurrentDecision>();
    for (const part of chunks(ids, IN_LIST)) {
      const documents = await client.find(
        collection,
        { _id: { $in: part } },
        { projection: { [SUBDOCUMENT]: 1 } },
      );
      for (const document of documents) {
        const key = keyOf(document["_id"]);
        if (key === undefined) {
          continue;
        }
        const sub = subdocumentOf(document);
        const updated = sub["updated_at"];
        if (updated !== undefined && updated !== null && !(updated instanceof Date)) {
          throw new Error(
            `the field ${SUBDOCUMENT}.updated_at of ${label} holds ${JSON.stringify(updated)}, not a date`,
          );
        }
        // A document FacetDB never wrote is a record of an installed collection: pending, with
        // nothing decided, as a new row is under the SQL engines' column default.
        const row: Record<string, unknown> = {
          cs: sub["status"] ?? "pending",
          cu: updated instanceof Date ? String(updated.getTime()) : null,
          cr: sub["reviewed"] === true,
        };
        questionSet.questions.forEach((question, index) => {
          for (const column of answerColumns(question)) {
            const alias =
              column.role === "value"
                ? "v"
                : column.role === "probability" || column.role === "confidence"
                  ? "p"
                  : column.role === "expected"
                    ? "e"
                    : undefined;
            if (alias !== undefined) {
              row[`q${index}${alias}`] = answerText(sub[column.name], column.name);
            }
          }
        });
        const decision = parseCurrent(row, questionSet.questions);
        if (decision !== undefined) {
          found.set(key, decision);
        }
      }
    }
    return found;
  }

  /** Every document, newest first (an ObjectId's time is its first bytes), by `_id` keyset. */
  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    if (cursor === null) {
      await sayOtherIds();
    }
    const page = await pageAfter(cursor === null ? undefined : parseCursor(cursor), {});
    return {
      rows: page.documents.map(({ key, document }) => rowOf(document, key)),
      next: page.next,
    };
  }

  /** The token each key this worker holds was claimed under; `ack` and `release` settle by it. */
  const tokens = new Map<RecordKey, string>();
  function byToken(keys: readonly RecordKey[]): Map<string, RecordKey[]> {
    const groups = new Map<string, RecordKey[]>();
    for (const key of new Set(keys)) {
      const token = tokens.get(key);
      if (token !== undefined) {
        groups.set(token, [...(groups.get(token) ?? []), key]);
      }
    }
    return groups;
  }

  /**
   * Settles the keys this worker holds, by key, owner and claim token: a job whose claim a change
   * cleared, or whose lease ended and another worker took, matches none of them and stays, to be
   * asked again at its new state. A key's token is forgotten only once its settle ran.
   */
  async function settle(kind: "ack" | "release", keys: readonly RecordKey[]): Promise<void> {
    for (const [token, group] of byToken(keys)) {
      for (const part of chunks(group, IN_LIST)) {
        const filter = {
          [JOB_COLLECTION_FIELD]: collection,
          record_key: { $in: part },
          claimed_by: workerId,
          claim_token: token,
        };
        if (kind === "ack") {
          await client.deleteMany(JOBS_COLLECTION, filter);
        } else {
          await client.updateMany(JOBS_COLLECTION, filter, {
            $set: { claimed_at: null, claimed_by: null, claim_token: null },
          });
        }
        for (const key of part) {
          tokens.delete(key);
        }
      }
    }
  }

  return {
    capabilities: MONGO_CAPABILITIES,
    workerId,
    install() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "install runs through the engine's plan, shown before it runs: run `facetdb migrate`, or pass an installer",
          ),
        );
      }
      return installer.install();
    },
    uninstall() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "uninstall runs through the engine's plan, shown before it runs: run `facetdb uninstall`, or pass an installer",
          ),
        );
      }
      return installer.uninstall();
    },
    watch,
    read,
    write,
    current,
    scan,
    /** A backfill's keys, each its own upsert in one round trip: a queued key keeps its job and claim. */
    async enqueue(keys) {
      await client.bulkUpdate(JOBS_COLLECTION, [...new Set(keys)].map(queued));
    },
    /**
     * One atomic find-and-update per job, a free one or one whose lease ended, stamped with this
     * worker, the clock's time and this claim's token; a second worker's find-and-update never
     * matches a job the first one stamped.
     */
    async claim(limit) {
      const now = clock.now();
      const token = claimToken();
      const claimed: RecordKey[] = [];
      while (claimed.length < limit) {
        const job = await client.findOneAndUpdate(
          JOBS_COLLECTION,
          {
            [JOB_COLLECTION_FIELD]: collection,
            $or: [{ claimed_at: null }, { claimed_at: { $lt: new Date(now - CLAIM_LEASE_MS) } }],
          },
          { $set: { claimed_by: workerId, claimed_at: new Date(now), claim_token: token } },
        );
        if (job === null) {
          break;
        }
        const key = job["record_key"];
        if (typeof key !== "string") {
          throw new Error(
            `a job of ${database}.${JOBS_COLLECTION} holds the record_key ${JSON.stringify(key)}, not text`,
          );
        }
        tokens.set(key, token);
        claimed.push(key);
      }
      return claimed;
    },
    /**
     * Inserts the job already claimed, in one atomic upsert: a key queued already, claimed or not,
     * matches the existing job, which `$setOnInsert` leaves as it is, and that is the false.
     */
    async claimKey(recordKey) {
      const token = claimToken();
      const { upserted } = await client.updateOne(
        JOBS_COLLECTION,
        jobOf(recordKey),
        {
          $setOnInsert: {
            claimed_by: workerId,
            claimed_at: new Date(clock.now()),
            claim_token: token,
            enqueued_at: new Date(clock.now()),
          },
        },
        true,
      );
      if (upserted) {
        tokens.set(recordKey, token);
      }
      return upserted;
    },
    ack: (keys) => settle("ack", keys),
    release: (keys) => settle("release", keys),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await following?.close().catch(() => undefined);
      await client.close();
    },
  };
}
