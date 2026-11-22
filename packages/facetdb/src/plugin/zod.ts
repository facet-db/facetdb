import * as zod from "zod";

/** The `meta` key that marks a config field as a secret. */
const SECRET_META = "secret";

/**
 * `z.secret()`: a non-empty string the plugin needs but that never belongs in the config file. The
 * manifest lists such fields under `secrets`; the dashboard draws them as password inputs and the
 * CLI reads them from the environment. `error` is the refusal when it is missing or empty, in words
 * that name the variable to set (`z.secret({ error: 'write secret: env("MY_SECRET")' })`); the
 * value itself is never part of a refusal the host prints.
 */
function secret(params?: { readonly error?: string }) {
  const error = params?.error;
  return zod
    .string(error === undefined ? undefined : { error })
    .min(1, error)
    .meta({ [SECRET_META]: true });
}

/** The `meta` key that marks a config field as one a studio draft may change. */
const EDITABLE_META = "editable";

/**
 * `z.editable(schema)`: a setting a person signed in to the studio may change through Apply, the
 * diff first. Every setting not marked so is the operator's, edited in facetdb.config.ts by hand.
 * Mark only a setting that can move neither a credential nor a record's data: not an address, a
 * host, a port, a login, an endpoint or anything that decides where the plugin connects or sends. A
 * `z.secret()` is never editable: `definePlugin` and the loader refuse the mark on one, or on
 * anything holding one, and on an object's catchall or one option of a union or an intersection,
 * whose path would also cover settings it does not mark.
 */
function editable<Schema extends zod.ZodType>(schema: Schema): Schema {
  return schema.meta({ [EDITABLE_META]: true });
}

/** zod, plus `z.secret()` and `z.editable()`. Authors import this one so the config schema is a single description. */
export const z = { ...zod, secret, editable };

/** The value type of a config schema: `Infer<typeof config>`. */
export type Infer<Schema extends zod.ZodType> = zod.output<Schema>;

/** One step from a schema to a schema inside it, and how that step reads in a path. */
type Edge = {
  /** `""` for a wrapper (the same value), a key for an object field, `*`, `[]` or `[0]`. */
  readonly step: string;
  /** Whatever the schema holds there; anything that is not a zod schema is a stop, never skipped. */
  readonly schema: unknown;
};

/** Classic and `zod/mini` schemas alike are instances of this core class. */
type Schema = zod.core.$ZodType;

/** What a schema holds: schemas inside it (none for a scalar), or why the walker cannot look inside. */
type Inside = readonly Edge[] | { readonly stop: string };

/** The deepest nesting walked. Real configs are a few levels; a `z.lazy` that builds a new schema on each read never ends. */
const MAX_DEPTH = 100;

/** Schemas that hold no other schema. A `z.secret()` is one of them (a string), and so is every scalar. */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "any",
  "unknown",
  "never",
  "void",
  "date",
  "nan",
  "enum",
  "literal",
  "file",
  "template_literal",
  "custom",
  "transform",
]);

/** Wrappers that hand the same value through in `innerType`. */
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
  "success",
]);

/** The shapes the walker follows, for the message that refuses one it does not know. */
const WALKED_SHAPES =
  "object, array, tuple, record, union (also discriminated), intersection, lazy, and the optional, nullable, default, prefault, nonoptional, readonly, catch, success and pipe (transform, preprocess) wrappers";

const UNKNOWN_SHAPE = `a secret could hide here: this schema has a shape FacetDB cannot look inside; describe the setting with ${WALKED_SHAPES}, or keep a secret out of it`;

