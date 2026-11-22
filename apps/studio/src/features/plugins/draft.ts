import {
  type Json,
  type Path,
  pathText,
  type Setting,
  same,
  valueAt,
  withValue,
} from "./settings.ts";

/**
 * A plugin's settings as the form changes them: the changes alone, by the setting's path, over the
 * values the worker sent. What Apply sends is those values with each change in place, the whole
 * entry (a draft replaces a plugin's settings whole, and only what the plugin marks editable may
 * differ), so every variable stays where the file writes it.
 */

type Entries = { readonly [key: string]: Json };

/** The changes, by `pathText`: each setting's new value, undefined where it is taken out. */
export type Edits = ReadonlyMap<string, { readonly path: Path; readonly value: Json | undefined }>;

export const NO_EDITS: Edits = new Map();

/** What a setting holds now: its change, else what the file writes. */
export function currentValue(values: Entries, edits: Edits, path: Path): Json | undefined {
  const edit = edits.get(pathText(path));
  return edit === undefined ? valueAt(values, path) : edit.value;
}

/**
 * `edits` with `setting` set to `next`. Back to what the file writes, or to the plugin's own
 * default where the file writes nothing, is no change at all: Apply would show an empty diff.
 */
export function edited(
  edits: Edits,
  values: Entries,
  setting: Setting,
  next: Json | undefined,
): Edits {
  const key = pathText(setting.path);
  const original = valueAt(values, setting.path);
  const unchanged =
    same(next, original) ||
    (original === undefined && (next === undefined || same(next, setting.fallback)));
  const result = new Map(edits);
  if (unchanged) {
    result.delete(key);
  } else {
    result.set(key, { path: setting.path, value: next });
  }
  return result;
}

/** The plugin's whole settings with every change in place: the draft's entry for it. */
export function draftOf(values: Entries, edits: Edits): Entries {
  let draft = values;
  for (const { path, value } of edits.values()) {
    draft = withValue(draft, path, value);
  }
  return draft;
}
