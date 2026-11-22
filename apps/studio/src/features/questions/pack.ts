import type { QuestionPack } from "../../api/index.ts";
import { addedQuestion, type QuestionForm, type SourceForm } from "./draft.ts";

/**
 * "Start from a pack" on the page's terms: a pack's questions are copied into a source's draft as
 * ordinary new questions, with their stakes and the pack's own thresholds, and nothing of the pack
 * is kept beside them, so the file Apply writes holds the wording as it was copied and a later
 * version of the package changes none of it. A question whose name the source already has is kept
 * as it is, and the pack's is not added: the draft's own, or the file's when the configuration
 * changed under an edited draft (a draft sent is merged over the file's questions, so a pack's
 * question of that name would replace the file's at Apply).
 */

/** Where the source already has a question of a pack question's name: the draft, or the file alone. */
export type Kept = "draft" | "file";

/** One of a pack's questions as the draft would take it, and where its name is taken, if it is. */
export type PackQuestion = { readonly question: QuestionForm; readonly kept: Kept | null };

export function packQuestions(
  pack: QuestionPack,
  form: SourceForm,
  inFile: readonly string[],
): PackQuestion[] {
  return Object.entries(pack.questions).map(([name, question]) => ({
    question: addedQuestion(name, question, pack.thresholds[name] ?? {}),
    kept: form.questions.some((existing) => existing.name === name)
      ? "draft"
      : inFile.includes(name)
        ? "file"
        : null,
  }));
}

/**
 * The draft with the pack's new questions after its own, and their names in the pack's order;
 * `inFile` is the names of the source's questions in the configuration as last read.
 */
export function withPack(
  form: SourceForm,
  pack: QuestionPack,
  inFile: readonly string[],
): { readonly form: SourceForm; readonly added: readonly string[] } {
  const added = packQuestions(pack, form, inFile)
    .filter((entry) => entry.kept === null)
    .map((entry) => entry.question);
  return {
    form: { ...form, questions: [...form.questions, ...added] },
    added: added.map((question) => question.name),
  };
}

/**
 * What a pack reads that the source does not, and what of it the source has; undefined when the
 * pack does not say what it reads, so nothing is compared.
 */
export function fieldsOf(
  pack: QuestionPack,
  read: readonly string[],
): { readonly missing: readonly string[]; readonly present: readonly string[] } | undefined {
  if (pack.reads === null) {
    return undefined;
  }
  return {
    missing: pack.reads.filter((field) => !read.includes(field)),
    present: pack.reads.filter((field) => read.includes(field)),
  };
}

const SENTENCE = /^(.+?[.!?])(?:\s|$)/su;

/** A pack's description to its first sentence: the line under its name in the list. */
export function firstSentence(text: string): string {
  return SENTENCE.exec(text.trim())?.[1] ?? text.trim();
}
