import type { Sent } from "../install/index.ts";

/**
 * The change stream's pipeline: the server keeps an insert, a replace, and an update that touches a
 * state field, and drops every other change before it reaches the worker, FacetDB's own writes
 * first among them. An update touches a state field when a path it set (`updatedFields`), removed
 * (`removedFields`) or cut short (`truncatedArrays`, MongoDB 5.0 and later) is the field, lies
 * inside it (`address.city` of the state field `address`) or holds it (`address` of the state field
 * `address.city`), an array position in it standing for any element (`statePathPattern`;
 * `$regexMatch` is on the 4.4 floor). A state field is never under `facetdb` (install refuses one),
 * so a write under `facetdb.` matches none, as on Postgres a trigger never fires on FacetDB's own
 * columns. A drop, a rename or an invalidate passes too: the stream ends with it, and the connector
 * says so rather than stop following quietly.
 */

/** The changes after which a collection's stream follows nothing more. */
export const ENDING: ReadonlySet<string> = new Set([
  "drop",
  "rename",
  "dropDatabase",
  "invalidate",
]);

/** Each path an update wrote, removed or truncated, as `$$path` strings. */
const CHANGED_PATHS = {
  $concatArrays: [
    {
      $map: {
        input: { $objectToArray: { $ifNull: ["$updateDescription.updatedFields", {}] } },
        as: "set",
        in: "$$set.k",
      },
    },
    { $ifNull: ["$updateDescription.removedFields", []] },
    {
      $map: {
        input: { $ifNull: ["$updateDescription.truncatedArrays", []] },
        as: "truncated",
        in: "$$truncated.field",
      },
    },
  ],
};

/** A field name as a regular expression matching it literally. */
function literal(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Any number of array positions: `items.0.sku` reaches `items.sku` through element 0. */
const POSITIONS = "(?:\\.\\d+)*";

/**
 * The one pattern a changed path matches when it touches a state field. A state field reads
 * through arrays (keys.ts, `valueAt`: `items.sku` is every element's `sku`), and MongoDB reports a
 * positional change by its index (`items.0.sku` for a `$set`, `items.2` for a `$push`), so an array
 * position anywhere in the path is a wildcard. A path touches a field when it is the field or lies
 * inside it (`items.0.sku`, `items.sku.x`), or holds it (`items`, `items.2`, the parent set or an
 * element pushed whole). Segments match whole, so `price_usd` never touches `price`, and no path
 * under `facetdb` matches: a state field never starts there (install refuses one).
 */
export function statePathPattern(fields: readonly string[]): string {
  const alternatives = fields.map((field) => {
    const segments = field.split(".").map(literal);
    const upTo = (count: number) => segments.slice(0, count).join(`${POSITIONS}\\.`);
    const holders = segments.map((_, index) => upTo(index + 1)).slice(0, -1);
    const whole = upTo(segments.length);
    return [
      `${whole}(?:\\..*)?`,
      ...(holders.length === 0 ? [] : [`(?:${holders.join("|")})${POSITIONS}`]),
    ].join("|");
  });
  return `^(?:${alternatives.join("|")})$`;
}

/** Whether `$$path` is a state field, lies inside one, or holds one, array positions aside. */
function touchesState(fields: readonly string[]): Sent {
  return { $regexMatch: { input: "$$path", regex: statePathPattern(fields) } };
}

/** The pipeline `watch` opens the collection's change stream with. */
export function changePipeline(fields: readonly string[]): readonly Sent[] {
  return [
    {
      $match: {
        $or: [
          { operationType: { $in: ["insert", "replace", ...ENDING] } },
          {
            operationType: "update",
            $expr: {
              $anyElementTrue: [
                { $map: { input: CHANGED_PATHS, as: "path", in: touchesState(fields) } },
              ],
            },
          },
        ],
      },
    },
    // The resume token (`_id`) stays: the driver resumes by it. The document itself never travels.
    { $project: { operationType: 1, documentKey: 1 } },
  ];
}
