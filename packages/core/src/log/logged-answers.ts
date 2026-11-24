import { z } from "zod";
import type { QuestionSet } from "../questions/index.ts";
import type { Answer, ChoiceAnswer } from "../thresholds/index.ts";
import type { AnswerEntry } from "./model.ts";

/**
 * A logged answer as a store row holds it (the row is a boundary): the shapes `Answer` declares. A
 * choice's `options` is optional because an answer logged by an earlier version has none; when
 * present it names one option per probability, and a row whose two lists disagree is refused, since
 * keying its numbers by name would put one under another option's name.
 */
const loggedAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability: z.number() }),
  z
    .object({
      type: z.literal("choice"),
      top: z.string(),
      probabilities: z.array(z.number()),
      options: z.array(z.string()).optional(),
    })
    .refine(
      (answer) =>
        answer.options === undefined || answer.options.length === answer.probabilities.length,
      "names a different number of options than it has probabilities",
    ),
  z.object({
    type: z.literal("score"),
    probabilities: z.array(z.number()),
    confidence: z.number(),
    expected: z.number(),
  }),
]);

const loggedAnswersSchema = z.record(z.string(), loggedAnswerSchema);

/**
 * The answers of a logged model call read back from the store, or an error naming the row's part
 * that is wrong (`where`). Every answer keeps the shape it was logged with: a choice logged by an
 * earlier version comes back without `options`.
 */
export function parseLoggedAnswers(
  value: unknown,
  where: string,
): Readonly<Record<string, Answer>> {
  const parsed = loggedAnswersSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? "" : issue.path.join(".");
    throw new Error(
      `${where}: the logged answers${path === "" ? "" : ` at ${path}`} are not answers (${issue?.message ?? "unreadable"})`,
    );
  }
  const answers: Record<string, Answer> = {};
  for (const [name, answer] of Object.entries(parsed.data)) {
    if (answer.type === "choice") {
      // A row from an earlier version has no names: the key stays absent, never `undefined`.
      const { options, ...rest } = answer;
      answers[name] = options === undefined ? rest : { ...rest, options };
    } else {
      answers[name] = answer;
    }
  }
  return answers;
}

/**
 * Whether a logged entry's call asked `question` itself. An added-question run logs every
 * question's answer and asks only the added ones (`usage.asked`); the answers it kept were given
 * under an earlier version, so that entry's version says nothing of their options. An entry from an
 * earlier version names nothing, and every answer in it was asked.
 */
function askedIn(entry: AnswerEntry, question: string): boolean {
  return entry.usage.asked === undefined || entry.usage.asked.includes(question);
}

/**
 * Ties a choice answer logged without option names (from an earlier version) to the present
 * options, where that is sound. At the question-set version in force (`inForce`) the options are
 * the ones the model was shown, in the order its numbers follow, so such an answer is given the
 * present option names; at any other version, or for an answer the entry only kept from an earlier
 * call, it stays without names and its `_probabilities` is written NULL. An answer that already
 * names its options is left as it is. Returns `entry` itself when nothing changes.
 */
export function withOptionNames(
  entry: AnswerEntry,
  questionSet: QuestionSet,
  inForce: number,
): AnswerEntry {
  if (entry.version !== inForce) {
    return entry;
  }
  const named: Record<string, Answer> = {};
  for (const question of questionSet.questions) {
    const answer = entry.answers[question.name];
    if (
      question.type === "choice" &&
      answer?.type === "choice" &&
      answer.options === undefined &&
      answer.probabilities.length === question.options.length &&
      askedIn(entry, question.name)
    ) {
      const withNames: ChoiceAnswer = {
        ...answer,
        options: question.options.map((option) => option.name),
      };
      named[question.name] = withNames;
    }
  }
  return Object.keys(named).length === 0
    ? entry
    : { ...entry, answers: { ...entry.answers, ...named } };
}
