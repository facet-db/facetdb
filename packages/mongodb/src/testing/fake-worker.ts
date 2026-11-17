import { Double, Int32, Long, ObjectId, Timestamp } from "mongodb";
import type {
  BulkUpdate,
  ChangeFeed,
  FeedStart,
  TransactionOps,
  WorkerClient,
  WorkerConnect,
} from "../connector/index.ts";
import type { Sent, ServerDocument } from "../install/index.ts";

/**
 * A recording fake of the worker's connection (connector/client.ts's `WorkerClient`), for unit
 * tests with no server: it records every call in order and keeps the documents of a few
 * collections in memory, enough for the connector's filters (equality, `$in`, `$lt`, `$ne`,
 * `$type`, `$not`, `$or`, dotted paths) and updates (`$set`, `$setOnInsert`, upserts). Change
 * streams are scripted: each `watch` takes the next script a test queued with `feed`, whose steps
 * are a batch of changes, an empty batch, or a server error; once a script runs out, `tryNext`
 * waits until the stream is closed, as a quiet collection's does. An operator or a command it does
 * not model throws, so a connector that sends something new fails loudly. It is passed through
 * `connect`, the parameter the real driver's `connectWorker` fills; nothing is patched.
 */

export type FakeWorkerCall =
  | { readonly kind: "connect"; readonly url: string; readonly forceTls: boolean }
  | {
      readonly kind: "watch";
      readonly collection: string;
      readonly pipeline: readonly Sent[];
      readonly start: FeedStart;
    }
  | { readonly kind: "operationTime" }
  | { readonly kind: "find"; readonly collection: string; readonly filter: Sent }
  | { readonly kind: "findOneAndUpdate"; readonly collection: string; readonly filter: Sent }
  | {
      readonly kind: "updateOne" | "updateMany";
      readonly collection: string;
      readonly filter: Sent;
      readonly update: Sent;
    }
  | {
      readonly kind: "bulkUpdate";
      readonly collection: string;
      readonly updates: readonly BulkUpdate[];
    }
  | { readonly kind: "deleteMany"; readonly collection: string; readonly filter: Sent }
  | { readonly kind: "transaction" }
  | { readonly kind: "command"; readonly database: string; readonly command: Sent }
  | { readonly kind: "close" }
  // What a test notes beside the calls (a token saved, a batch yielded), to read one order.
  | { readonly kind: "note"; readonly what: string };

/** One step of a scripted change stream. */
export type FeedStep =
  | { readonly changes: readonly ServerDocument[] }
  | { readonly empty: true }
  | { readonly error: Error };

type Doc = Record<string, unknown>;

/** A plain document: not an array, a Date, nor a value of the driver's BSON classes. */
const isDoc = (value: unknown): value is Doc =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !("_bsontype" in value);

/** A number the driver wraps (an Int32, a Double or a Long read back from Extended JSON) as a number. */
function plain(value: unknown): unknown {
  if (value instanceof Int32 || value instanceof Double) {
    return value.valueOf();
  }
  return value instanceof Long ? value.toNumber() : value;
}

