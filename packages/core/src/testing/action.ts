import type { Action, ActionDecisions, ActionRecord } from "../contracts/index.ts";

export type ActionCall<C> = {
  readonly record: ActionRecord;
  readonly decisions: ActionDecisions;
  readonly config: C;
};

/**
 * An action that records every call. `failNextWith` makes the next call reject, so a test can
 * prove the pipeline reports an action's failure instead of swallowing it.
 */
export class FakeAction<C> implements Action<C> {
  readonly calls: ActionCall<C>[] = [];
  #failure: Error | null = null;

  failNextWith(error: Error): void {
    this.#failure = error;
  }

  run(record: ActionRecord, decisions: ActionDecisions, config: C): Promise<void> {
    this.calls.push({ record, decisions, config });
    const failure = this.#failure;
    if (failure !== null) {
      this.#failure = null;
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }
}
