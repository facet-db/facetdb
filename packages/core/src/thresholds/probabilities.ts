import type { ChoiceQuestion, Question } from "../questions/index.ts";
import type { ChoiceAnswer, Decision } from "./types.ts";

/**
 * A choice's option probabilities as a decision carries them (the `<name>_probabilities` column
 * exists only when the question sets `storeProbabilities: true`). A decision made from `answer` for
 * `question` spreads this in, whether the thresholds or a person decided, so the numbers travel
 * with the confidence they came from. Nothing is added for a question that stores no list, nor for
 * an answer that cannot be tied to the present options: the column is then written NULL, and the
 * write itself never fails over it.
 */
export function storedProbabilities(
  question: Question,
  answer: ChoiceAnswer,
): Pick<Extract<Decision, { readonly kind: "decided" }>, "probabilities"> {
  if (question.type !== "choice" || !question.storeProbabilities) {
    return {};
  }
  const tied = probabilitiesByName(question, answer);
  return tied === undefined ? {} : { probabilities: tied };
}

/**
 * The value of a `<name>_probabilities` column, as `facetdb types` declares it: an object keyed by
 * option name, every present option with the number the model gave it, in the question's present
 * option order. Built by name from the option names the answer carries, so options reordered since
 * the answer still get their own numbers. Undefined, so NULL in the column, when the answer cannot
 * be tied to the present options: it carries no names (logged by an earlier version and not vouched
 * for by `withOptionNames`), or its names are not exactly the present ones (an option added,
 * removed or renamed since), or its lists disagree in length (a corrupt row; the log's reader
 * refuses one). Built with `Object.fromEntries`, so an option named `__proto__` is a key like any
 * other.
 */
export function probabilitiesByName(
  question: ChoiceQuestion,
  answer: ChoiceAnswer,
): Readonly<Record<string, number>> | undefined {
  const named = answer.options;
  if (
    named === undefined ||
    named.length !== answer.probabilities.length ||
    named.length !== question.options.length ||
    new Set(named).size !== named.length
  ) {
    return undefined;
  }
  const byName = new Map(named.map((name, index) => [name, answer.probabilities[index]]));
  const entries: [string, number][] = [];
  for (const option of question.options) {
    const probability = byName.get(option.name);
    if (probability === undefined) {
      return undefined;
    }
    entries.push([option.name, probability]);
  }
  return Object.fromEntries(entries);
}