function insideOf(schema: Schema): Inside {
  const def = schema._zod.def as unknown as Readonly<Record<string, unknown>>;
  const type = def["type"];
  if (typeof type !== "string") {
    return { stop: UNKNOWN_SHAPE };
  }
  // An absent optional part (no catchall, no rest) is no edge; anything present is one, even if it
  // is not a schema, so that `walk` can refuse it.
  const edge = (step: string, inner: unknown): Edge[] =>
    inner === undefined || inner === null ? [] : [{ step, schema: inner }];
  if (LEAF_TYPES.has(type)) {
    return [];
  }
  if (WRAPPER_TYPES.has(type)) {
    return edge("", def["innerType"]);
  }
  switch (type) {
    case "object": {
      const shape = def["shape"] as Readonly<Record<string, unknown>>;
      return [
        ...Object.entries(shape).map(([key, field]): Edge => ({ step: key, schema: field })),
        ...edge("*", def["catchall"]),
      ];
    }
    case "array":
      return edge("[]", def["element"]);
    case "tuple": {
      const items = def["items"] as readonly unknown[];
      return [
        ...items.map((item, index): Edge => ({ step: `[${index}]`, schema: item })),
        ...edge("[]", def["rest"]),
      ];
    }
    case "record":
      return edge("*", def["valueType"]);
    case "union":
      return (def["options"] as readonly unknown[]).map(
        (option): Edge => ({ step: "", schema: option }),
      );
    case "intersection":
      return [...edge("", def["left"]), ...edge("", def["right"])];
    case "pipe":
      return [...edge("", def["in"]), ...edge("", def["out"])];
    case "lazy":
      try {
        // The cached `innerType`, so the getter runs once per lazy schema, not once per visit.
        const inner: unknown = (schema as zod.ZodLazy)._zod.innerType;
        // zod answers `undefined` for a getter that failed before or that reads its own schema
        // while running: neither can be looked into.
        return inner === undefined
          ? {
              stop: "a secret could hide here: the getter of this z.lazy returned nothing (it failed before, or it reads its own schema while running); make it return its schema",
            }
          : edge("", inner);
      } catch (error) {
        return {
          stop: `a secret could hide here: the getter of this z.lazy threw (${error instanceof Error ? error.message : String(error)}); make it return its schema without failing`,
        };
      }
    default:
      return { stop: UNKNOWN_SHAPE };
  }
}

const NOT_A_SCHEMA =
  "a secret could hide here: this is not a zod schema, so FacetDB cannot look inside it; build the config from `z` of `facetdb/plugin` (zod, zod/mini)";

function isMarkedSecret(schema: Schema): boolean {
  return zod.globalRegistry.get(schema)?.[SECRET_META] === true;
}

/** True when a secret could be inside `schema`: one is, or a shape in it is not known. Each schema is read once. */
function mayHideSecret(schema: unknown, seen: Set<unknown> = new Set()): boolean {
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (!(schema instanceof zod.core.$ZodType)) {
    return true;
  }
  if (isMarkedSecret(schema)) {
    return true;
  }
  const inside = insideOf(schema);
  return "stop" in inside || inside.some((edge) => mayHideSecret(edge.schema, seen));
}

/** A place where the walker could not list the secrets of a schema, and why, in words for the author. */
export type SecretStop = {
  /** The path of the schema (`""` for the config itself). */
  readonly path: string;
  readonly message: string;
};

/** Thrown by `secretPaths` where a secret could hide beyond what the walker follows. */
export class SecretWalkError extends Error {
  readonly stops: readonly SecretStop[];

  constructor(stops: readonly SecretStop[]) {
    super(
      stops.map((stop) => `${stop.path === "" ? "config" : stop.path}: ${stop.message}`).join("; "),
    );
    this.name = "SecretWalkError";
    this.stops = stops;
  }
}

function joined(path: string, step: string): string {
  if (step === "") {
    return path;
  }
  return step.startsWith("[") || path === "" ? `${path}${step}` : `${path}.${step}`;
}

/**
 * The paths of every `z.secret()` in an object schema. A path is the keys joined by dots, with `[]`
 * for the elements of an array (`[0]` for a tuple slot, `[]` for its rest) and `*` for the values
 * of a record: `token`, `auth.password`, `hooks[].secret`, `headers.*`. Wrappers, unions and
 * intersections add nothing to a path, so a secret in two variants is listed once.
 *
 * Throws `SecretWalkError` where a secret could hide beyond what the walker follows (a schema of an
 * unknown shape, or a recursive `z.lazy` that holds a secret, whose paths would never end), so a
 * secret is never left off the list in silence.
 */
export function secretPaths(schema: zod.ZodObject): readonly string[] {
  const paths = new Set<string>();
  const stops: SecretStop[] = [];
  // The schemas on the way down from the root: meeting one of them again is a recursive schema.
  const ancestors = new Set<unknown>();

  const walk = (current: unknown, path: string): void => {
    if (!(current instanceof zod.core.$ZodType)) {
      stops.push({ path, message: NOT_A_SCHEMA });
      return;
    }
    if (isMarkedSecret(current)) {
      paths.add(path);
      return;
    }
    if (ancestors.has(current)) {
      if (mayHideSecret(current)) {
        stops.push({
          path,
          message:
            "this schema contains itself (z.lazy) and holds a z.secret(), so its secret paths never end; take the secret out of the recursive part, or flatten the schema",
        });
      }
      return;
    }
    if (ancestors.size >= MAX_DEPTH) {
      stops.push({
        path,
        message: `this schema nests more than ${MAX_DEPTH} levels deep, or a z.lazy builds a new schema each time it is read, so its secrets cannot be listed; make the z.lazy return the same schema every time, or flatten it`,
      });
      return;
    }
    const inside = insideOf(current);
    if ("stop" in inside) {
      stops.push({ path, message: inside.stop });
      return;
    }
    ancestors.add(current);
    for (const edge of inside) {
      walk(edge.schema, joined(path, edge.step));
    }
    ancestors.delete(current);
  };

  walk(schema, "");
  if (stops.length > 0) {
    throw new SecretWalkError(stops);
  }
  return [...paths];
}

