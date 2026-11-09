import { createHash } from "node:crypto";

/**
 * A state field's value as the connector read it: the database's own text for every type (the text
 * the database would print), or NULL. Numbers and dates never arrive as JS values: a numeric(10,2)
 * 12.50 would hash as "12.5" and a Date as ISO text, both drifting from the database's text.
 */
export type StateValue = string | null;

/**
 * SHA-256 over the state fields alone, in config order, serialized as a JSON array of
 * `[name, text]` pairs, NULL kept as null. Columns outside `fields` never enter it, so FacetDB's
 * own columns and every other column leave it unchanged. The worker writes a decision only when
 * this hash still matches the one it sent to the model; the polling connector and the capture
 * runtime import this function rather than reimplementing it.
 */
export function stateHash(
  fields: readonly string[],
  values: Readonly<Record<string, StateValue>>,
): string {
  const pairs = fields.map((name): [string, string | null] => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`state field "${name}" is missing from the row`);
    }
    return [name, value];
  });
  return createHash("sha256").update(JSON.stringify(pairs), "utf8").digest("hex");
}
