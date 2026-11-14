// The Postgres dialect of the polling connector, whose connector and engine are
// `@facetdb/sql-polling`'s. Only the dialect is exported here, and it imports that package for its
// types alone: loading this package never loads the polling engine.
export { createPostgresDialect, type PostgresDialectOptions, postgresDialect } from "./dialect.ts";
