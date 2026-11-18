/**
 * The SCRAM-SHA-256 verifier for `create role … password`, so the plaintext password never reaches
 * the server: not as a bind parameter (logged under `log_statement = all`), not in the `execute
 * format(%L)` text of the role block (kept in an error's context when the statement fails). Core's,
 * shared with the CockroachDB dialect of `@facetdb/sql-polling`, which this package imports and so
 * cannot be imported by.
 */
export { scramVerifier } from "@facetdb/core";