function same(left: unknown, right: unknown): boolean {
  const [a, b] = [plain(left), plain(right)];
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.equals(b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/** A value's BSON type name, as `$type` spells it. */
function typeName(wrapped: unknown): string {
  const value = plain(wrapped);
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "double";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (value instanceof ObjectId) {
    return "objectId";
  }
  if (value instanceof Date) {
    return "date";
  }
  return Array.isArray(value) ? "array" : "object";
}

/** MongoDB's order across types: numbers, strings, documents, ObjectIds, booleans, dates. */
const RANK: Readonly<Record<string, number>> = {
  null: 0,
  int: 1,
  double: 1,
  string: 2,
  object: 3,
  array: 4,
  objectId: 7,
  bool: 8,
  date: 9,
};

function compare(left: unknown, right: unknown): number {
  const [a, b] = [plain(left), plain(right)];
  const ranked = (RANK[typeName(a)] ?? 99) - (RANK[typeName(b)] ?? 99);
  if (ranked !== 0) {
    return ranked;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return a.toHexString() < b.toHexString() ? -1 : a.equals(b) ? 0 : 1;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  const [one, other] = [String(a), String(b)];
  return one < other ? -1 : one === other ? 0 : 1;
}

function valueAt(document: Doc, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (!isDoc(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setAt(document: Doc, path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop() ?? path;
  let current = document;
  for (const part of parts) {
    const inner = current[part];
    if (!isDoc(inner)) {
      current[part] = {};
    }
    current = current[part] as Doc;
  }
  current[last] = value;
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (isDoc(condition) && Object.keys(condition).some((key) => key.startsWith("$"))) {
    return Object.entries(condition).every(([operator, argument]) => {
      switch (operator) {
        case "$in":
          return Array.isArray(argument) && argument.some((one) => same(value, one));
        case "$lt":
          return (
            value !== undefined &&
            value !== null &&
            RANK[typeName(value)] === RANK[typeName(argument)] &&
            compare(value, argument) < 0
          );
        case "$ne":
          return !matchesValue(value, argument);
        case "$type": {
          const wanted = Array.isArray(argument) ? argument : [argument];
          const type = typeName(value);
          return wanted.some(
            (one) =>
              one === type ||
              (one === "long" && type === "int") ||
              (one === "number" && RANK[type] === 1),
          );
        }
        case "$not":
          return !matchesValue(value, argument);
        default:
          throw new Error(`the fake MongoDB does not model ${operator}`);
      }
    });
  }
  if (condition === null) {
    return value === null || value === undefined;
  }
  return same(value, condition);
}

function matches(document: Doc, filter: Sent): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (
        Array.isArray(condition) && condition.some((one) => isDoc(one) && matches(document, one))
      );
    }
    if (key.startsWith("$")) {
      throw new Error(`the fake MongoDB does not model ${key}`);
    }
    return matchesValue(valueAt(document, key), condition);
  });
}

function apply(document: Doc, update: Sent, inserting: boolean): void {
  for (const [operator, fields] of Object.entries(update)) {
    if (!isDoc(fields)) {
      throw new Error(`the fake MongoDB expected fields for ${operator}`);
    }
    if (operator === "$set" || (operator === "$setOnInsert" && inserting)) {
      for (const [path, value] of Object.entries(fields)) {
        setAt(document, path, value);
      }
    } else if (operator !== "$setOnInsert") {
      throw new Error(`the fake MongoDB does not model ${operator}`);
    }
  }
}

/** A copy deep enough that a test's later writes never reach a document handed out. */
function copy(document: Doc): Doc {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [key, isDoc(value) ? copy(value) : value]),
  );
}

export class FakeWorkerMongo {
  readonly calls: FakeWorkerCall[] = [];
  /** Documents by collection: what tests seed and read. */
  readonly collections = new Map<string, Doc[]>();
  /** What `hello` answers: a one-node replica set's primary unless a test says otherwise. */
  hello: ServerDocument = { isWritablePrimary: true, setName: "rs0", ok: 1 };
  /**
   * Replies of the commands doctor reads, by command name, or by name and collection
   * (`listIndexes facetdb_jobs`) to script one collection's; a missing one throws.
   */
  readonly replies = new Map<string, ServerDocument | Error>();
  /** The time `operationTime` answers. */
  operationTimeIs = new Timestamp({ t: 1_800_000_000, i: 1 });
  private readonly scripts: FeedStep[][] = [];
  private readonly failures = new Map<string, Error>();

  /** The worker's connection over this fake, as `connectWorker` is over the driver. */
  readonly connect: WorkerConnect = (url, database, options) => {
    this.calls.push({ kind: "connect", url, forceTls: options.forceTls });
    return this.client(database);
  };

  /** Queues the script of the next stream a `watch` opens. */
  feed(...steps: FeedStep[]): this {
    this.scripts.push(steps);
    return this;
  }

  /** Every later call of a kind fails with `error` (a server refusing it). */
  fail(kind: FakeWorkerCall["kind"], error: Error): this {
    this.failures.set(kind, error);
    return this;
  }

