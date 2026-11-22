import type { Thresholds } from "@facetdb/ui";
import type {
  ConfigSource,
  QuestionJson,
  SourceDraft,
  ThresholdOverride,
} from "../../api/index.ts";
import { crossed } from "./cuts.ts";

/**
 * The draft the Questions page edits: one source's questions as form fields, turned back into the
 * project JSON's shape to send (`draftOf`). The draft is the page's, never the query's: a refetch
 * of the config reconciles with it (`reconcile`) and never overwrites what the person typed.
 */

export type QuestionType = QuestionJson["type"];
export type Stakes = QuestionJson["stakes"];

/** A line of a pick-one or a rating: the name the model returns, and what it means. */
export type Line = { readonly name: string; readonly description: string };

export type QuestionForm = {
  readonly name: string;
  /** In the file: its name and type are columns, so they are the file's to change. */
  readonly existing: boolean;
  readonly type: QuestionType;
  readonly instructions: string;
  /** A yes or no question's criteria: what yes means, what no means. */
  readonly yes: string;
  readonly no: string;
  readonly options: readonly Line[];
  readonly levels: readonly Line[];
  readonly stakes: Stakes;
  readonly storeProbabilities: boolean;
  /** The config's override; a key left out is the stakes default. */
  readonly thresholds: ThresholdOverride;
};

export type SourceForm = {
  readonly name: string;
  readonly questions: readonly QuestionForm[];
  /** The order the file lists its thresholds in: a draft keeps it, so the diff shows no reorder. */
  readonly thresholdOrder: readonly string[];
};

const TWO_EMPTY: readonly Line[] = [
  { name: "", description: "" },
  { name: "", description: "" },
];

function questionForm(
  name: string,
  question: QuestionJson,
  thresholds: ThresholdOverride,
): QuestionForm {
  const base = {
    name,
    existing: true,
    type: question.type,
    instructions: question.instructions,
    stakes: question.stakes,
    thresholds,
    yes: "",
    no: "",
    options: TWO_EMPTY,
    levels: TWO_EMPTY,
    storeProbabilities: false,
  };
  switch (question.type) {
    case "noul":
      return { ...base, yes: question.criteria?.true ?? "", no: question.criteria?.false ?? "" };
    case "choice":
      return {
        ...base,
        options: question.options,
        storeProbabilities: question.storeProbabilities,
      };
    case "score":
      return {
        ...base,
        levels: question.levels.map((level) => ({
          name: level.name,
          description: level.description ?? "",
        })),
      };
  }
}

/**
 * A question written elsewhere and added to the draft (a pack's): an ordinary new question from
 * then on, its name and kind the page's until Apply writes it, nothing of where it came from.
 */
export function addedQuestion(
  name: string,
  question: QuestionJson,
  thresholds: ThresholdOverride,
): QuestionForm {
  return { ...questionForm(name, question, thresholds), existing: false };
}

/** The form of a source as the config holds it. */
export function formOf(source: ConfigSource): SourceForm {
  return {
    name: source.name,
    questions: Object.entries(source.questions).map(([name, question]) =>
      questionForm(name, question, source.thresholds[name] ?? {}),
    ),
    thresholdOrder: Object.keys(source.thresholds),
  };
}

// A name becomes a column's (packages/core, questions/names.ts).
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED_NAME = /^facetdb(_|$)/;

/**
 * Why a question's name cannot be sent, or undefined when it can. A question in the file keeps its
 * name; a question added here needs one that is a column's, FacetDB's prefix left alone, and no
 * other question's: two questions of one name would leave one draft key for both, and the second
 * would replace the first, its card and its cut lines unseen.
 */
export function nameProblem(form: SourceForm, index: number): string | undefined {
  const question = form.questions[index];
  if (question === undefined || question.existing) {
    return undefined;
  }
  const { name } = question;
  if (name.trim() === "") {
    return "Give the question a name: it becomes the name of its column.";
  }
  if (!NAME_PATTERN.test(name)) {
    return `"${name}" cannot name a column: use lowercase letters, digits and underscores, starting with a letter, at most 40 characters.`;
  }
  if (RESERVED_NAME.test(name)) {
    return `"${name}" starts with facetdb, the prefix of FacetDB's own columns: choose another name.`;
  }
  const taken = form.questions.some(
    (other, at) => at !== index && other.name === name && (other.existing || at < index),
  );
  return taken
    ? `"${name}" is already the name of another question of this source: give this one a name of its own.`
    : undefined;
}

const percent = (figure: number): string => `${String(Math.round(figure * 100))}%`;

/**
 * Why a question's cut lines cannot be sent, or undefined when they can: the loader's rule
 * (cuts.ts), said on the page at once rather than when the loader's answer arrives.
 */
