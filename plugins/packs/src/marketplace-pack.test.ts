import { readFile } from "node:fs/promises";
import { facetdb, judgeDraftSource, noul, VERSION, wordingWarnings } from "facetdb";
import { loadPlugin, type PackDefinition, type Plugin } from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import plugin, { marketplace } from "./index.ts";

/**
 * The marketplace trust and safety pack: it parses through the SDK's own checks, its wording meets
 * the loader's wording check with no warning, it names the content its description names, its
 * sample holds 50 complete labelled listings, and the plugin loads as the worker loads it. Nothing
 * here calls a model: the live run is separate.
 */

const QUESTIONS = ["scam", "banned_item", "off_platform", "counterfeit"] as const;
const ANSWERS = ["yes", "no", "unsure"] as const;
const HIGH_STAKES = { yesAbove: 0.9, noBelow: 0.1 } as const;

type Answer = (typeof ANSWERS)[number];
type Listing = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly expected: Readonly<Record<string, Answer>>;
};
type Sample = {
  readonly pack: string;
  readonly fields: readonly string[];
  readonly answers: readonly string[];
  readonly records: readonly Listing[];
};

/** The fewest listings per question that carry each answer: the spread the sample is held to. */
const AT_LEAST: Readonly<Record<Answer, number>> = { yes: 7, no: 32, unsure: 5 };

/** The names in backticks in a text: the state fields a question or a description refers to. */
function contentNames(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Every run of `size` consecutive words of a text, lowercased: the phrases two texts could share. */
function wordRuns(text: string, size: number): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  return words
    .slice(0, Math.max(0, words.length - size + 1))
    .map((_, index) => words.slice(index, index + size).join(" "));
}

function textsOf(question: PackDefinition["questions"][number]): string[] {
  if (question.type !== "noul") {
    throw new Error(`the marketplace pack asks yes-or-no questions only; ${question.name} is not`);
  }
  return [question.instructions, question.criteria?.true ?? "", question.criteria?.false ?? ""];
}

/** The pack applied as the studio's "Start from a pack" applies it: a source draft over its fields. */
function applied(pack: PackDefinition) {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        api: true,
        read: ["title", "description"],
        questions: { placeholder: noul("Is this a listing?") },
      },
    ],
  });
  const questions = Object.fromEntries(
    pack.questions.map(({ name, ...question }) => [name, question]),
  );
  return judgeDraftSource(config, { name: "listings", questions, thresholds: pack.thresholds }, {});
}

function installed(found: Plugin) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/packs") {
      return { default: found };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

async function sample(): Promise<Sample> {
  return JSON.parse(
    await readFile(new URL("./marketplace.sample.json", import.meta.url), "utf8"),
  ) as Sample;
}

describe("the marketplace pack's questions", () => {
  it("are the four yes-or-no questions, and parse as a source's question set with no wording warning", () => {
    expect(marketplace.questions.map((question) => [question.name, question.type])).toEqual(
      QUESTIONS.map((name) => [name, "noul"]),
    );
    const judged = applied(marketplace);
    if (!judged.ok) {
      throw new Error(
        `the pack does not parse as a source's questions: ${JSON.stringify(judged.issues)}`,
      );
    }
    expect(judged.questionSet.questions.map((question) => question.name)).toEqual([...QUESTIONS]);
    // The real check the loader and the studio run, never a copy of its rules.
    expect(judged.warnings).toEqual([]);
    expect(wordingWarnings(judged.questionSet, 0)).toEqual([]);
  });

  it("would be warned on by that same check had one of them a double negative", () => {
    // The check above is live: the same path flags a question written the way the pack avoids.
    const [first, ...rest] = marketplace.questions;
    if (first === undefined) {
      throw new Error("the pack has no question");
    }
    const judged = applied({
      ...marketplace,
      questions: [
        { ...first, instructions: "Is it not true that the listing in `title` has no price?" },
        ...rest,
      ],
    });
    expect(judged.ok && judged.warnings.map((warning) => warning.code)).toEqual([
      "double-negative",
    ]);
  });

  it("put every answer that hides a listing at high stakes, keeping its thresholds or stricter ones", () => {
    const stakes = Object.fromEntries(
      marketplace.questions.map((question) => [question.name, question.stakes]),
    );
    expect(stakes).toEqual({
      scam: "high",
      banned_item: "high",
      off_platform: "low",
      counterfeit: "high",
    });
    // Thresholds follow from the stakes, as the description says: the pack sets none of its own.
    expect(marketplace.thresholds).toEqual({});
    for (const question of marketplace.questions.filter((q) => q.stakes === "high")) {
      const own = marketplace.thresholds[question.name] ?? {};
      expect(own.yesAbove ?? HIGH_STAKES.yesAbove).toBeGreaterThanOrEqual(HIGH_STAKES.yesAbove);
      expect(own.noBelow ?? HIGH_STAKES.noBelow).toBeLessThanOrEqual(HIGH_STAKES.noBelow);
    }
  });

  it("read the content the description names, and each question names what it reads", () => {
    const description = marketplace.description ?? "";
    expect([...new Set(contentNames(description))]).toEqual(["title", "description"]);
    expect(description).toContain("banned list");
    expect(description).toContain("first thing a project edits");
    expect(description).toContain("high stakes");
    for (const question of marketplace.questions) {
      expect(new Set(contentNames(textsOf(question).join("\n")))).toEqual(
        new Set(["title", "description"]),
      );
    }
  });
});

