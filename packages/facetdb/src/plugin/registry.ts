import { PLUGIN_KINDS } from "@facetdb/core";
import * as zod from "zod";
import { packageNames, shortName } from "./define.ts";
import { isValidRange } from "./semver.ts";

/**
 * The plugin registry's index: one JSON file generated from a folder of entry files, one file per
 * listed plugin. The entry schema below is the only description of an entry; the generator checks
 * entry files with it and the reader checks the index with it.
 */

/** The longest description an entry may have, in characters. */
export const MAX_DESCRIPTION = 160;

/**
 * The format of the index file. A reader that knows format 1 refuses any other with a message that
 * says to upgrade, so a field added to a later format never reaches a reader that would drop it or
 * fail on it by accident. Within a format the fields are exactly the ones below.
 */
export const REGISTRY_FORMAT = 1;

/** Control characters (a terminal reads them as commands) and the marks that reverse text direction. */
const CONTROL_OR_DIRECTION = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

const NO_CONTROL_TEXT = {
  error:
    "must not contain control characters or characters that change the direction of the text: it is printed in a terminal",
};

/** What a schema field says when it is absent or of the wrong type, in words for the entry's author. */
function expected(what: string) {
  return (issue: { readonly input?: unknown }) =>
    issue.input === undefined ? "is missing" : `must be ${what}`;
}

const entryFields = {
  /** The short name `facetdb add` takes: `github`. */
  name: zod.string({ error: expected("text") }).refine((name) => shortName(name) === name, {
    error:
      'must be the short name, in lowercase letters, digits and dashes, without a prefix: "github", not "@facetdb/github"',
  }),
  /** The npm package that holds it. */
  package: zod.string({ error: expected("text") }),
  description: zod
    .string({ error: expected("text") })
    .trim()
    .min(1, { error: "is empty: say in one line what the plugin does" })
    .max(MAX_DESCRIPTION, {
      error: `must be at most ${MAX_DESCRIPTION} characters; keep the longer text for the plugin's own page`,
    })
    .refine((text) => !CONTROL_OR_DIRECTION.test(text), NO_CONTROL_TEXT),
  /** What it provides: the plugin kinds of core. */
  kinds: zod
    .array(
      zod.enum(PLUGIN_KINDS, {
        error: (issue) =>
          issue.input === undefined
            ? "is missing"
            : `must be one of ${PLUGIN_KINDS.join(", ")}, in each place`,
      }),
      { error: expected("a list of kinds") },
    )
    .min(1, { error: "must name at least one kind the plugin provides" }),
  /** The range of FacetDB core versions the plugin supports. */
  facetdb: zod.string({ error: expected("text") }).refine(isValidRange, {
    error: 'must be a semver range of FacetDB core versions, such as "^1.0.0" or ">=1.2.0 <2.0.0"',
  }),
  /** Set by hand in a pull request, after the FacetDB team has reviewed the plugin. */
  verified: zod.boolean({ error: expected("true or false") }),
  homepage: zod
    .url({ protocol: /^https?$/, error: "must be a web address starting with http:// or https://" })
    .refine((text) => !CONTROL_OR_DIRECTION.test(text), NO_CONTROL_TEXT)
    .optional(),
};

type EntryRules = {
  readonly name: string;
  readonly package: string;
  readonly kinds: readonly string[];
};

/** The rules that look at more than one field of an entry. */
function checkEntry(entry: EntryRules, ctx: zod.RefinementCtx): void {
  if (shortName(entry.name) === entry.name && !packageNames(entry.name).includes(entry.package)) {
    ctx.addIssue({
      code: "custom",
      path: ["package"],
      message: `must be ${packageNames(entry.name)
        .map((name) => `"${name}"`)
        .join(
          " or ",
        )} for the name "${entry.name}": \`facetdb add ${entry.name}\` looks for those two`,
    });
  }
  if (new Set(entry.kinds).size !== entry.kinds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["kinds"],
      message: "names a kind twice",
    });
  }
}

