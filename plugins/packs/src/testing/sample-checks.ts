import { readFile } from "node:fs/promises";
import type { PackDefinition } from "facetdb/plugin";

/**
 * The checks every pack's committed sample is held to (moved out of the marketplace pack's test):
 * the record shape, no run of four words or quoted phrase shared with the pack's wording, and only
 * invented contacts. Each check returns the problems it found, one sentence each, so a test asserts
 * an empty list and a failure names the record. Every check reads the fields the pack reads
 * (`reads`), never the sample's own `fields`, so a sample whose `fields` drifted cannot pass with
 * nothing scanned. Imported by the packs' tests alone; the package's `index.ts` never exports it.
 */

/** One labelled record: its id, its state fields at the top level, and the label per question. */
export type SampleRecord = {
  readonly id: string;
  readonly expected: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
};

/** A pack's committed sample, as `<pack>.sample.json` holds it. */
export type Sample = {
  readonly pack: string;
  readonly fields: readonly string[];
  readonly about: string;
  readonly records: readonly SampleRecord[];
  readonly [key: string]: unknown;
};

type PackQuestion = PackDefinition["questions"][number];

const UNSURE = "unsure";

/** Reads a sample file beside the test that names it. */
export async function readSample(url: URL): Promise<Sample> {
  return JSON.parse(await readFile(url, "utf8")) as Sample;
}

/** The labels a question takes: its decision values, and unsure (as core's `runSample` reads them). */
export function labelsOf(question: PackQuestion): readonly string[] {
  switch (question.type) {
    case "noul":
      return ["yes", "no", UNSURE];
    case "choice":
      return [...question.options.map((option) => option.name), UNSURE];
    case "score":
      return [...question.levels.map((level) => level.name), UNSURE];
  }
}

/** The words a question sends the model: its text and the text of its criteria, options or levels. */
export function wordingOf(question: PackQuestion): readonly string[] {
  switch (question.type) {
    case "noul":
      return [question.instructions, question.criteria?.true ?? "", question.criteria?.false ?? ""];
    case "choice":
      return [question.instructions, ...question.options.map((option) => option.description)];
    case "score":
      return [question.instructions, ...question.levels.map((level) => level.description ?? "")];
  }
}

/** Every run of `size` consecutive words of a text, lowercased: the phrases two texts could share. */
export function wordRuns(text: string, size: number): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  return words
    .slice(0, Math.max(0, words.length - size + 1))
    .map((_, index) => words.slice(index, index + size).join(" "));
}

/** A record's text over the sample's fields, one field a line. */
export function textOf(record: SampleRecord, fields: readonly string[]): string {
  return fields
    .map((field) => {
      const value = record[field];
      return typeof value === "string" ? value : "";
    })
    .join("\n");
}

/** A pack that reads no field leaves a check nothing to scan: that is a problem, never a pass. */
function readsNothing(fields: readonly string[]): string[] {
  return fields.length === 0 ? ["the pack reads no field, so no record text was checked"] : [];
}

/**
 * Every way the records miss the shape the pack's sample takes: the record's keys are its id, the
 * pack's fields and `expected`; each field holds text; `expected` holds one allowed label for each
 * question of the pack and nothing else; and no two records share an id.
 */
export function shapeProblems(pack: PackDefinition, sample: Sample): string[] {
  const fields = pack.reads ?? [];
  const keys = ["id", ...fields, "expected"].sort();
  const problems = readsNothing(fields);
  const seen = new Set<string>();
  for (const record of sample.records) {
    if (seen.has(record.id)) {
      problems.push(`${record.id}: the id is used twice`);
    }
    seen.add(record.id);
    const own = Object.keys(record).sort();
    if (own.join(",") !== keys.join(",")) {
      problems.push(`${record.id}: its keys are ${own.join(", ")}, not ${keys.join(", ")}`);
    }
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${record.id}: ${field} holds no text`);
      }
    }
    const { expected } = record;
    for (const question of pack.questions) {
      const label = expected[question.name];
      if (label === undefined || !labelsOf(question).includes(label)) {
        problems.push(
          `${record.id}: the label for ${question.name} is ${label === undefined ? "missing" : `"${label}"`}, not one of ${labelsOf(question).join(", ")}`,
        );
      }
    }
    const names = new Set(pack.questions.map((question) => question.name));
    for (const name of Object.keys(expected).filter((key) => !names.has(key))) {
      problems.push(`${record.id}: it labels ${name}, which is no question of the pack`);
    }
  }
  return problems;
}

/**
 * Every quoted phrase and run of four words a record shares with the pack's wording: criteria that
 * repeat the sample's own hard cases would test the sample against itself.
 */
export function sharedWording(pack: PackDefinition, sample: Sample): string[] {
  const fields = pack.reads ?? [];
  const wording = pack.questions.flatMap(wordingOf);
  const quoted = wording.flatMap((text) =>
    [...text.matchAll(/(?:^|[\s(])['"‘“]([^'"’”]+)['"’”](?=[\s.,;:)]|$)/g)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  const runs = new Set(wording.flatMap((text) => wordRuns(text, 4)));
  const problems = readsNothing(fields);
  for (const record of sample.records) {
    const text = textOf(record, fields);
    for (const phrase of quoted.filter((candidate) => text.toLowerCase().includes(candidate))) {
      problems.push(`${record.id} repeats "${phrase}"`);
    }
    for (const run of wordRuns(text, 4).filter((candidate) => runs.has(candidate))) {
      problems.push(`${record.id} shares "${run}"`);
    }
  }
  return problems;
}

/**
 * Every contact in the records that is not an invented one: a link, a domain outside the reserved
 * `.example`, or a number shaped like a phone number outside 555-0100 to 555-0199.
 */
export function contactProblems(pack: PackDefinition, sample: Sample): string[] {
  const fields = pack.reads ?? [];
  const problems = readsNothing(fields);
  for (const record of sample.records) {
    const text = textOf(record, fields);
    for (const [link] of text.matchAll(/https?:|www\./gi)) {
      problems.push(`${record.id}: a link (${link})`);
    }
    for (const [domain] of text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) {
      if (!/\.example$/.test(domain)) {
        problems.push(`${record.id}: ${domain} is outside .example`);
      }
    }
    for (const [number] of text.matchAll(/\d{3}[-\s]?\d{4}/g)) {
      if (!/^555-01\d\d$/.test(number)) {
        problems.push(`${record.id}: ${number} is outside 555-0100 to 555-0199`);
      }
    }
  }
  return problems;
}
