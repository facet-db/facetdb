import type { RecordKey, StateValue } from "@facetdb/core";
import { ObjectId } from "mongodb";

/**
 * A document's `_id` as a record key, and its state fields as the text core hashes.
 *
 * Keys. A key is text with a type tag, so a key never names two documents: `oid:<24 hex>` for an
 * ObjectId, `n:<number>` for a number, and a string as itself. A string that would read as a tag
 * (`oid:…`, `n:…`, `s:…`) is written `s:<string>`, the one escape, so `"oid:x"` and the ObjectId
 * never meet. Strings go bare, not always tagged, because a string `_id` is what an application
 * shows its people and what they type back (`facetdb explain listing-42`), and because the
 * connector contract suite queues its own plain keys (`record-000`), which a connector must read
 * back as the documents the application stored under them. Every key maps back to one `_id`
 * only in its one written form: `n:042` and `s:abc` name no document, so two texts of one document
 * never sit in the queue as two jobs. Other `_id` types (a Date, a Decimal128, an embedded
 * document, a number past 2^53) have no key: the connector says so instead of asking about them.
 *
 * State. `stateHash` hashes text (or NULL) per field, so each field's value becomes the text the
 * model reads: a string as itself, a number, a boolean, a Date as ISO 8601, an ObjectId as its hex,
 * a Decimal128 or a Long as its digits, and an array or an embedded document as canonical JSON
 * (those same rules inside, every object's keys in code-point order), so two reads of one value
 * hash alike whatever order the driver gave its keys in. A missing field is NULL, as a NULL column
 * is.
 */

/** The tags, as written before the value. */
const OBJECT_ID = "oid:";
const NUMBER = "n:";
const STRING = "s:";

const TAGGED = /^(?:oid|n|s):/;
const HEX = /^[0-9a-f]{24}$/;

/** A key's `_id` once read back: the value to query by. */
export type DocumentId = ObjectId | string | number;

/** A BSON value as the driver hands it out: its class names itself in `_bsontype`. */
function bsonType(value: object): string | undefined {
  const type: unknown = Reflect.get(value, "_bsontype");
  return typeof type === "string" ? type : undefined;
}

/** A number as `n:` writes it: integers and floats as JavaScript prints them, never NaN or infinite. */
function numberText(value: number): string | undefined {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? String(Object.is(value, -0) ? 0 : value)
    : undefined;
}

/** The record key of a document's `_id`, or undefined for an `_id` type that has none. */
export function keyOf(id: unknown): RecordKey | undefined {
  if (typeof id === "string") {
    return TAGGED.test(id) ? `${STRING}${id}` : id;
  }
  if (typeof id === "number") {
    const text = numberText(id);
    return text === undefined ? undefined : `${NUMBER}${text}`;
  }
  if (typeof id === "object" && id !== null) {
    switch (bsonType(id)) {
      case "ObjectId":
        return id instanceof ObjectId ? `${OBJECT_ID}${id.toHexString()}` : undefined;
      // Driver options that keep numbers wrapped (`promoteValues: false`) hand these out.
      case "Int32":
      case "Double": {
        const value: unknown = id.valueOf();
        return typeof value === "number" ? keyOf(value) : undefined;
      }
      case "Long": {
        const value = Number(String(id));
        return Number.isSafeInteger(value) ? keyOf(value) : undefined;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * The `_id` a key names, or undefined when no document can have it: a key of another engine, a
 * form `keyOf` never writes, or plain text the caller made up. Undefined is the boundary's answer
 * for a key that names no document (`read` reports it missing, `current` leaves it out).
 */
export function idOf(key: RecordKey): DocumentId | undefined {
  let id: DocumentId | undefined;
  if (key.startsWith(OBJECT_ID)) {
    const hex = key.slice(OBJECT_ID.length);
    id = HEX.test(hex) ? new ObjectId(hex) : undefined;
  } else if (key.startsWith(NUMBER)) {
    const text = key.slice(NUMBER.length);
    const value = text.trim() === "" ? Number.NaN : Number(text);
    id = Number.isFinite(value) ? value : undefined;
  } else if (key.startsWith(STRING)) {
    id = key.slice(STRING.length);
  } else {
    id = key;
  }
  // Only the one written form: `n:042`, `s:abc` and an uppercase hex name no document.
  return id !== undefined && keyOf(id) === key ? id : undefined;
}

/**
 * Keys on the terminal. The tagged key above is the store's and the queue's; a person reads and
 * types the `_id` itself: `facetdb explain listings 65f1a2b3c4d5e6f708192a3b` for an ObjectId,
 * `facetdb explain listings 1` for a number, `listing-42` for a string. The install's marker does
 * not record a collection's `_id` type, so the text alone decides, by one rule: 24 hex characters
 * are an ObjectId, a number in its own form (`1`, `-2.5`, never `042` or `1.50`) is a number,
 * anything else is a string. A string `_id` that the rule would read as an ObjectId or a number
 * (`"1"`, a 24-hex string) prints with the one escape, `s:1`, so whatever FacetDB prints reads back
 * as the document it named. The tagged form typed as written still works (`oid:…`, `n:1`, `s:…`),
 * so a script written before this keeps finding its records.
 */

/**
 * A number as typed: an optional minus, an integer part without a leading zero, a fraction, and the
 * negative exponent JavaScript prints below 1e-6 (`1e-7`, `5e-324`). A positive exponent never
 * appears: JavaScript prints one only from 1e21, past the 2^53 a key's number stays within.
 */
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e-[0-9]+)?$/;
/** 24 hex characters as typed, either case: an ObjectId's hex. */
const TYPED_HEX = /^[0-9a-f]{24}$/i;

/** A string `_id`'s key: itself, or `s:` before it when it would read as a tag. */
function stringKey(id: string): RecordKey {
  return TAGGED.test(id) ? `${STRING}${id}` : id;
}

/**
 * The key a user's text names, by the rule above: 24 hex characters an ObjectId, a number in its
 * own form a number, anything else a string; a tagged key that names a document as written
 * (`oid:<hex>`, `n:1`), and `s:<string>` the string after it. A tag-like text that names no
 * document (`n:042`, `oid:x`) is the string it spells, as `keyOf` keys that string.
 */
export function keyFromText(text: string): RecordKey {
  if (text.startsWith(STRING)) {
    return stringKey(text.slice(STRING.length));
  }
  if (TAGGED.test(text)) {
    return idOf(text) === undefined ? stringKey(text) : text;
  }
  if (TYPED_HEX.test(text)) {
    return `${OBJECT_ID}${text.toLowerCase()}`;
  }
  if (DECIMAL.test(text) && numberText(Number(text)) === text) {
    return `${NUMBER}${text}`;
  }
  return text;
}

/**
 * A key as its user writes the `_id`: an ObjectId's 24 hex characters, a number's digits, a string
 * itself, or `s:<string>` for a string `keyFromText` would read as something else, so
 * `keyFromText(keyToText(key))` is `key` for every key `keyOf` writes. The empty string prints as
 * `s:`, so a log line never ends on nothing. A text in no written form (no connector hands one
 * out) is shown as it is.
 */
export function keyToText(key: RecordKey): string {
  const id = idOf(key);
  if (id === undefined) {
    return key;
  }
  if (id instanceof ObjectId) {
    return id.toHexString();
  }
  if (typeof id === "number") {
    return key.slice(NUMBER.length);
  }
  return id !== "" && keyFromText(id) === key ? id : `${STRING}${id}`;
}

/** A value as canonical JSON's value: the rules of `stateText`, inside an array or a document. */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      throw new Error(`a state field holds a ${typeof value}, which MongoDB does not store`);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const type = bsonType(value);
  if (type !== undefined) {
    return bsonText(value, type);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(Reflect.get(value, key))]),
  );
}

