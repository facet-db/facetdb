import type { Question, QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { VERSION_HISTORY_SHOWN, versionChanges, versionHistory } from "./versions.ts";

/**
 * The version history's words: what made each version, from the two sets the store keeps, in the
 * parts the content hash covers (the model, the fields read, each question's type, wording,
 * criteria, options and levels), and nothing it leaves out.
 */

const scam: Question = {
  type: "noul",
  name: "is_scam",
  instructions: "Is this listing a scam?",
  stakes: "high",
};

const category: Question = {
  type: "choice",
  name: "category",
  instructions: "Which category fits this listing?",
  options: [
    { name: "electronics", description: "phones, computers" },
    { name: "other", description: "anything else" },
  ],
  stakes: "low",
  storeProbabilities: false,
};

const urgency: Question = {
  type: "score",
  name: "urgency",
  instructions: "How urgent is it?",
  levels: [{ name: "low" }, { name: "high" }],
  stakes: "low",
};

const SET: QuestionSet = {
  questions: [scam, category],
  read: ["title", "price"],
  model: "jev-1.14.0",
  thresholds: {},
};

describe("versionChanges", () => {
  it("names a question added or removed", () => {
    expect(versionChanges({ ...SET, questions: [scam] }, SET)).toBe("category added");
    expect(versionChanges(SET, { ...SET, questions: [category] })).toBe("is_scam removed");
  });

  it("names the parts of a question the model reads that changed", () => {
    const reworded: Question = {
      ...scam,
      instructions: "Is this listing likely a scam?",
      criteria: { true: "A price far below market", false: "A seller with history" },
    };
    expect(versionChanges(SET, { ...SET, questions: [reworded, category] })).toBe(
      "The wording and the criteria of is_scam",
    );
    const options: Question = {
      ...category,
      options: [...category.options, { name: "furniture", description: "tables" }],
    };
    expect(versionChanges(SET, { ...SET, questions: [scam, options] })).toBe(
      "The options of category",
    );
    const levels: QuestionSet = { ...SET, questions: [urgency] };
    expect(
      versionChanges(levels, {
        ...levels,
        questions: [{ ...urgency, levels: [{ name: "low" }, { name: "mid" }, { name: "high" }] }],
      }),
    ).toBe("The levels of urgency");
  });

  it("says a question that changed type in the page's words", () => {
    const asked: Question = { ...urgency, name: "category" };
    expect(versionChanges(SET, { ...SET, questions: [scam, asked] })).toBe(
      "category is now Rate on a scale",
    );
  });

  it("names the model and the fields read, and joins several changes in one sentence", () => {
    expect(
      versionChanges(SET, {
        ...SET,
        model: "jev-1.15.0",
        read: ["title", "seller_age_days"],
        questions: [scam],
      }),
    ).toBe(
      "The model, from jev-1.14.0 to jev-1.15.0; the fields read: seller_age_days added, price removed; category removed",
    );
    expect(versionChanges(SET, { ...SET, read: ["price", "title"] })).toBe(
      "The order of the fields read",
    );
  });

  it("leaves out what makes no version: thresholds, stakes and the order of the questions", () => {
    expect(
      versionChanges(SET, {
        ...SET,
        questions: [category, { ...scam, stakes: "low" }],
        thresholds: { is_scam: { yesAbove: 0.8 } },
      }),
    ).toBe("The question set's content");
  });
});

describe("versionHistory", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0));

  it("compares each version with the one before it and words the first as created", () => {
    expect(
      versionHistory({
        inForce: 2,
        versions: [
          { version: 2, createdAt: at(3), questionSet: SET },
          { version: 1, createdAt: at(1), questionSet: { ...SET, questions: [scam] } },
        ],
      }),
    ).toEqual({
      inForce: 2,
      earlier: false,
      note: null,
      versions: [
        { version: 2, createdAt: "2026-11-03T09:00:00.000Z", changes: "category added" },
        { version: 1, createdAt: "2026-11-01T09:00:00.000Z", changes: "Created, with is_scam" },
      ],
    });
  });

  it("shows at most VERSION_HISTORY_SHOWN, the oldest still compared with the one read past them", () => {
    const stored = Array.from({ length: VERSION_HISTORY_SHOWN + 1 }, (_, index) => {
      const version = VERSION_HISTORY_SHOWN + 1 - index;
      return {
        version,
        createdAt: at(1),
        questionSet: { ...SET, model: `jev-1.${String(version)}.0` },
      };
    });
    const history = versionHistory({ inForce: null, versions: stored });
    expect(history.versions).toHaveLength(VERSION_HISTORY_SHOWN);
    expect(history.earlier).toBe(true);
    expect(history.versions.at(-1)?.changes).toBe("The model, from jev-1.1.0 to jev-1.2.0");
  });

  it("says the oldest kept version is not the first when the store has no version before it", () => {
    expect(
      versionHistory({
        inForce: 4,
        versions: [{ version: 4, createdAt: at(5), questionSet: SET }],
      }).versions[0]?.changes,
    ).toBe("The oldest version kept, with is_scam and category");
  });
});
