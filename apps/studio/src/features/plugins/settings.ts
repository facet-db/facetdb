import type { JsonValue } from "@facetdb/ui";
import type { InstalledPlugin } from "../../api/index.ts";

/**
 * A plugin's settings as the page draws them. The JSON schema the worker sends is read with narrow
 * questions and never trusted: a setting is text, a number, on or off, one of a few choices, a list
 * of text or a map of text, an object's fields each on their own line, or `other`, a shape the form
 * cannot draw, which the page sends to the file with its path and never drops. A setting a plugin
 * marks `z.editable()` (the schema's `"editable": true`, on it or on what holds it) is a control;
 * every other one is text (deny by default).
 */

export type Json = JsonValue;
type Entries = { readonly [key: string]: Json };

/** A place inside a plugin's settings: keys, and positions in a list. */
export type Path = readonly (string | number)[];

/** The plugin host's form of a path (`formatPath`): `token`, `auth.password`, `hooks[0].secret`. */
export function pathText(path: Path): string {
  let text = "";
  for (const step of path) {
    text += typeof step === "number" ? `[${step}]` : text === "" ? step : `.${step}`;
  }
  return text;
}

/** What a setting is drawn as. */
export type Shape =
  | { readonly kind: "text" }
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "choice"; readonly options: readonly string[] }
  | { readonly kind: "list" }
  | { readonly kind: "map" }
  | { readonly kind: "other" };

export type Setting = {
  /** Where it is inside the plugin's settings; empty for settings the worker could not describe. */
  readonly path: Path;
  readonly shape: Shape;
  /** The plugin marks it, or what holds it, `z.editable()`: a draft may change it. */
  readonly editable: boolean;
  /** Its schema, or its list's items or its map's values, carry `z.secret()`'s mark. */
  readonly secret: boolean;
  /** The object holding it lists it as required: taking it out is refused. */
  readonly required: boolean;
  /** What the plugin takes when the file writes nothing here (the schema's `default`). */
  readonly fallback: Json | undefined;
};

const OTHER: Shape = { kind: "other" };

function isEntries(value: unknown): value is Entries {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The variable a value names, as the file writes one (`{ "env": "NAME" }`), or undefined. */
export function variableOf(value: Json | undefined): string | undefined {
  if (!isEntries(value) || Object.keys(value).length !== 1) {
    return undefined;
  }
  const name = value["env"];
  return typeof name === "string" ? name : undefined;
}

/** Whether a value names a variable anywhere inside it: such a value is the file's, never a draft's. */
export function holdsVariable(value: Json | undefined): boolean {
  if (variableOf(value) !== undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(holdsVariable);
  }
  return isEntries(value) && Object.values(value).some(holdsVariable);
}

/** The value at `path`, or undefined where nothing is written. */
export function valueAt(value: Json | undefined, path: Path): Json | undefined {
  let here: Json | undefined = value;
  for (const step of path) {
    if (typeof step === "number") {
      here = Array.isArray(here) ? here[step] : undefined;
    } else {
      here = isEntries(here) ? here[step] : undefined;
    }
  }
  return here;
}

/**
 * `entries` with `value` at a path of keys, made where it is missing; undefined takes the key out.
 * A key keeps its place, and a new one comes last: the file is written in this order, so a diff
 * shows the setting changed and nothing moved.
 */
export function withValue(entries: Entries, path: Path, value: Json | undefined): Entries {
  const [step, ...rest] = path;
  if (step === undefined || typeof step === "number") {
    return entries;
  }
  const here = entries[step];
  const next = rest.length === 0 ? value : withValue(isEntries(here) ? here : {}, rest, value);
  if (next === undefined) {
    return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== step));
  }
  return Object.hasOwn(entries, step)
    ? Object.fromEntries(
        Object.entries(entries).map(([key, item]) => [key, key === step ? next : item]),
      )
    : { ...entries, [step]: next };
}

/** Whether two values are the same JSON. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The one schema a nullable union stands for (`anyOf` with `null`), with the marks of the union. */
function unwrapped(node: Entries): Entries | undefined {
  const { anyOf, oneOf, ...marks } = node;
  const options = anyOf ?? oneOf;
  if (options === undefined) {
    return node;
  }
  if (!Array.isArray(options)) {
    return undefined;
  }
  const others = options.filter((option) => !(isEntries(option) && option["type"] === "null"));
  const [only] = others;
  return others.length === 1 && isEntries(only) ? { ...only, ...marks } : undefined;
}

/** A schema of plain text: a string that is not a choice or a fixed value. */
function isText(node: Json): boolean {
  if (!isEntries(node)) {
    return false;
  }
  const text = unwrapped(node);
  return (
    text !== undefined &&
    text["type"] === "string" &&
    text["enum"] === undefined &&
    text["const"] === undefined
  );
}

/** An object schema with fields of its own: each field is drawn on its own line. */
function fieldsOf(node: Entries): Entries | undefined {
  const properties = node["properties"];
  return isEntries(properties) && Object.keys(properties).length > 0 ? properties : undefined;
}