export function cutProblem(question: QuestionForm): string | undefined {
  const thresholds = thresholdsOf(question);
  if (thresholds.kind !== "cuts" || !crossed(thresholds)) {
    return undefined;
  }
  return `The cut lines cross: yes at ${percent(thresholds.yesAbove)} sits below no at ${percent(thresholds.noBelow)}. Move one, or use the default.`;
}

/**
 * Whether the form can be sent: every question's name is its own and a column's, and every pair of
 * cut lines is in order. Until it can, nothing is judged, previewed, tested or written.
 */
export function formHolds(form: SourceForm): boolean {
  return form.questions.every(
    (question, index) =>
      nameProblem(form, index) === undefined && cutProblem(question) === undefined,
  );
}

/** A question the person adds: a yes or no question at low stakes, named so it is unique. */
export function newQuestion(form: SourceForm): QuestionForm {
  let n = form.questions.length + 1;
  while (form.questions.some((question) => question.name === `question_${String(n)}`)) {
    n += 1;
  }
  return {
    name: `question_${String(n)}`,
    existing: false,
    type: "noul",
    instructions: "",
    yes: "",
    no: "",
    options: TWO_EMPTY,
    levels: TWO_EMPTY,
    stakes: "low",
    storeProbabilities: false,
    thresholds: {},
  };
}

const filled = (text: string): boolean => text.trim() !== "";

function questionJson(question: QuestionForm): QuestionJson {
  switch (question.type) {
    case "noul": {
      const criteria = {
        ...(filled(question.yes) ? { true: question.yes } : {}),
        ...(filled(question.no) ? { false: question.no } : {}),
      };
      return {
        type: "noul",
        instructions: question.instructions,
        ...(Object.keys(criteria).length === 0 ? {} : { criteria }),
        stakes: question.stakes,
      };
    }
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        options: question.options.map((option) => ({
          name: option.name,
          description: option.description,
        })),
        stakes: question.stakes,
        storeProbabilities: question.storeProbabilities,
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        levels: question.levels.map((level) =>
          filled(level.description)
            ? { name: level.name, description: level.description }
            : { name: level.name },
        ),
        stakes: question.stakes,
      };
  }
}

/**
 * The thresholds in the file's order for the keys the file has, a new key after them: a draft that
 * changes one word sends the file's thresholds back key for key, so the diff shows no reorder.
 */
function thresholdEntries(form: SourceForm): [string, ThresholdOverride][] {
  const set = form.questions.filter((question) => Object.keys(question.thresholds).length > 0);
  const listed = form.thresholdOrder.flatMap((name) =>
    set.filter((question) => question.name === name),
  );
  const added = set.filter((question) => !form.thresholdOrder.includes(question.name));
  return [...listed, ...added].map((question) => [question.name, question.thresholds]);
}

/**
 * What the page sends: the source by name, its questions and thresholds, merged over the file's.
 * Undefined while a name or a pair of cut lines cannot be sent (`formHolds`): a draft is never built
 * from two questions of one name, so one can never replace the other in what reaches the loader,
 * the model or the file, nor from cut lines in the wrong order.
 */
export function draftOf(form: SourceForm): SourceDraft | undefined {
  if (!formHolds(form)) {
    return undefined;
  }
  return {
    name: form.name,
    questions: Object.fromEntries(
      form.questions.map((question) => [question.name, questionJson(question)]),
    ),
    thresholds: Object.fromEntries(thresholdEntries(form)),
  };
}

/**
 * The form as one string, in lists rather than by name, so two questions of one name both count:
 * two forms with the same key send the same draft.
 */
export function draftKey(form: SourceForm): string {
  return JSON.stringify([
    form.name,
    form.questions.map((question) => [question.name, questionJson(question)]),
    thresholdEntries(form),
  ]);
}

/** What the model reads of a question: its kind, wording and criteria, options or levels. */
function wordingOf(question: QuestionJson): string {
  switch (question.type) {
    case "noul":
      return JSON.stringify([question.type, question.instructions, question.criteria ?? null]);
    case "choice":
      return JSON.stringify([question.type, question.instructions, question.options]);
    case "score":
      return JSON.stringify([question.type, question.instructions, question.levels]);
  }
}

/**
 * What the model is asked, and only that: each question's name and what `wordingOf` reads. The
 * preview's request carries no stakes, no `storeProbabilities` and no thresholds (packages/core,
 * questions/version.ts leaves the same out of a version), so choosing the stakes or moving a cut
 * line asks nothing; the thresholds are re-applied on the page.
 */
export function previewKey(form: SourceForm): string {
  return JSON.stringify(
    form.questions.map((question) => [question.name, wordingOf(questionJson(question))]),
  );
}