describe("the marketplace pack's sample", () => {
  it("holds 50 complete listings, each with an allowed answer to every question and its own id", async () => {
    const { pack, fields, answers, records: listings } = await sample();
    expect(pack).toBe("marketplace");
    expect(fields).toEqual(["title", "description"]);
    expect(answers).toEqual([...ANSWERS]);
    expect(listings).toHaveLength(50);
    expect(new Set(listings.map((listing) => listing.id)).size).toBe(50);
    for (const listing of listings) {
      expect(Object.keys(listing).sort(), listing.id).toEqual(
        ["description", "expected", "id", "title"].sort(),
      );
      expect(listing.title.trim(), listing.id).not.toBe("");
      expect(listing.description.trim(), listing.id).not.toBe("");
      expect(Object.keys(listing.expected).sort(), listing.id).toEqual([...QUESTIONS].sort());
      for (const question of QUESTIONS) {
        expect(ANSWERS, `${listing.id}.${question}`).toContain(listing.expected[question]);
      }
    }
  });

  it("spreads every question over yes, no and unsure", async () => {
    const { records: listings } = await sample();
    for (const question of QUESTIONS) {
      for (const answer of ANSWERS) {
        const count = listings.filter((listing) => listing.expected[question] === answer).length;
        expect(count, `${question}: ${answer}`).toBeGreaterThanOrEqual(AT_LEAST[answer]);
      }
    }
  });

  it("holds scams that stay on the marketplace, and a branded replica sold for display", async () => {
    // A scam label always beside an off-platform yes could not show whether the model spots a
    // scam on its own; a display-only branded replica is the cover the counterfeit wording closes.
    const { records: listings } = await sample();
    const onPlatformScams = listings.filter(
      (listing) => listing.expected["scam"] === "yes" && listing.expected["off_platform"] === "no",
    );
    expect(onPlatformScams.length).toBeGreaterThanOrEqual(3);
    const displayReplicas = listings.filter(
      (listing) =>
        /display/i.test(`${listing.title} ${listing.description}`) &&
        listing.expected["counterfeit"] === "yes",
    );
    expect(displayReplicas.length).toBeGreaterThanOrEqual(1);
  });

  it("holds a listing of every banned kind that is safe to show, and says why the others have none", async () => {
    // Keyed by how each kind starts in the banned_item criterion. A kind with no listing is left
    // out on purpose: writing a convincing one would read as a how-to or has no place in a sample.
    const COVERAGE: Readonly<Record<string, readonly string[] | { readonly none: string }>> = {
      "weapons made to injure": ["m09", "m05", "m18"],
      "explosives and fireworks": ["m14"],
      "illegal drugs": {
        none: "a listing that offers them trades in coded words a sample should not teach; the legal neighbour is m17 (CBD, unsure)",
      },
      "prescription medicines": ["m10"],
      alcohol: ["m01"],
      "tobacco and vaping products": ["m43"],
      "live animals": ["m11", "m39"],
      "human remains or body parts": {
        none: "no ordinary listing offers them, and a written one adds nothing a moderator needs",
      },
      "stolen goods": ["m20"],
      "counterfeit money": {
        none: "a listing that sells it describes passing it off; prop money is a hard case for a later sample",
      },
      "passports, identity documents and official badges": ["m21", "m15"],
      "hazardous chemicals": ["m16"],
      "recalled products": ["m19"],
      "sexual services or adult content": { none: "not content for a committed sample" },
    };
    const banned = marketplace.questions.find((question) => question.name === "banned_item");
    const criterion = banned?.type === "noul" ? (banned.criteria?.true ?? "") : "";
    const kinds = criterion
      .slice(criterion.indexOf(":") + 1)
      .split(";")
      .map((kind) => kind.trim());
    expect(kinds).toHaveLength(Object.keys(COVERAGE).length);
    const { records: listings } = await sample();
    for (const [key, covered] of Object.entries(COVERAGE)) {
      expect(
        kinds.filter((kind) => kind.startsWith(key)),
        key,
      ).toHaveLength(1);
      if (!Array.isArray(covered)) {
        continue;
      }
      expect(covered.length, key).toBeGreaterThan(0);
      for (const id of covered as readonly string[]) {
        const listing = listings.find((candidate) => candidate.id === id);
        expect(listing?.expected["banned_item"], `${key}: ${id}`).toMatch(/^(yes|unsure)$/);
      }
    }
  });

  it("shares no quoted phrase and no run of four words with any question's wording", async () => {
    // Criteria that repeat the sample's own hard cases would test the sample against itself.
    const { records: listings } = await sample();
    const wording = marketplace.questions.flatMap(textsOf);
    const quoted = wording.flatMap((text) =>
      [...text.matchAll(/(?:^|[\s(])['"‘“]([^'"’”]+)['"’”](?=[\s.,;:)]|$)/g)].map((m) =>
        (m[1] ?? "").toLowerCase(),
      ),
    );
    const runs = new Set(wording.flatMap((text) => wordRuns(text, 4)));
    for (const listing of listings) {
      const text = `${listing.title}\n${listing.description}`;
      for (const phrase of quoted) {
        expect(text.toLowerCase(), `${listing.id} repeats "${phrase}"`).not.toContain(phrase);
      }
      const shared = wordRuns(text, 4).filter((run) => runs.has(run));
      expect(shared, listing.id).toEqual([]);
    }
  });

  it("holds only invented contacts: .example addresses and 555-01xx numbers", async () => {
    const { records: listings } = await sample();
    const text = listings.map((listing) => `${listing.title}\n${listing.description}`).join("\n");
    expect(text).not.toMatch(/https?:|www\./i);
    for (const [domain] of text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) {
      expect(domain).toMatch(/\.example$/);
    }
    for (const [number] of text.matchAll(/\d{3}[-\s]?\d{4}/g)) {
      expect(number).toMatch(/^555-01\d\d$/);
    }
  });
});

describe("the packs plugin", () => {
  it("passes loadPlugin's checks with packs as its only kind, and matches its registry entry", async () => {
    const loaded = await loadPlugin("packs", {
      coreVersion: VERSION,
      importModule: installed(plugin),
    });
    expect(loaded.manifest.name).toBe("packs");
    expect(loaded.manifest.kinds).toEqual(["pack"]);
    expect(loaded.manifest.secrets).toEqual([]);
    expect(Object.keys(loaded.packs)).toEqual(["marketplace"]);
    expect(loaded.packs["marketplace"]).toBe(marketplace);
    for (const kind of [loaded.sources, loaded.actions, loaded.channels, loaded.providers]) {
      expect(kind).toEqual({});
    }
    const entry = JSON.parse(
      await readFile(new URL("../../../registry/plugins/packs.json", import.meta.url), "utf8"),
    ) as { name: string; package: string; kinds: string[]; facetdb: string };
    expect(entry.name).toBe(plugin.manifest.name);
    expect(entry.package).toBe("@facetdb/packs");
    expect(entry.kinds).toEqual(plugin.manifest.kinds);
    expect(entry.facetdb).toBe(plugin.manifest.coreVersions);
  });
});