/** A BSON value of the driver's own classes as text. */
function bsonText(value: object, type: string): string | number {
  switch (type) {
    case "ObjectId":
      return value instanceof ObjectId ? value.toHexString() : String(value);
    case "Int32":
    case "Double": {
      const inner: unknown = value.valueOf();
      return typeof inner === "number" && Number.isFinite(inner) ? inner : String(inner);
    }
    case "Binary": {
      const toText: unknown = Reflect.get(value, "toString");
      return typeof toText === "function" ? String(toText.call(value, "base64")) : String(value);
    }
    case "BSONRegExp":
      return `/${String(Reflect.get(value, "pattern"))}/${String(Reflect.get(value, "options"))}`;
    case "BSONSymbol":
      return String(Reflect.get(value, "value"));
    case "Code":
      return String(Reflect.get(value, "code"));
    // Decimal128 and Long print their digits; Timestamp its 64-bit value; MinKey and MaxKey
    // their names.
    case "MinKey":
    case "MaxKey":
      return type;
    default:
      return String(value);
  }
}

/**
 * A state field's value as the text `stateHash` and the model read: NULL for a missing field or a
 * null, the string itself, and anything else as canonical JSON's text (a number's digits, `true`,
 * an ISO date, an ObjectId's hex, a Decimal128's digits, an array or a document as JSON).
 */
export function stateText(value: unknown): StateValue {
  const plain = canonical(value);
  if (plain === null) {
    return null;
  }
  return typeof plain === "string" ? plain : JSON.stringify(plain);
}

/**
 * The value at a dotted path (`address.city`) of a document as the driver returned it, MongoDB's
 * way: through an array, the path reaches into each element (`items.sku` of `{ items: [{ sku: 1 },
 * { sku: 2 }] }` is `[1, 2]`); undefined where nothing is there.
 */
export function valueAt(document: unknown, path: readonly string[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return document;
  }
  if (Array.isArray(document)) {
    const found = document
      .map((element) => valueAt(element, path))
      .filter((value) => value !== undefined);
    return found.length === 0 ? undefined : found;
  }
  if (typeof document !== "object" || document === null || bsonType(document) !== undefined) {
    return undefined;
  }
  return valueAt(Reflect.get(document, head), rest);
}

/** The state each field holds in a document, by the field's dotted path. */
export function stateOf(
  document: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, StateValue> {
  return Object.fromEntries(
    fields.map((field) => [field, stateText(valueAt(document, field.split(".")))]),
  );
}

/**
 * The projection that reads these fields: their first segments, so `address` and `address.city`
 * never collide in one projection (MongoDB refuses that), and `valueAt` walks the rest.
 */
export function stateProjection(fields: readonly string[]): Record<string, 1> {
  return Object.fromEntries(fields.map((field) => [field.split(".")[0] ?? field, 1 as const]));
}
