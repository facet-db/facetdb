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

/** True when the schema, or the schema it wraps (`optional`, `nullable`, `default`), is a `z.secret()`. */
export function isSecretField(schema: zod.ZodType): boolean {
  let current: zod.ZodType | undefined = schema;
  while (current !== undefined) {
    if (zod.globalRegistry.get(current)?.[SECRET_META] === true) {
      return true;
    }
    const inner: unknown = (current.def as { innerType?: unknown }).innerType;
    current = inner instanceof zod.ZodType ? inner : undefined;
  }
  return false;
}
