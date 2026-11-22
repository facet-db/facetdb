import { isDeepStrictEqual } from "node:util";
import type {
  ActiveAlert,
  AlertRecord,
  AlertSettlement,
  AlertStore,
  DeadWorkers,
  HeldMessage,
  QuietSummaryState,
  WorkerBeat,
} from "../alerts/index.ts";
import { FakeStore } from "./store.ts";

type Operation = "save" | "remove" | "take";

/**
 * The alert store in memory: the alerts awaiting resolution, the history, the project's heartbeat
 * and one heartbeat row per worker. `database` is the clock of the database: the real store stamps
 * a beat and measures a row's age with its own, never a worker's, so a test that wants the two
 * apart (workers whose clocks differ) gives the store a clock of its own. `takeDeadWorkers` takes
 * in one synchronous step, as the real store's single statement does, so two watchers that look
 * at once cannot both get a row; `takes` counts the statements a watch spent on looking, `failing`
 * makes one kind of operation throw, and `after` is called after each operation (a test stops a
 * running loop from there).
 */
export class FakeAlertStore implements AlertStore {
  readonly database: { now(): number };

  constructor(database: { now(): number }) {
    this.database = database;
  }

  readonly active = new FakeStore<ActiveAlert>();
  readonly history: AlertRecord[] = [];
  /** `project|worker` to the worker's last beat. */
  readonly workers = new Map<string, number>();
  /** The quiet-hours summary states, by `quietKey`. */
  readonly quiet = new Map<string, QuietSummaryState>();
  /** How many times the take ran. */
  takes = 0;
  /** How many store calls the quiet-hours summaries made: a tick that costs none adds none. */
  quietCalls = 0;
  failing: Operation | undefined;
  after: (operation: Operation) => void = () => undefined;
  readonly #beats = new Map<string, number>();

  getActive(key: string): Promise<ActiveAlert | undefined> {
    return Promise.resolve(this.active.get(key));
  }

  setActive(key: string, alert: ActiveAlert): Promise<void> {
    this.active.set(key, alert);
    return Promise.resolve();
  }

  clearActive(key: string): Promise<void> {
    this.active.delete(key);
    return Promise.resolve();
  }

  /** The id of a line is its place in `history`; `settle` writes the outcome into it. */
  append(record: AlertRecord): Promise<string> {
    this.history.push(record);
    return Promise.resolve(String(this.history.length - 1));
  }

  settle(id: string, settlement: AlertSettlement): Promise<void> {
    const index = Number(id);
    const record = this.history[index];
    if (record === undefined) {
      return Promise.reject(new Error(`no history line ${id} to settle`));
    }
    const { pending: _pending, ...rest } = record;
    this.history[index] = { ...rest, ...settlement };
    return Promise.resolve();
  }

  lastHeartbeat(project: string): Promise<number | undefined> {
    return Promise.resolve(this.#beats.get(project));
  }

  saveHeartbeat(project: string, at: number): Promise<void> {
    this.#beats.set(project, at);
    return Promise.resolve();
  }

  async saveWorkerBeat(project: string, worker: string): Promise<number> {
    this.#enter("save");
    const at = this.database.now();
    this.workers.set(`${project}|${worker}`, at);
    await this.#leave("save");
    return at;
  }

  async removeWorkerBeat(project: string, worker: string): Promise<void> {
    this.#enter("remove");
    this.workers.delete(`${project}|${worker}`);
    await this.#leave("remove");
  }

  async takeDeadWorkers(
    project: string,
    except: string,
    olderThanMs: number,
  ): Promise<DeadWorkers> {
    this.takes += 1;
    this.#enter("take");
    const cutoff = this.database.now() - olderThanMs;
    const taken: WorkerBeat[] = [];
    let beating = 0;
    for (const [key, at] of [...this.workers]) {
      const [owner = "", worker = ""] = key.split("|");
      if (owner !== project) {
        continue;
      }
      if (at > cutoff) {
        beating += 1;
      } else if (worker !== except) {
        taken.push({ worker, at });
        this.workers.delete(key);
      }
    }
    await this.#leave("take");
    return { taken, beating };
  }

  quietState(key: string): Promise<QuietSummaryState | undefined> {
    this.quietCalls += 1;
    return Promise.resolve(this.quiet.get(key));
  }

  /** Compares and writes in one synchronous step, as the real store's single statement does. */
  swapQuietState(
    key: string,
    expected: QuietSummaryState | undefined,
    next: QuietSummaryState,
  ): Promise<boolean> {
    this.quietCalls += 1;
    if (!isDeepStrictEqual(this.quiet.get(key), expected)) {
      return Promise.resolve(false);
    }
    this.quiet.set(key, next);
    return Promise.resolve(true);
  }

  heldFor(
    project: string,
    channel: string,
    since: number,
    until: number,
  ): Promise<readonly HeldMessage[]> {
    this.quietCalls += 1;
    return Promise.resolve(
      this.history
        .filter(
          (line) =>
            line.event.project === project &&
            line.held?.includes(channel) === true &&
            line.at >= since &&
            line.at < until,
        )
        .map((line) => ({
          key: line.key,
          phase: line.phase,
          severity: line.severity,
          kind: line.event.kind,
          source: line.event.source,
        })),
    );
  }

  #enter(operation: Operation): void {
    if (this.failing === operation) {
      throw new Error(`the database is unreachable (${operation})`);
    }
  }

  #leave(operation: Operation): Promise<void> {
    this.after(operation);
    return Promise.resolve();
  }
}
