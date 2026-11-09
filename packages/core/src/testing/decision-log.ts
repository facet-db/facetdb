import type { DecisionLog, RecordKey } from "../contracts/index.ts";
import type { AnswerEntry, HumanEntry, LogEntry } from "../log/index.ts";
import { FakeStore } from "./store.ts";

/**
 * An in-memory decision log. Entries are kept per record in append order. `journal` receives one
 * line per append (`append answer <key>`, `append human <key>`); a test hands the same array to its
 * fake writer to assert that the log is written before the row.
 */
export class FakeDecisionLog implements DecisionLog {
  readonly #entries = new FakeStore<LogEntry[]>();
  readonly journal: string[];

  constructor(journal: string[] = []) {
    this.journal = journal;
  }

  appendAnswer(entry: AnswerEntry): Promise<void> {
    this.#append(entry);
    this.journal.push(`append answer ${entry.key}`);
    return Promise.resolve();
  }

  appendHuman(entry: HumanEntry): Promise<void> {
    this.#append(entry);
    this.journal.push(`append human ${entry.key}`);
    return Promise.resolve();
  }

  latestAnswer(key: RecordKey): Promise<AnswerEntry | undefined> {
    return Promise.resolve(latestOf(this.#entries.get(key) ?? []));
  }

  history(key: RecordKey): Promise<readonly LogEntry[]> {
    return Promise.resolve([...(this.#entries.get(key) ?? [])]);
  }

  latestAnswersSince(version?: number): Promise<readonly AnswerEntry[]> {
    const latest: AnswerEntry[] = [];
    for (const [, entries] of this.#entries.entries()) {
      const answer = latestOf(entries);
      if (answer !== undefined && (version === undefined || answer.version >= version)) {
        latest.push(answer);
      }
    }
    return Promise.resolve(latest);
  }

  #append(entry: LogEntry): void {
    const entries = this.#entries.get(entry.key) ?? [];
    entries.push(entry);
    this.#entries.set(entry.key, entries);
  }
}

function latestOf(entries: readonly LogEntry[]): AnswerEntry | undefined {
  let latest: AnswerEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === "answer") {
      latest = entry;
    }
  }
  return latest;
}
