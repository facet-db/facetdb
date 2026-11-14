import { runDialectConformance } from "@facetdb/sql-polling/testing";
import { postgresDialect } from "./index.ts";

/**
 * The dialect conformance suite of `@facetdb/sql-polling` on the Postgres dialect: every
 * operation's SQL for the listings example, snapshotted in postgres.dialect.sql and compared byte
 * for byte. The catalog reads and the plans run for real on PGlite in engine.test.ts.
 */
runDialectConformance({
  dialect: postgresDialect,
  fixture: new URL("./postgres.dialect.sql", import.meta.url),
});
