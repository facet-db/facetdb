import { type Connection, createConnection, escape as driverEscape } from "mysql2/promise";

/** One row as the driver returns it: column label to value, read and checked by its caller. */
export type MysqlRow = Readonly<Record<string, unknown>>;

/**
 * Runs one statement and returns its rows (none for a statement that returns none). With `params`
 * the driver writes each value in place of a `?`, escaped as a string literal (mysql2's `query`
 * interpolates on the client: a DDL statement such as `create user … identified by ?` takes no
 * server-side parameter); without them the text goes to the server exactly as given.
 */
export type MysqlQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly MysqlRow[]>;

/**
 * What the install, uninstall and prune plans and their run need from a MySQL driver: one
 * connection, one statement per call, and a way to let go of it. `connectMysql` implements it over
 * mysql2; a test hands in the recording driver of `../testing` through the same type, so no module
 * is patched.
 */
export type MysqlClient = {
  readonly query: MysqlQuery;
  /** Lets go of the connection; one that never opened has nothing to let go of. */
  close(): Promise<void>;
};

/** Opens a client for a connection string: the composition root passes this, or a fake. */
export type MysqlConnect = (url: string) => MysqlClient;

/**
 * Runs `work` on a client opened for the call and closed whatever happens: the admin connection is
 * kept nowhere.
 */
export async function withClient<T>(
  connect: MysqlConnect,
  url: string,
  work: (query: MysqlQuery) => Promise<T>,
): Promise<T> {
  const client = connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
}

/**
 * A value as mysql2 writes it into a statement in place of a `?`: quoted, with backslash escapes.
 * The run blanks this form from an error too, since a server's "near '…'" quotes the text it got.
 */
export function driverLiteral(value: string): string {
  return driverEscape(value);
}

/**
 * The mysql2 client: one connection, opened by the first statement and read from the URL as mysql2
 * reads it (TLS from its `ssl` parameter, judged first by `tlsProblem`). One statement per call:
 * `multipleStatements` stays off, so no text ever carries a second statement.
 */
export function connectMysql(url: string): MysqlClient {
  let opening: Promise<Connection> | undefined;
  const connection = (): Promise<Connection> => {
    opening ??= createConnection(url);
    return opening;
  };
  return {
    async query(text, params) {
      const [result] = await (await connection()).query(
        text,
        params === undefined ? undefined : [...params],
      );
      return Array.isArray(result) ? (result as readonly MysqlRow[]) : [];
    },
    async close() {
      const opened = opening;
      opening = undefined;
      // A connection that failed to open was reported by the statement that waited for it.
      await opened?.then(
        (open) => open.end(),
        () => undefined,
      );
    },
  };
}
