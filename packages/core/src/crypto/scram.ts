import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * A SCRAM-SHA-256 verifier of a worker password (RFC 7677), computed by FacetDB so the plaintext
 * never reaches the server: not as a bind parameter (logged under Postgres's `log_statement =
 * all`), not in the text of a statement (kept in an error's context when the statement fails).
 * Postgres 10 and later store the string as given, and CockroachDB does too
 * (`server.user_login.store_client_pre_hashed_passwords.enabled`, on by default); the login then
 * runs the normal SCRAM exchange against it. One copy for both: the Postgres install
 * (`@facetdb/postgres`) and the CockroachDB dialect (`@facetdb/sql-polling`, which
 * `@facetdb/postgres` imports, so it cannot import that package back).
 *
 * 4096 iterations: Postgres's default, and the least CockroachDB's cost setting accepts.
 */
const ITERATIONS = 4096;

export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  // SASLprep is a no-op for the ASCII passwords FacetDB generates; a caller's own password with
  // characters SASLprep would change is its own responsibility (Postgres applies the same rule).
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
