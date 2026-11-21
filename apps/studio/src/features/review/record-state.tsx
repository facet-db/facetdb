import { type JsonValue, Kv, ScrollRegion } from "@facetdb/ui";
import type { ReviewCard } from "../../api/index.ts";

/**
 * A record's state laid out for reading. The text is the customer's: it reaches the page as text
 * nodes and nowhere else, never as markup.
 */

/** Whether `value`, parsed from a customer's text, is JSON all the way down. */
function asJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    const items: JsonValue[] = [];
    for (const item of list) {
      const json = asJson(item);
      if (json === undefined) {
        return undefined;
      }
      items.push(json);
    }
    return items;
  }
  if (typeof value === "object") {
    const fields: Record<string, JsonValue> = {};
    for (const [name, item] of Object.entries(value)) {
      const json = asJson(item);
      if (json === undefined) {
        return undefined;
      }
      fields[name] = json;
    }
    return fields;
  }
  return undefined;
}

/**
 * A state field's value: a column holding a JSON object or list lays out as key and value lines,
 * anything else (a number written as text included) stays the text it is.
 */
export function fieldValue(text: string | null): JsonValue {
  if (text === null) {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const json = asJson(parsed);
      if (json !== undefined) {
        return json;
      }
    } catch {
      // Not JSON after all (a sentence that opens with a bracket): it is shown as the text it is.
    }
  }
  return text;
}

/**
 * The state as key and value lines. The region scrolls when the record is long and takes the focus,
 * so a keyboard can scroll it; it is the first stop of the card in reading order.
 */
export function RecordState({ state }: { readonly state: ReviewCard["state"] }) {
  const fields = Object.fromEntries(
    Object.entries(state).map(([name, text]) => [name, fieldValue(text)]),
  );
  return (
    <ScrollRegion aria-label="The record" frameClassName="mt-5.5" className="max-h-[32rem]">
      <Kv value={fields} />
    </ScrollRegion>
  );
}
