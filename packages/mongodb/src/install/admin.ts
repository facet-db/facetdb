import { MongoClient } from "mongodb";

/**
 * The admin connection: what the plans read and `run` sends through the mongodb driver, and nothing
 * more, so a test passes a recording fake through the same parameter (FakeMongo in ../testing). It
 * is opened for one call with the admin connection string and closed after it; nothing keeps it.
 */

/** A document as the server sent it: read through catalog.ts's checks, never trusted as typed. */
export type ServerDocument = Readonly<Record<string, unknown>>;

/** A command, a filter or a pipeline stage as the driver takes it. */
export type Sent = Readonly<Record<string, unknown>>;

export type AdminClient = {
  /** One command in `database` (`Db.command`): the server's reply, or its error thrown. */
  command(database: string, command: Sent): Promise<ServerDocument>;
  /** The collections of `database` that `filter` selects, their names and types only. */
  listCollections(database: string, filter: Sent): Promise<readonly ServerDocument[]>;
  /** The first document of a collection matching `filter`, or null (`Collection.findOne`). */
  findOne(database: string, collection: string, filter: Sent): Promise<ServerDocument | null>;
  /** Lets go of the connection. */
  close(): Promise<void>;
};

/**
 * Opens the admin connection. `forceTls` tells the driver `tls: true` beside the string, for a host
 * off this machine whose string asks for nothing (../urls, `tlsVerdict`).
 */
export type AdminConnect = (url: string, options: { readonly forceTls: boolean }) => AdminClient;

/** The admin connection over the mongodb driver; it connects on its first command. */
export const connectAdmin: AdminConnect = (url, options) => {
  const client = new MongoClient(url, options.forceTls ? { tls: true } : {});
  return {
    command: (database, command) => client.db(database).command(command),
    listCollections: (database, filter) =>
      client.db(database).listCollections(filter, { nameOnly: true }).toArray(),
    findOne: (database, collection, filter) =>
      client.db(database).collection(collection).findOne(filter),
    close: () => client.close(),
  };
};

/** The server's error code on a driver error (a boundary: read, never assumed), or undefined. */
export function serverCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}

/**
 * The oldest MongoDB the pinned driver talks to, as mongodb 7.8.0's constants say
 * (`MIN_SUPPORTED_SERVER_VERSION` in its cmap/wire_protocol/constants.js). Only the fallback: the
 * refusal names the floor the driver's own words give.
 */
export const SERVER_FLOOR = "4.4";

/**
 * How the driver words that refusal, on its `MongoCompatibilityError` and the selection error it
 * causes: the server's wire version, the one it needs, and that one's MongoDB version.
 */
const BELOW_FLOOR = /wire version .*requires at least \d+(?: \(MongoDB (\d+(?:\.\d+)*)\))?/s;

/**
 * The floor the driver refused the server below, read from its own words (`(MongoDB 4.4)`), so a
 * driver upgrade never leaves the refusal naming an old one; `SERVER_FLOOR` when the words name no
 * version; undefined when the error is not that refusal. The refusal is the handshake's error, or
 * the server selection error that carries it as its message or its cause.
 */
export function driverFloor(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const words = BELOW_FLOOR.exec(current.message);
    if (words !== null) {
      return words[1] ?? SERVER_FLOOR;
    }
    current = current.cause;
  }
  return undefined;
}