// The stakes defaults (packages/core, thresholds/defaults.ts).
const YES_NO = {
  low: { yesAbove: 0.7, noBelow: 0.3 },
  high: { yesAbove: 0.9, noBelow: 0.1 },
} as const;
const CONFIDENCE = { low: 0.5, high: 0.75 } as const;

/** The thresholds in force for a question: its stakes defaults with the config's override. */
export function thresholdsOf(question: QuestionForm): Thresholds {
  if (question.type === "noul") {
    const defaults = YES_NO[question.stakes];
    return {
      kind: "cuts",
      yesAbove: question.thresholds.yesAbove ?? defaults.yesAbove,
      noBelow: question.thresholds.noBelow ?? defaults.noBelow,
    };
  }
  return {
    kind: "confidence",
    confidenceAtLeast: question.thresholds.confidenceAtLeast ?? CONFIDENCE[question.stakes],
  };
}

/** The stakes defaults of a question, whatever the config overrides. */
export function defaultsOf(question: QuestionForm): Thresholds {
  return thresholdsOf({ ...question, thresholds: {} });
}

/**
 * The override after one cut line moved: only the side the person moved is written, the others
 * stay as they were. A side moved back onto its stakes default that the file does not hold is taken
 * out again, so a default is never pinned into the file by a slider that came back to it.
 */
export function movedOverride(
  question: QuestionForm,
  fileOverride: ThresholdOverride,
  next: Thresholds,
): ThresholdOverride {
  const now = flat(thresholdsOf(question));
  const defaults = flat(defaultsOf(question));
  const moved = flat(next);
  let result: ThresholdOverride = question.thresholds;
  for (const key of SIDES) {
    const value = moved[key];
    if (value === undefined || value === now[key]) {
      continue;
    }
    const { [key]: _left, ...others } = result;
    result =
      value === defaults[key] && fileOverride[key] === undefined
        ? others
        : { ...result, [key]: value };
  }
  return result;
}

const SIDES = ["yesAbove", "noBelow", "confidenceAtLeast"] as const;

/** The thresholds as the override's keys. */
function flat(thresholds: Thresholds): ThresholdOverride {
  return thresholds.kind === "cuts"
    ? { yesAbove: thresholds.yesAbove, noBelow: thresholds.noBelow }
    : { confidenceAtLeast: thresholds.confidenceAtLeast };
}

/** One source's draft: the config it started from, and the form as edited. */
export type Draft = { readonly base: SourceForm; readonly form: SourceForm };

/** Whether the person changed anything the draft sends. */
export function edited(draft: Draft): boolean {
  return draftKey(draft.form) !== draftKey(draft.base);
}

/**
 * The drafts after the config was read (again): a source seen for the first time starts from it; a
 * draft nobody edited follows it; a draft that already says what the config now says (after its
 * Apply) takes it as its base. An edited draft is kept as typed, and the page says the config
 * changed under it (`changedUnder`); nothing is merged silently.
 */
export function reconcile(
  drafts: ReadonlyMap<string, Draft>,
  sources: readonly ConfigSource[],
): ReadonlyMap<string, Draft> {
  return new Map(
    sources.map((source) => {
      const fresh = formOf(source);
      const draft = drafts.get(source.name);
      if (draft === undefined || !edited(draft)) {
        return [source.name, { base: fresh, form: fresh }];
      }
      // The draft says what the config now says (its Apply landed): the config is the form now,
      // so a question added here is a column of the file, its name and kind no longer the page's.
      if (draftKey(draft.form) === draftKey(fresh)) {
        return [source.name, { base: fresh, form: fresh }];
      }
      return [source.name, draft];
    }),
  );
}

/** The questions the draft adds or rewords: what a backfill would ask again after Apply. */
export function rewordedQuestions(draft: Draft): string[] {
  return draft.form.questions.flatMap((question) => {
    const was = draft.base.questions.find((candidate) => candidate.name === question.name);
    return was !== undefined && wordingOf(questionJson(was)) === wordingOf(questionJson(question))
      ? []
      : [question.name];
  });
}

/** A value as one string with every object's keys sorted: the same content, whatever the order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether the config's source says what a draft sent (its questions and thresholds). */
export function sameDraft(source: ConfigSource, draft: SourceDraft): boolean {
  return (
    canonical({ questions: source.questions, thresholds: source.thresholds }) ===
    canonical({ questions: draft.questions, thresholds: draft.thresholds })
  );
}

/** The config's source changed since the draft started from it, and the draft says something else. */
export function changedUnder(draft: Draft, source: ConfigSource): boolean {
  const now = draftKey(formOf(source));
  return now !== draftKey(draft.base) && now !== draftKey(draft.form);
}
