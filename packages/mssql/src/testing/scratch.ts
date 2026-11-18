import { WORKER_USER } from "../install/index.ts";
import { connectMssql, quoteName, quoteString } from "../sql/index.ts";

/**
 * What the db suites leave on the shared test server, dropped at the end of each: the suite's
 * scratch databases, then the worker's server login.
 *
 * The login is shared: contained database authentication is off on the test server, so every
 * suite's worker is that one server login, and each suite's install makes it again when it is
 * missing (with the one password the suites share). This package's db files run one after another
 * (`fileParallelism: false` in vitest.db.config.ts), so no other suite of it is running when one
 * file's cleanup runs; still, the login is dropped only once no session of it is left (a session
 * still closing after the suite's connections closed is waited for, a few seconds at most), since
 * SQL Server refuses to drop a logged-in login (error 15434) and killing a session that is not the
 * suite's own would end someone else's run.
 */

/** How long the cleanup waits for the worker's last sessions to end before it leaves the login. */
const SESSION_WAIT_MS = 5_000;

export async function dropScratch(server: string, databases: readonly string[]): Promise<void> {
  const root = connectMssql(server);
  try {
    for (const database of databases) {
      const name = quoteName(database);
      await root.query(
        `if db_id(${quoteString(database)}) is not null begin alter database ${name} set single_user with rollback immediate; drop database ${name}; end`,
      );
    }
    const until = Date.now() + SESSION_WAIT_MS;
    for (;;) {
      const [row] = await root.query(
        "select count(*) as n from sys.dm_exec_sessions where login_name = @p1",
        [WORKER_USER],
      );
      if (row?.["n"] === 0) {
        break;
      }
      if (Date.now() > until) {
        process.stderr.write(
          `the login ${WORKER_USER} still has a session on the test server after this suite; it stays there\n`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await root.query(
        `if exists (select 1 from sys.server_principals where name = ${quoteString(WORKER_USER)}) drop login ${quoteName(WORKER_USER)}`,
      );
    } catch (error) {
      // A session that logged in since the count: the login stays, said, and the run goes on.
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "number" in error &&
          error.number === 15434
        )
      ) {
        throw error;
      }
      process.stderr.write(
        `the login ${WORKER_USER} logged in again while this suite dropped it; it stays there\n`,
      );
    }
  } finally {
    await root.close();
  }
}
