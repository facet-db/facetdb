import type { InstalledPlugin, PluginKind } from "../../api/index.ts";

/**
 * The Plugins page's words (a label beats a sentence, each thing said once).
 */

/** The order the kinds are told in, and each one's name for one and for several. */
const KINDS: readonly (readonly [PluginKind, string, string])[] = [
  ["source", "Source", "Sources"],
  ["action", "Action", "Actions"],
  ["channel", "Alert channel", "Alert channels"],
  ["provider", "Model provider", "Model providers"],
  ["pack", "Pack", "Packs"],
];

/** What an installed plugin provides: "Source: issues · Actions: label, comment · Pack: triage". */
export function providesWords(provides: InstalledPlugin["provides"]): string {
  return KINDS.flatMap(([kind, one, several]) => {
    const names = provides[kind];
    return names.length === 0 ? [] : [`${names.length === 1 ? one : several}: ${names.join(", ")}`];
  }).join(" · ");
}

/** The kinds of a registry entry, as one line: "Source, action, question pack". */
export function kindsWords(kinds: readonly PluginKind[]): string {
  const words = KINDS.filter(([kind]) => kinds.includes(kind)).map(([kind, one]) =>
    kind === "pack" ? "question pack" : one.toLowerCase(),
  );
  const line = words.join(", ");
  return line.slice(0, 1).toUpperCase() + line.slice(1);
}

/** The release line of a version, "0.4" of "0.4.0", or null when the worker named none. */
function releaseOf(version: string): string | null {
  if (version === "") {
    return null;
  }
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}`;
}

/** The badge of a plugin whose core range does not hold: "Not made for FacetDB 0.4". */
export function notMadeForWords(facetdb: string): string {
  const release = releaseOf(facetdb);
  return release === null ? "Not made for this FacetDB" : `Not made for FacetDB ${release}`;
}

/** What to do about it, after the range itself. */
export function notMadeForFix(facetdb: string): string {
  const release = releaseOf(facetdb);
  return release === null
    ? "; this project runs another. Install a release made for it, or ask the plugin's author for one."
    : `; this project runs ${facetdb}. Install a release made for ${release}, or ask the plugin's author for one.`;
}

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

/** A line of a list for a screen reader: "the first", then "line 11" past the tenth. */
export function lineWords(index: number): string {
  return ORDINALS[index] === undefined ? `line ${index + 1}` : `the ${ORDINALS[index]}`;
}

/** A count of settings changed: "1 change", "2 changes". */
export function changesWords(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

/** A plugin's short name as the registry and `facetdb add` take it (`definePlugin`'s rule). */
const SHORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The command a gallery entry offers to copy, built here from its name alone and only from a short
 * name, whatever else the answer carried; null when the name is not one, and nothing is offered.
 */
export function addCommand(name: string): string | null {
  return SHORT_NAME.test(name) ? `facetdb add ${name}` : null;
}

/**
 * Why the registry could not be read, in the fewest words: no answer at all (in time, or at all),
 * or what the worker says of it with "the registry" left to the address the page shows beside.
 */
export type RegistryFailure =
  | { readonly kind: "no-answer"; readonly seconds: number | null }
  | { readonly kind: "other"; readonly words: string };

export function registryFailure(why: string): RegistryFailure {
  const late = /^the registry did not answer within (\d+) seconds?\b/.exec(why);
  if (late !== null) {
    return { kind: "no-answer", seconds: Number(late[1]) };
  }
  if (/^the registry could not be reached\b/.test(why)) {
    return { kind: "no-answer", seconds: null };
  }
  const words = why
    .replace(/\.$/, "")
    .replace(/^the registry's /, "its ")
    .replace(/^the registry (?:file|path) /, "it ")
    .replace(/^the registry /, "it ");
  return { kind: "other", words };
}

const grouped = new Intl.NumberFormat("en-US");

/** A download count as the gallery shows it: "4,210". */
export function countWords(count: number): string {
  return grouped.format(count);
}
