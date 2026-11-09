import type {
  Action,
  ActionCondition,
  ActionDecisions,
  ActionInvocation,
  ActionRecord,
  ConditionValue,
} from "../contracts/index.ts";

/**
 * One configured action as the worker runs it: the action, its config and its `when`/`else`
 * already bound, so the worker only hands over the record and its decisions.
 */
export type ActionStep = {
  /** Names the action in a failure report, such as `slack.notify`. */
  readonly name: string;
  run(record: ActionRecord, decisions: ActionDecisions): Promise<void>;
};

const NUMBER_TESTS = [".probability", ".confidence"] as const;

function numberTestQuestion(term: string): string | undefined {
  for (const suffix of NUMBER_TESTS) {
    if (term.endsWith(suffix)) {
      return term.slice(0, -suffix.length);
    }
  }
  return undefined;
}

function termHolds(
  term: string,
  expected: ConditionValue,
  record: ActionRecord,
  decisions: ActionDecisions,
): boolean {
  if (term === "status") {
    return record.status === expected;
  }
  const numberQuestion = numberTestQuestion(term);
  const decision = decisions[numberQuestion ?? term];
  // A question still waiting for a person has no value and no number to test.
  if (decision === undefined || decision.kind !== "decided") {
    return false;
  }
  if (numberQuestion !== undefined) {
    return typeof expected === "object" && decision.probabilityOrConfidence >= expected.atLeast;
  }
  return decision.value === expected;
}

/**
 * Whether every term of a `when` holds (AND): a question equal to its decided value, `status` equal
 * to the record's status, or `<question>.probability` / `.confidence` at least a number.
 */
export function conditionHolds(
  when: ActionCondition,
  record: ActionRecord,
  decisions: ActionDecisions,
): boolean {
  return Object.entries(when).every(([term, expected]) =>
    termHolds(term, expected, record, decisions),
  );
}

/**
 * Binds an action to its configuration. When the `when` holds (or there is none) the action runs
 * with its own fields; when it does not, it runs with those fields overridden by `else`, and an
 * action without an `else` does not run. `run` never sees a condition.
 */
export function configureAction<C>(
  name: string,
  action: Action<C>,
  invocation: ActionInvocation<C>,
): ActionStep {
  const { when, else: otherwise, ...own } = invocation;
  // The rest of `C & { when?, else? }` without those two keys is exactly `C`; TypeScript cannot
  // see through the generic intersection.
  const config = own as unknown as C;
  return {
    name,
    async run(record, decisions) {
      if (when === undefined || conditionHolds(when, record, decisions)) {
        await action.run(record, decisions, config);
      } else if (otherwise !== undefined) {
        await action.run(record, decisions, { ...config, ...otherwise });
      }
    },
  };
}
