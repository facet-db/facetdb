import { quoteIdent, quoteLiteral } from "../sql/index.ts";

/**
 * Core's `stateHash`, as a SQL expression: SHA-256 over the JSON array of `[name, text]` pairs, in
 * config order, NULL kept as `null` (packages/core/src/records/state-hash.ts). `to_json(text)`
 * escapes exactly as `JSON.stringify` does for a string (quote, backslash, control characters as
 * lowercase `\u00xx`, nothing else); the array is assembled by hand because Postgres' own array
 * text puts a space after each comma and JavaScript's does not. With it, `write` is one `update …
 * where key = $1 and <this> = $2`: the database checks the hash on the row it locks, so no row is
 * held across a round trip and the worker needs no lock privilege on the source table.
 */
export function stateHashSql(fields: readonly string[], alias: string): string {
  const pairs = fields.map(
    (field) =>
      `'[' || ${quoteLiteral(JSON.stringify(field))} || ',' || coalesce(to_json(${alias}.${quoteIdent(field)}::text)::text, 'null') || ']'`,
  );
  const array = `'[' || ${pairs.length === 0 ? "''" : pairs.join(" || ',' || ")} || ']'`;
  return `encode(sha256(convert_to(${array}, 'UTF8')), 'hex')`;
}