  /** A collection's documents, made empty on first use. */
  documents(collection: string): Doc[] {
    let documents = this.collections.get(collection);
    if (documents === undefined) {
      documents = [];
      this.collections.set(collection, documents);
    }
    return documents;
  }

  insert(collection: string, ...documents: readonly Doc[]): this {
    this.documents(collection).push(...documents.map(copy));
    return this;
  }

  /** Notes something beside the calls, so a test reads one order. */
  note(what: string): void {
    this.calls.push({ kind: "note", what });
  }

  /** The calls of some kinds, in order. */
  callsOf<K extends FakeWorkerCall["kind"]>(
    ...kinds: K[]
  ): Extract<FakeWorkerCall, { readonly kind: K }>[] {
    return this.calls.filter((call): call is Extract<FakeWorkerCall, { readonly kind: K }> =>
      kinds.some((kind) => kind === call.kind),
    );
  }

  private failed(kind: FakeWorkerCall["kind"]): void {
    const failure = this.failures.get(kind);
    if (failure !== undefined) {
      throw failure;
    }
  }

  private find(collection: string, filter: Sent): Doc[] {
    return this.documents(collection).filter((document) => matches(document, filter));
  }

  private updateOne(collection: string, filter: Sent, update: Sent, upsert: boolean) {
    const [found] = this.find(collection, filter);
    if (found !== undefined) {
      apply(found, update, false);
      return { matched: 1, upserted: false };
    }
    if (!upsert) {
      return { matched: 0, upserted: false };
    }
    const document: Doc = Object.fromEntries(
      Object.entries(filter).filter(([key, value]) => !key.startsWith("$") && !isDoc(value)),
    );
    apply(document, update, true);
    this.documents(collection).push(document);
    return { matched: 0, upserted: true };
  }

  /** Adds steps to the stream opened last, waking a `tryNext` that waits on it. */
  push(...steps: FeedStep[]): this {
    if (this.live === undefined) {
      throw new Error("no stream is open to push changes to");
    }
    this.live.script.push(...steps);
    this.live.wake?.();
    return this;
  }

  private live: { readonly script: FeedStep[]; wake?: () => void } | undefined;

  private changeFeed(script: FeedStep[]): ChangeFeed {
    let buffer: ServerDocument[] = [];
    let token: unknown;
    let batches = 0;
    let closed = false;
    // `close()` sets the flag while `tryNext` awaits; read through a call so TypeScript does not narrow it.
    const isClosed = () => closed;
    const live: { readonly script: FeedStep[]; wake?: () => void } = { script };
    this.live = live;
    const tokenOf = (change: ServerDocument) => change["_id"];
    return {
      tryNext: async () => {
        if (isClosed()) {
          throw new Error("ChangeStream is closed");
        }
        const buffered = buffer.shift();
        if (buffered !== undefined) {
          token = buffer.length === 0 ? { _data: `pbrt-${batches}` } : tokenOf(buffered);
          return buffered;
        }
        // A quiet collection: the `getMore` waits until a change comes or the stream closes.
        while (script.length === 0 && !isClosed()) {
          await new Promise<void>((resolve) => {
            live.wake = resolve;
          });
        }
        const step = script.shift();
        if (step === undefined) {
          return null;
        }
        batches += 1;
        if ("error" in step) {
          throw step.error;
        }
        if ("empty" in step) {
          token = { _data: `pbrt-${batches}` };
          return null;
        }
        const [first, ...rest] = step.changes;
        buffer = rest;
        if (first === undefined) {
          return null;
        }
        token = rest.length === 0 ? { _data: `pbrt-${batches}` } : tokenOf(first);
        return first;
      },
      bufferedCount: () => buffer.length,
      resumeToken: () => token,
      close: () => {
        closed = true;
        live.wake?.();
        return Promise.resolve();
      },
    };
  }