function isMarkedEditable(schema: Schema): boolean {
  return zod.globalRegistry.get(schema)?.[EDITABLE_META] === true;
}

/** Why a `z.editable()` is refused where it is: it is a secret, or a secret could be inside it. */
const EDITABLE_SECRET =
  "a z.editable() setting is a z.secret(), holds one, or has a shape a secret could hide in: a secret is never a draft's to change; take z.editable() off it, or the secret out of it";

/**
 * Why a `z.editable()` is refused at or under an object's catchall: its path is `*`, which covers
 * every key at that level, the ones the object declares among them.
 */
const EDITABLE_CATCHALL =
  "a z.editable() on an object's catchall, or inside it, would cover every key at that level, the ones the object declares among them (an address or a login could be one); mark each declared key, or keep the person's own keys in a z.record()";

/**
 * Why a `z.editable()` is refused at or under one option of a union or an intersection: an option
 * adds nothing to a path, so the mark would cover the same place in every other option too.
 */
const EDITABLE_OPTION =
  "a z.editable() inside one option of a union or an intersection would cover the same place in every other option (an address or a login could be there); mark the whole union or intersection, or nothing in it";

/** The settings a draft may change, and each `z.editable()` refused where it stands. */
export type EditableSettings = {
  /** In `secretPaths`' form: `labels`, `limits.perMinute`, `teams.*`. Everything under one is editable. */
  readonly paths: readonly string[];
  /** A mark on a secret, or on what could hold one: the plugin cannot be used until it is taken off. */
  readonly refused: readonly SecretStop[];
};

/**
 * The paths of every `z.editable()` in an object schema, as `secretPaths` writes a path; a mark
 * covers everything under it, so the walk stops there. A mark is listed as refused instead where
 * its path would reach further than the setting it marks: on a `z.secret()`, or on a part that
 * holds one or has a shape the walker cannot look inside; at or under an object's catchall (`*`
 * covers the declared keys too); at or under one option of a union or an intersection (an option
 * adds nothing to the path). The plugin is refused at definition and at load for any of them, so a
 * draft never reaches a secret, an address or a login through a mark.
 */
export function editablePaths(schema: zod.ZodObject): EditableSettings {
  const paths = new Set<string>();
  const refused: SecretStop[] = [];
  const ancestors = new Set<unknown>();
  /** `under`: the refusal a mark here meets, from the catchall or the option on the way down. */
  const walk = (current: unknown, path: string, under: string | undefined): void => {
    // A shape the walker cannot follow holds no mark it can see; `secretPaths` refuses it if it
    // could hide a secret, and a setting inside it is then no draft's to change.
    if (!(current instanceof zod.core.$ZodType) || ancestors.has(current)) {
      return;
    }
    if (isMarkedEditable(current)) {
      if (under !== undefined) {
        refused.push({ path, message: under });
      } else if (mayHideSecret(current)) {
        refused.push({ path, message: EDITABLE_SECRET });
      } else {
        paths.add(path);
      }
      return;
    }
    if (isMarkedSecret(current) || ancestors.size >= MAX_DEPTH) {
      return;
    }
    const inside = insideOf(current);
    if ("stop" in inside) {
      return;
    }
    const def = current._zod.def as unknown as Readonly<Record<string, unknown>>;
    const options = def["type"] === "union" || def["type"] === "intersection";
    ancestors.add(current);
    for (const edge of inside) {
      const catchall = def["type"] === "object" && edge.schema === def["catchall"];
      const next = catchall ? EDITABLE_CATCHALL : options ? EDITABLE_OPTION : undefined;
      walk(edge.schema, joined(path, edge.step), under ?? next);
    }
    ancestors.delete(current);
  };
  walk(schema, "", undefined);
  return { paths: [...paths], refused };
}