function shapeOf(node: Entries): Shape {
  const choices = node["enum"];
  const type = node["type"];
  if (choices !== undefined) {
    return Array.isArray(choices) &&
      choices.length > 0 &&
      (type === undefined || type === "string") &&
      choices.every((choice) => typeof choice === "string")
      ? { kind: "choice", options: choices as readonly string[] }
      : OTHER;
  }
  if (node["const"] !== undefined || node["$ref"] !== undefined || node["allOf"] !== undefined) {
    return OTHER;
  }
  switch (type) {
    case "string":
      return { kind: "text" };
    case "number":
      return { kind: "number", integer: false };
    case "integer":
      return { kind: "number", integer: true };
    case "boolean":
      return { kind: "boolean" };
    case "array": {
      const items = node["items"];
      return items !== undefined && isText(items) ? { kind: "list" } : OTHER;
    }
    case "object": {
      const values = node["additionalProperties"];
      return values !== undefined && isText(values) ? { kind: "map" } : OTHER;
    }
    default:
      return OTHER;
  }
}

/** Whether a schema, a list's items or a map's values carry the `"secret": true` of `z.secret()`. */
function marksSecret(node: Entries): boolean {
  const inner = [node["items"], node["additionalProperties"]].filter(isEntries).map(unwrapped);
  return node["secret"] === true || inner.some((part) => part?.["secret"] === true);
}

/** A setting the form cannot draw: its file path is shown instead, never a blank. */
function other(path: Path, editable: boolean, required: boolean): Setting {
  return { path, shape: OTHER, editable, secret: false, required, fallback: undefined };
}

function visit(
  raw: Json,
  value: Json | undefined,
  path: Path,
  inherited: boolean,
  required: boolean,
  settings: Setting[],
): void {
  const node = isEntries(raw) ? unwrapped(raw) : undefined;
  const editable = inherited || (isEntries(raw) && raw["editable"] === true);
  if (node === undefined) {
    settings.push(other(path, editable, required));
    return;
  }
  if (node["type"] === "object" && fieldsOf(node) !== undefined) {
    walk(node, value, path, editable || node["editable"] === true, settings);
    return;
  }
  settings.push({
    path,
    shape: shapeOf(node),
    editable: editable || node["editable"] === true,
    secret: (isEntries(raw) && marksSecret(raw)) || marksSecret(node),
    required,
    fallback: node["default"],
  });
}

/** Each field of an object schema, then each key the file writes that the schema does not declare. */
function walk(
  node: Entries,
  value: Json | undefined,
  path: Path,
  editable: boolean,
  settings: Setting[],
): void {
  const fields = fieldsOf(node) ?? {};
  const required = node["required"];
  for (const [key, field] of Object.entries(fields)) {
    const needed = Array.isArray(required) && required.includes(key);
    visit(field, valueAt(value, [key]), [...path, key], editable, needed, settings);
  }
  if (!isEntries(value)) {
    return;
  }
  const rest = node["additionalProperties"];
  for (const key of Object.keys(value).filter((key) => !Object.hasOwn(fields, key))) {
    if (rest !== undefined && isEntries(rest)) {
      visit(rest, value[key], [...path, key], editable, false, settings);
    } else {
      settings.push(other([...path, key], false, false));
    }
  }
}

/**
 * The settings of a plugin, one line each, in its schema's order and then any the file writes that
 * the schema does not declare. Without a schema every setting the file writes is `other`, and with
 * none written the plugin's settings as a whole are, so nothing is ever left off the page.
 */
export function settingsOf(plugin: InstalledPlugin): readonly Setting[] {
  const { schema, values } = plugin.settings;
  if (schema === null) {
    const keys = Object.keys(values);
    return (keys.length === 0 ? [[]] : keys.map((key) => [key])).map((path) =>
      other(path, false, false),
    );
  }
  const settings: Setting[] = [];
  walk(schema, values, [], schema["editable"] === true, settings);
  return settings;
}

/**
 * Whether a setting is drawn as a control: the plugin marks it editable, the form can draw its
 * shape, its schema marks no secret, and its value names no variable and holds no address cut to
 * its host (all stay the file's: a draft cannot move a variable, and the plugins answer holds no
 * more than the host). The loader already refuses `z.editable()` on a secret; the page does not
 * rely on it.
 */
export function isControl(setting: Setting, plugin: InstalledPlugin): boolean {
  if (!setting.editable || setting.secret || setting.shape.kind === "other") {
    return false;
  }
  const at = pathText(setting.path);
  const cut = plugin.settings.hostOnly.some(
    (path) => path === at || path.startsWith(`${at}.`) || path.startsWith(`${at}[`),
  );
  return !cut && !holdsVariable(valueAt(plugin.settings.values, setting.path));
}

/** Where a setting is written in the file, as Apply and the loader name it: `plugins.discord.embeds`. */
export function filePath(plugin: InstalledPlugin, path: Path): string {
  return pathText(["plugins", plugin.key, ...path]);
}
