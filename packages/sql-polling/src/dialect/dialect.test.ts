import { plainDialect, runDialectConformance } from "../testing/index.ts";

/**
 * The dialect conformance suite on this package's reference dialect, whose SQL takes every branch
 * Postgres's does not: marks kept in `facetdb_table_owners`, columns added after inspecting the
 * catalog, each one marked as it is added (no transactional DDL), `:n` placeholders, `fetch first`,
 * the keyset tie-breaker spelled out. Postgres runs the same suite in `@facetdb/postgres`
 * (polling/dialect.test.ts); CockroachDB and Oracle run it too.
 */
runDialectConformance({
  dialect: plainDialect,
  fixture: new URL("./plain.dialect.sql", import.meta.url),
});
