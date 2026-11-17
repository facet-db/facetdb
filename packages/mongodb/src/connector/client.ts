import { type Document, MongoClient, Timestamp } from "mongodb";
import type { Sent, ServerDocument } from "../install/index.ts";

/**
 * The worker's connection: what the runtime connector and doctor send through the mongodb driver
 * under the worker login, and nothing more, so a unit test passes a recording fake through the same
 * parameter (`FakeWorkerMongo` in ../testing). Every call names its collection in the one database
 * the connection was opened for. Replies are a boundary: the connector reads each field through a
 * check, never as typed.
 */

/** Where a change stream starts: after a stored resume token, or at a cluster time. */
export type FeedStart =
  | { readonly kind: "after"; readonly token: Sent }
  | { readonly kind: "at"; readonly time: Timestamp };

/** A change stream on one collection, as the connector reads it (the driver's `ChangeStream`). */
export type ChangeFeed = {
  /**
   * The next change, or null when none came within the server's wait (`maxAwaitTimeMS`). The first
   * call sends the stream's `aggregate`, so a start the server refuses throws here.
   */
  tryNext(): Promise<ServerDocument | null>;
  /** Changes already received and not yet returned by `tryNext`. */
  bufferedCount(): number;
  /**
   * The point to resume after: the last change returned, or once the batch is read, the server's
   * high-water mark past every change it examined (the filtered ones too). Undefined before the
   * first batch.
   */
  resumeToken(): unknown;
  close(): Promise<void>;
};

/** One write of a bulk: an `updateOne`, upserting or not. */
export type BulkUpdate = {
  readonly filter: Sent;
  readonly update: Sent;
  readonly upsert: boolean;
};

/** What a transaction may do: read one document and update it. */
export type TransactionOps = {
  findOne(collection: string, filter: Sent, projection: Sent): Promise<ServerDocument | null>;
  /** The documents matched. */
  updateOne(collection: string, filter: Sent, update: Sent): Promise<number>;
};

export type WorkerClient = {
  /** The database every call works in: the source's. */
  readonly database: string;
  watch(collection: string, pipeline: readonly Sent[], start: FeedStart): ChangeFeed;
  /** The cluster's time now: `hello`'s `operationTime`, a time a change stream can start at. */
  operationTime(): Promise<Timestamp>;
  find(
    collection: string,
    filter: Sent,
    options: {
      readonly projection: Sent;
      readonly sort?: Readonly<Record<string, 1 | -1>>;
      readonly limit?: number;
    },
  ): Promise<readonly ServerDocument[]>;
  /** One atomic find-and-update; the document as it was before, or null when none matched. */
  findOneAndUpdate(collection: string, filter: Sent, update: Sent): Promise<ServerDocument | null>;
  /** One `updateOne`; whether it matched a document and whether it inserted one. */
  updateOne(
    collection: string,
    filter: Sent,
    update: Sent,
    upsert: boolean,
  ): Promise<{ readonly matched: number; readonly upserted: boolean }>;
  /** Several `updateOne`s in one round trip, in no particular order. Nothing to do for none. */
  bulkUpdate(collection: string, updates: readonly BulkUpdate[]): Promise<void>;
  /** The documents matched. */
  updateMany(collection: string, filter: Sent, update: Sent): Promise<number>;
  /** The documents deleted. */
  deleteMany(collection: string, filter: Sent): Promise<number>;
  /**
   * `work` in one transaction: snapshot reads and a majority commit, run again whole on a transient
   * error (a write conflict with the application's own write), as the driver's `withTransaction`.
   */
  transaction<T>(work: (tx: TransactionOps) => Promise<T>): Promise<T>;
  /** One command in `database` (doctor's reads), the server's reply or its error thrown. */
  command(database: string, command: Sent): Promise<ServerDocument>;
  close(): Promise<void>;
};

