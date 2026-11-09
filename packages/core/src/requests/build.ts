import type { NoulCriteria, Question, QuestionSet } from "../questions/index.ts";
import type { StateValue } from "../records/index.ts";
import type { SystemOneQuestion, SystemOneRequest } from "./schema.ts";

/**
 * One request for one record: the state fields the set reads, every question of the set, and the
 * pinned model. The state is a named-field object in config order; FacetDB's own columns and the
 * rest of the row never reach the model.
 */
export function buildRequest(
  questionSet: QuestionSet,
  state: Readonly<Record<string, StateValue>>,
): SystemOneRequest {
  const fields: Record<string, StateValue> = {};
  for (const field of questionSet.read) {
    const value = Object.hasOwn(state, field) ? state[field] : undefined;
    if (value === undefined) {
      throw new Error(`state field "${field}" is missing from the row`);
    }
    fields[field] = value;
  }
  const questions: Record<string, SystemOneQuestion> = {};
  for (const question of questionSet.questions) {
    questions[question.name] = toRequestQuestion(question);
  }
  return { model: questionSet.model, state: fields, questions };
}

function toRequestQuestion(question: Question): SystemOneQuestion {
  switch (question.type) {
    case "noul": {
      const criteria = noulCriteria(question.criteria);
      return criteria === undefined
        ? { type: "noul", instructions: question.instructions }
        : { type: "noul", instructions: question.instructions, criteria };
    }
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map((option) => [option.name, option.description]),
        ),
      };
    case "score":
      // A level without a description is described by its name: the position is the score.
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.levels.map((level) => level.description ?? level.name),
      };
  }
}

/** Only the criteria the config gave; an absent criteria object is left out, not sent empty. */
function noulCriteria(criteria: NoulCriteria | undefined): NoulCriteria | undefined {
  if (criteria === undefined) {
    return undefined;
  }
  const given: { true?: string; false?: string } = {};
  if (criteria.true !== undefined) {
    given.true = criteria.true;
  }
  if (criteria.false !== undefined) {
    given.false = criteria.false;
  }
  return given.true === undefined && given.false === undefined ? undefined : given;
}
