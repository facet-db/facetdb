// Any JSON value: what a record's state fields hold and what a log entry carries.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type KvProps = {
  // An object lays out as key and value lines; any other value as the one line it is.
  value: JsonValue;
};

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One value: text wraps (and keeps its own line breaks), figures and flags sit in the measured
// face, and a nested object or list lays out again. Each kind of nothing has its own words, in the
// muted role, so no two read alike and none reads like the literal text "empty": null is "no
// value", an empty string "blank text", an empty object "no fields", an empty list "no items".
function Value({ value }: { value: JsonValue }) {
  if (value === null) return <span className="fdb-kv-empty">no value</span>;
  if (typeof value === "string") {
    return value === "" ? <span className="fdb-kv-empty">blank text</span> : <>{value}</>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="fdb-kv-measured">{String(value)}</span>;
  }
  if (isObject(value)) {
    return Object.keys(value).length === 0 ? (
      <span className="fdb-kv-empty">no fields</span>
    ) : (
      <Kv value={value} />
    );
  }
  if (value.length === 0) return <span className="fdb-kv-empty">no items</span>;
  return (
    <ul className="fdb-kv-items">
      {value.map((item, index) => (
        // A list has no identity of its own besides its order.
        // biome-ignore lint/suspicious/noArrayIndexKey: JSON array items are identified by position
        <li key={index}>
          <Value value={item} />
        </li>
      ))}
    </ul>
  );
}

// Key and value lines for laid-out JSON (JSON is never shown raw): the state fields on the review
// card, an entry's payload in the log, a channel's settings. A description list, so a screen reader
// reads each key with its value.
export function Kv({ value }: KvProps) {
  if (!isObject(value)) return <Value value={value} />;
  return (
    <dl className="fdb-kv">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <Value value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
