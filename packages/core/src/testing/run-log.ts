import type { Run, RunLog } from "../worker/index.ts";

/**
 * An in-memory run log. `runs` holds the rows in the order they were recorded; `prunes` every
 * cutoff a prune was asked for, so a test can assert when the worker pruned and with what.
 * `failWith` makes every later call reject with that error.
 */
export class FakeRunLog implements RunLog {
  readonly runs: Run[] = [];
  readonly prunes: Date[] = [];
  failWith: Error | undefined;

  record(run: Run): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    this.runs.push(run);
    return Promise.resolve();
  }

  prune(before: Date): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    this.prunes.push(before);
    // As the store does it: a row that ended before the cutoff goes, every younger row stays.
    const kept = this.runs.filter((run) => run.endedAt.getTime() >= before.getTime());
    this.runs.splice(0, this.runs.length, ...kept);
    return Promise.resolve();
  }
}