/** One entry file of the registry's `plugins/` folder. */
const entrySchema = zod.strictObject(entryFields).superRefine(checkEntry);

/** An entry as listed in the index: the entry file plus npm's download figure. */
const listedSchema = zod
  .strictObject({
    ...entryFields,
    downloads: zod
      .number({ error: expected("a whole number") })
      .int({ error: "must be a whole number" })
      .nonnegative({ error: "must be zero or more" }),
  })
  .superRefine(checkEntry);

const indexSchema = zod
  .strictObject({
    /** The format of this file; the first key, so a reader finds it before anything else. */
    format: zod.literal(REGISTRY_FORMAT, {
      error: (issue) =>
        issue.input === undefined
          ? "is missing"
          : `must be ${REGISTRY_FORMAT}, the format this facetdb reads`,
    }),
    /** When the index last changed (the build keeps it while nothing else does), as an ISO 8601 UTC time. */
    generatedAt: zod.iso.datetime({
      error: "must be an ISO 8601 date and time, such as 2026-11-13T09:00:00.000Z",
    }),
    /** Every listed plugin, sorted by name. */
    plugins: zod.array(listedSchema, { error: expected("a list of plugins") }),
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    index.plugins.forEach((plugin, position) => {
      if (seen.has(plugin.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", position, "name"],
          message: `"${plugin.name}" is listed twice`,
        });
      }
      seen.add(plugin.name);
    });
  });

export type RegistryEntry = zod.output<typeof entrySchema>;
export type RegistryListing = zod.output<typeof listedSchema>;
export type RegistryIndex = zod.output<typeof indexSchema>;

/** The registry cannot be generated or read. Every problem is a line: the file, then what is wrong. */
export class RegistryError extends Error {
  readonly problems: readonly string[];

  constructor(subject: string, problems: readonly string[]) {
    super([`${subject}:`, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
    this.name = "RegistryError";
    this.problems = problems;
  }
}

/** A path in an issue as a field name: `kinds[1]`, `plugins[0].name`. */
function fieldOf(path: readonly PropertyKey[]): string {
  let field = "";
  for (const step of path) {
    field +=
      typeof step === "number" ? `[${step}]` : field === "" ? String(step) : `.${String(step)}`;
  }
  return field;
}

const ENTRY_FIELDS = Object.keys(entryFields);
const LISTING_FIELDS = [...ENTRY_FIELDS, "downloads"];
const INDEX_FIELDS = ["format", "generatedAt", "plugins"];

/** The issues of a failed parse as lines of "<where> <what is wrong>", in plain words. */
function problemsOf(
  error: zod.ZodError,
  where: string,
  fieldsAt: (path: readonly PropertyKey[]) => readonly string[],
): readonly string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const field = fieldOf(issue.path);
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((key) => `"${key}"`).join(", ");
      lines.push(
        `${where}${field === "" ? "" : `: ${field}`}: unknown ${issue.keys.length === 1 ? "field" : "fields"} ${keys}; the fields are ${fieldsAt(issue.path).join(", ")}`,
      );
    } else if (field === "") {
      lines.push(`${where}: ${issue.message}`);
    } else {
      lines.push(`${where}: ${field} ${issue.message}`);
    }
  }
  return lines;
}

/** An entry file as read from the folder: its path (for messages) and its text. */
export type RegistryEntryFile = {
  readonly file: string;
  readonly text: string;
};

export type RegistryBuildOptions = {
  /** npm's download figure for a package; 0 for one npm does not know. Rejects when it cannot be read. */
  readonly downloadsOf: (packageName: string) => Promise<number>;
  readonly now: () => Date;
};

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The index of a set of entry files: every file is checked first (a bad one stops the generation,
 * naming the file and the reason, and nothing is asked of npm), then each package's downloads are
 * read, one request at a time, and the entries come out sorted by name so that a regeneration with
 * no change is no diff.
 */
