import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * A SCRAM-SHA-256 verifier for `create role … password`, computed here so the plaintext password
 * never reaches the server: not as a bind parameter (logged under `log_statement = all`), not in
 * the `execute format(%L)` text of the role block (kept in an error's context when the statement
 * fails). Postgres 10 and later store the string as given; the login then runs the normal
 * SCRAM exchange against it (RFC 7677, `password_encryption = scram-sha-256`).
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
