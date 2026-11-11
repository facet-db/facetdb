import * as zod from "zod";

/** The `meta` key that marks a config field as a secret. */
const SECRET_META = "secret";

/**
 * `z.secret()`: a non-empty string the plugin needs but that never belongs in the config file. The
 * manifest lists such fields under `secrets`; the dashboard draws them as password inputs and the
 * CLI reads them from the environment.
 */
function secret() {
  return zod
    .string()
    .min(1)
    .meta({ [SECRET_META]: true });
}

/** zod, plus `z.secret()`. Authors import this one so the config schema is a single description. */
export const z = { ...zod, secret };

/** The value type of a config schema: `Infer<typeof config>`. */
export type Infer<Schema extends zod.ZodType> = zod.output<Schema>;

/** The schemas a wrapper (`optional`, `nullable`, `default`, `pipe`, `transform`, effects) hands through. */
function wrapped(schema: zod.ZodType): readonly zod.ZodType[] {
  const def = schema.def as { innerType?: unknown; in?: unknown; out?: unknown; schema?: unknown };
  return [def.innerType, def.in, def.out, def.schema].filter(
    (inner): inner is zod.ZodType => inner instanceof zod.ZodType,
  );
}

/** The schema and every schema reachable through wrappers, each once. */
function unwrapped(schema: zod.ZodType): readonly zod.ZodType[] {
  const seen = new Set<zod.ZodType>();
  const pending = [schema];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!seen.has(current)) {
      seen.add(current);
      pending.push(...wrapped(current));
    }
  }
  return [...seen];
}

/** True when the schema, or a schema it wraps (`optional`, `nullable`, `default`, `pipe`, effects), is a `z.secret()`. */
function isSecretField(schema: zod.ZodType): boolean {
  return unwrapped(schema).some((inner) => zod.globalRegistry.get(inner)?.[SECRET_META] === true);
}

/**
 * The dotted paths of every `z.secret()` in an object schema, found through wrappers and nested
 * objects: `token`, `auth.password`.
 */
export function secretPaths(schema: zod.ZodObject, prefix = ""): readonly string[] {
  return Object.entries(schema.shape as Record<string, zod.ZodType>).flatMap(([key, field]) => {
    const path = `${prefix}${key}`;
    if (isSecretField(field)) {
      return [path];
    }
    return unwrapped(field)
      .filter((inner): inner is zod.ZodObject => inner instanceof zod.ZodObject)
      .flatMap((object) => secretPaths(object, `${path}.`));
  });
}