  private client(database: string): WorkerClient {
    const record = (call: FakeWorkerCall) => {
      this.calls.push(call);
      this.failed(call.kind);
    };
    const run = <T>(call: FakeWorkerCall, work: () => T): Promise<T> => {
      try {
        record(call);
        return Promise.resolve(work());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const transactionOps: TransactionOps = {
      findOne: (collection, filter) => {
        const [found] = this.find(collection, filter);
        return Promise.resolve(found === undefined ? null : copy(found));
      },
      updateOne: (collection, filter, update) =>
        Promise.resolve(this.updateOne(collection, filter, update, false).matched),
    };
    return {
      database,
      watch: (collection, pipeline, start) => {
        record({ kind: "watch", collection, pipeline, start });
        return this.changeFeed(this.scripts.shift() ?? []);
      },
      operationTime: () => run({ kind: "operationTime" }, () => this.operationTimeIs),
      find: (collection, filter, options) =>
        run({ kind: "find", collection, filter }, () => {
          const found = this.find(collection, filter).map(copy);
          const sorted =
            options.sort?.["_id"] === -1
              ? found.sort((a, b) => compare(b["_id"], a["_id"]))
              : found;
          return options.limit === undefined ? sorted : sorted.slice(0, options.limit);
        }),
      findOneAndUpdate: (collection, filter, update) =>
        run({ kind: "findOneAndUpdate", collection, filter }, () => {
          const [found] = this.find(collection, filter);
          if (found === undefined) {
            return null;
          }
          const before = copy(found);
          apply(found, update, false);
          return before;
        }),
      updateOne: (collection, filter, update, upsert) =>
        run({ kind: "updateOne", collection, filter, update }, () =>
          this.updateOne(collection, filter, update, upsert),
        ),
      bulkUpdate: (collection, updates) =>
        run({ kind: "bulkUpdate", collection, updates }, () => {
          for (const { filter, update, upsert } of updates) {
            this.updateOne(collection, filter, update, upsert);
          }
        }),
      updateMany: (collection, filter, update) =>
        run({ kind: "updateMany", collection, filter, update }, () => {
          const found = this.find(collection, filter);
          for (const document of found) {
            apply(document, update, false);
          }
          return found.length;
        }),
      deleteMany: (collection, filter) =>
        run({ kind: "deleteMany", collection, filter }, () => {
          const documents = this.documents(collection);
          const kept = documents.filter((document) => !matches(document, filter));
          const deleted = documents.length - kept.length;
          documents.splice(0, documents.length, ...kept);
          return deleted;
        }),
      transaction: async (work) => {
        record({ kind: "transaction" });
        return work(transactionOps);
      },
      command: (inDatabase, command) =>
        run({ kind: "command", database: inDatabase, command }, () => this.command(command)),
      close: () => run({ kind: "close" }, () => undefined),
    };
  }

  private command(command: Sent): ServerDocument {
    const [name = ""] = Object.keys(command);
    // A scripted reply for one collection's command (`find oplog.rs`) wins over the model.
    const scripted = this.replies.get(`${name} ${String(command[name])}`);
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted !== undefined) {
      return scripted;
    }
    if (name === "hello") {
      return this.hello;
    }
    if (name === "listCollections") {
      const filter = isDoc(command["filter"]) ? command["filter"] : {};
      const wanted = filter["name"];
      return {
        cursor: {
          firstBatch: [...this.collections.keys()]
            .filter((collection) => wanted === undefined || collection === wanted)
            .map((collection) => ({ name: collection, type: "collection" })),
          id: 0,
        },
        ok: 1,
      };
    }
    if (name === "find" || name === "count") {
      const collection = String(command[name]);
      const filter = command["filter"] ?? command["query"];
      const found = this.find(collection, isDoc(filter) ? filter : {});
      // `{ $natural: -1 }`: the oplog's newest entry first.
      const sort = command["sort"];
      const ordered = isDoc(sort) && sort["$natural"] === -1 ? found.reverse() : found;
      return name === "count"
        ? { n: found.length, ok: 1 }
        : { cursor: { firstBatch: ordered.slice(0, 1).map(copy), id: 0 }, ok: 1 };
    }
    const reply = this.replies.get(name);
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply === undefined) {
      throw new Error(`the fake MongoDB does not model the command ${name}`);
    }
    return reply;
  }
}