export async function buildRegistryIndex(
  files: readonly RegistryEntryFile[],
  options: RegistryBuildOptions,
): Promise<RegistryIndex> {
  const problems: string[] = [];
  const entries: { readonly file: string; readonly entry: RegistryEntry }[] = [];
  const fileOfName = new Map<string, string>();
  for (const { file, text } of files) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      problems.push(
        `${file}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const parsed = entrySchema.safeParse(json);
    if (!parsed.success) {
      problems.push(...problemsOf(parsed.error, file, () => ENTRY_FIELDS));
      continue;
    }
    const expectedFile = `${parsed.data.name}.json`;
    if (file.split("/").at(-1) !== expectedFile) {
      problems.push(
        `${file}: the file must be named ${expectedFile}, after the entry's name "${parsed.data.name}" (plugins/${expectedFile})`,
      );
      continue;
    }
    const first = fileOfName.get(parsed.data.name);
    if (first !== undefined) {
      problems.push(
        `${file}: name "${parsed.data.name}" is already listed by ${first}; a name is listed once`,
      );
      continue;
    }
    fileOfName.set(parsed.data.name, file);
    entries.push({ file, entry: parsed.data });
  }
  if (problems.length > 0) {
    throw new RegistryError("The registry index cannot be generated", problems);
  }

  const plugins: RegistryListing[] = [];
  for (const { entry } of entries) {
    plugins.push({
      name: entry.name,
      package: entry.package,
      description: entry.description,
      kinds: [...entry.kinds].sort(),
      facetdb: entry.facetdb,
      verified: entry.verified,
      ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
      downloads: await options.downloadsOf(entry.package),
    });
  }
  plugins.sort(byName);
  return { format: REGISTRY_FORMAT, generatedAt: options.now().toISOString(), plugins };
}

/**
 * Reads the text of an index. The format is checked first: a format this facetdb does not know is
 * refused with a request to upgrade, whatever else the file holds. Within the format, anything that
 * is not exactly the shape the generator writes is refused, an unknown field included.
 */
export function readRegistryIndex(text: string): RegistryIndex {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new RegistryError("The registry index cannot be read", [
      `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    ]);
  }
  const format =
    typeof json === "object" && json !== null ? (json as { format?: unknown }).format : undefined;
  if (typeof format === "number" && Number.isInteger(format) && format > REGISTRY_FORMAT) {
    throw new RegistryError("The registry index cannot be read", [
      `it is in format ${format}, and this facetdb reads format ${REGISTRY_FORMAT}: this facetdb is too old for the registry; upgrade facetdb`,
    ]);
  }
  const parsed = indexSchema.safeParse(json);
  if (!parsed.success) {
    throw new RegistryError(
      "The registry index cannot be read",
      problemsOf(parsed.error, "index", (path) =>
        path.length === 0 ? INDEX_FIELDS : LISTING_FIELDS,
      ),
    );
  }
  return parsed.data;
}

/** Whether a value is written on one line: a short list of words stays inline, as the repository's formatter keeps it. */
function isScalar(value: unknown): boolean {
  return typeof value !== "object" || value === null;
}

function render(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    if (value.every(isScalar)) {
      return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${render(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value).filter(([, field]) => field !== undefined);
    if (fields.length === 0) {
      return "{}";
    }
    const inner = `${indent}  `;
    return `{\n${fields
      .map(([key, field]) => `${inner}${JSON.stringify(key)}: ${render(field, inner)}`)
      .join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/**
 * The text of an index as it is committed: two-space indentation, the fields in schema order, a
 * list of kinds on one line and a final newline, the way the repository's formatter writes JSON, so
 * that the generated file passes the formatter as it is.
 */
export function formatRegistryIndex(index: RegistryIndex): string {
  return `${render(index, "")}\n`;
}