export type WorkerConnectOptions = {
  /** Tell the driver `tls: true` beside the string (../urls, `tlsVerdict`). */
  readonly forceTls: boolean;
  /** The most connections the pool opens; the driver's 100 when absent. */
  readonly maxConnections?: number;
  /** How long a change stream's `getMore` waits on the server for a change. */
  readonly maxAwaitMs: number;
};

export type WorkerConnect = (
  url: string,
  database: string,
  options: WorkerConnectOptions,
) => WorkerClient;

/** The worker's connection over the mongodb driver; it connects on its first call. */
export const connectWorker: WorkerConnect = (url, database, options) => {
  const client = new MongoClient(url, {
    // Every write of the worker's waits for a majority: a job queued at w:1 and rolled back by a
    // failover after its change's resume token was stored would be a change lost without a word.
    // One rule for the queue, the status the capture sets, the claims and the settles.
    writeConcern: { w: "majority" },
    ...(options.forceTls ? { tls: true } : {}),
    ...(options.maxConnections === undefined ? {} : { maxPoolSize: options.maxConnections }),
  });
  const db = client.db(database);
  return {
    database,
    watch(collection, pipeline, start) {
      const stream = db
        .collection(collection)
        // Read as plain documents: the pipeline's `$project` shapes them, not the driver's types.
        .watch<Document, Document>([...pipeline], {
          maxAwaitTimeMS: options.maxAwaitMs,
          ...(start.kind === "after"
            ? { resumeAfter: start.token }
            : { startAtOperationTime: start.time }),
        });
      return {
        tryNext: () => stream.tryNext(),
        bufferedCount: () => stream.bufferedCount(),
        resumeToken: () => stream.resumeToken,
        close: () => stream.close(),
      };
    },
    async operationTime() {
      const reply = await db.admin().command({ hello: 1 });
      const time: unknown = reply["operationTime"];
      if (!(time instanceof Timestamp)) {
        throw new Error(
          `MongoDB answered hello without an operationTime (${JSON.stringify(reply)}): a change stream needs a replica set or a sharded cluster`,
        );
      }
      return time;
    },
    find: (collection, filter, findOptions) =>
      db
        .collection(collection)
        .find(filter, {
          projection: findOptions.projection,
          ...(findOptions.sort === undefined ? {} : { sort: { ...findOptions.sort } }),
          ...(findOptions.limit === undefined ? {} : { limit: findOptions.limit }),
        })
        .toArray(),
    findOneAndUpdate: (collection, filter, update) =>
      db.collection(collection).findOneAndUpdate(filter, update),
    async updateOne(collection, filter, update, upsert) {
      const result = await db.collection(collection).updateOne(filter, update, { upsert });
      return { matched: result.matchedCount, upserted: result.upsertedCount > 0 };
    },
    async bulkUpdate(collection, updates) {
      if (updates.length === 0) {
        return;
      }
      await db.collection(collection).bulkWrite(
        updates.map(({ filter, update, upsert }) => ({ updateOne: { filter, update, upsert } })),
        { ordered: false },
      );
    },
    async updateMany(collection, filter, update) {
      return (await db.collection(collection).updateMany(filter, update)).matchedCount;
    },
    async deleteMany(collection, filter) {
      return (await db.collection(collection).deleteMany(filter)).deletedCount;
    },
    transaction<T>(work: (tx: TransactionOps) => Promise<T>): Promise<T> {
      return client.withSession(async (session) => {
        // The last run's result: `withTransaction` runs `work` again after a transient error.
        let result: { readonly value: T } | undefined;
        await session.withTransaction(
          async () => {
            result = {
              value: await work({
                findOne: (collection, filter, projection) =>
                  db.collection(collection).findOne(filter, { projection, session }),
                async updateOne(collection, filter, update) {
                  return (await db.collection(collection).updateOne(filter, update, { session }))
                    .matchedCount;
                },
              }),
            };
          },
          { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
        );
        if (result === undefined) {
          throw new Error("the transaction ended without running its work");
        }
        return result.value;
      });
    },
    command: (inDatabase, command) => client.db(inDatabase).command(command),
    close: () => client.close(),
  };
};
