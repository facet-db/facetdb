import type {
  ActionStep,
  Clock,
  Connector,
  DecisionLog,
  KeyText,
  PassReport,
  Question,
  QuestionSet,
  RecordKey,
  ReviewServiceDeps,
  Worker,
} from "@facetdb/core";
import type {
  ConfigFileDoor,
  FileApply,
  FileDiff,
  PendingSource,
  ReloadSummary,
  SourceReload,
} from "@facetdb/server";
import {
  type ApplyPlan,
  apply,
  ConfigError,
  type ConfigFiles,
  type ProjectConfig,
  planApply,
  type SourceConfig,
  type SourceDraft,
  toProjectJson,
  uncommittedWords,
} from "../../config/index.ts";

/**
 * The worker's sources as a fleet that can take a new config while it runs. Each source has its own
 * loop under its own stop; the fleet reads facetdb.config.ts again when Apply has written it, and:
 *  - a source whose JSON is the same keeps running, its loop never touched;
 *  - a source whose question set changed (wording, thresholds, stakes, model) is opened anew first,
 *    its new version recorded through the store's version path, then its loop is stopped after the
 *    pass in hand (`Worker.run` checks its signal between passes only, so every claim of that pass is
 *    acked or released), its connector closed, and the new loop started; nothing is queued, so no
 *    record already answered is asked again;
 *  - a change whose only reach into the install is questions added
 *    switches like a changed set once the worker's own check of the database (`installed`: the
 *    engine's doctor under the worker login, for the new set) finds their columns and its right to
 *    write them; until then, or when the check cannot be made, the source keeps running what it ran
 *    and the worker says what is missing and what to do; a reload asked for again checks again;
 *  - any other change that reaches the database's install (a question removed, a type, options or
 *    levels, read, where, the table, storage, capture) needs `facetdb migrate` and a restart: the
 *    source keeps running what it ran, and the worker says so; so does a new source;
 *  - a source removed from the file stops after the pass in hand;
 *  - a file that does not load leaves every source as it was, and the worker says what to fix.
 * While a stopping source finishes its pass the fleet beats the heartbeat itself, so the heartbeat
 * never stops during a reload; the sources that keep running beat on every pass as always.
 */

/** How often the fleet beats while a source it restarts finishes its pass in hand. */
export const RELOAD_BEAT_EVERY_MS = 15_000;

/** One source's loop and what it holds, as the fleet opened it. */
export type SourceLoop = {
  /** The source as this loop runs it. */
  readonly source: SourceConfig;
  readonly questionSet: QuestionSet;
  /** The question-set version every answer of this loop is logged under. */
  readonly version: number;
  readonly worker: Worker;
  /**
   * The source's whole connector: the studio's preview and test read through it, and a reviewer's
   * decision reads, re-checks and writes through it, always by `Fleet.connector`, which routes each
   * call to the loop in force.
   */
  readonly connector: Connector;
  readonly keyText: KeyText | undefined;
  /**
   * The records its outage policy holds (error or unchecked, waiting for their next retry), and how
   * a policy takes such records: a restart hands the old loop's to the new one, so a reload never
   * drops a record held during a model outage. Absent for a loop without a policy.
   */
  readonly outage?: { readonly held: readonly RecordKey[]; hold(keys: readonly RecordKey[]): void };
  close(): Promise<void>;
};

/**
 * The worker's own reading of a source's database for a question set: the install holds it (its
 * columns are there and the worker login may write them), something is missing, or the engine's
 * checks cannot tell. A check that could not be made at all throws.
 */
export type InstallCheck =
  | { readonly kind: "holds" }
  | { readonly kind: "missing"; readonly missing: string }
  | { readonly kind: "cannot-tell"; readonly why: string };

export type FleetDeps = {
  /**
   * Records the source's question-set version, opens what it reads and builds its worker. The fleet
   * closes what it returns.
   */
  readonly open: (source: SourceConfig, config: ProjectConfig) => Promise<SourceLoop>;
  /**
   * Whether the source's database holds the install of `source`'s question set, as the worker reads
   * it under its own login. Asked only for a source whose one change to the install is questions
   * added; never taken from the page's word.
   */
  readonly installed: (source: SourceConfig, config: ProjectConfig) => Promise<InstallCheck>;
  /** Reads facetdb.config.ts again through the loader; a `ConfigError` when it does not load. */
  readonly load: () => Promise<ProjectConfig>;
  /** Beats the project's heartbeat, in the scope of a source. */
  readonly beat: (source: string) => Promise<void>;
  readonly clock: Pick<Clock, "sleep">;
  readonly print: (line: string) => void;
  /** Sees each pass of a source's loop. */
  readonly onPass: (loop: SourceLoop) => (report: PassReport) => void;
  /**
   * The failure a loop stopped with, as the run reports it: the error itself unless the worker
   * words it for its source (a missing install names the source and the fix).
   */
  readonly failure?: (source: string, error: unknown) => unknown;
};

export type Fleet = {
  /** The config as the file now loads: what `GET /v1/config` shows and drafts are judged in. */
  config(): ProjectConfig;
  /**
   * The sources that do not run the file as last loaded: each `kept` or `not-started` source of the
   * reload's own plan, judged now, so it is empty once the worker runs the file.
   */
  pending(): readonly PendingSource[];
  /** Every source that runs, in the config's order. */
  loops(): readonly SourceLoop[];
  loop(name: string): SourceLoop | undefined;
  /**
   * The connector of the source `name` that the review door holds: every call goes to the connector
   * of the loop in force at that moment, and a loop a reload retires is closed only once every call
   * in flight on it has settled, so a decision across a swap never meets a closed pool.
   */
  connector(name: string): Connector;
  /** Opens every source of `config`, one after another; the caller closes the fleet on a failure. */
  open(config: ProjectConfig): Promise<void>;
  /**
   * Runs every loop until `signal` aborts or one loop fails, which stops the others; then waits for
   * every loop and any reload in hand, and throws the first failure.
   */
  run(signal: AbortSignal): Promise<void>;
  /** Reads the file again and applies it to the running loops; resolves once the plan is made. */
  reload(): Promise<ReloadSummary>;
  /** Every reload in hand has finished its swap: the restarted loops run, the stopped ones closed. */
  settled(): Promise<void>;
  /** Closes every loop's connector, after any reload in hand. */
  close(): Promise<void>;
};

/** What a reload does to one source: the pure half of the reload, judged before anything moves. */
export type ReloadStep =
  | { readonly kind: "unchanged"; readonly name: string }
  | { readonly kind: "restart"; readonly name: string; readonly source: SourceConfig }
  /** Questions added and nothing else reaching the install: switched once `installed` holds. */
  | {
      readonly kind: "added";
      readonly name: string;
      readonly source: SourceConfig;
      readonly questions: readonly string[];
    }
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "add"; readonly name: string }
  /** The change reaches the install (`facetdb migrate`) or the check API's fields (a restart). */
  | { readonly kind: "keep"; readonly name: string; readonly migrate: boolean };

function sourceJsonOf(config: ProjectConfig, source: SourceConfig): unknown {
  return toProjectJson({ ...config, sources: [source] }).sources[0];
}

/** The source as the file holds it, with its model: what one reading of its database was for. */
function sourceKey(config: ProjectConfig, source: SourceConfig): string {
  return JSON.stringify([sourceJsonOf(config, source), source.model ?? config.model]);
}

/** A question as the install sees it: its column's name and type, never its wording. */
function columnOf(question: Question): unknown {
  switch (question.type) {
    case "noul":
      return { name: question.name, type: question.type };
    case "choice":
      return {
        name: question.name,
        type: question.type,
        options: question.options.map((option) => option.name),
        storeProbabilities: question.storeProbabilities,
      };
    case "score":
      return {
        name: question.name,
        type: question.type,
        levels: question.levels.map((level) => level.name),
      };
  }
}

/**
 * What `facetdb migrate` installed for a source, or what the check API was started with for an API
 * source: a change here is never picked up by a reload. Kept wide on purpose: a change that might
 * reach the install waits for migrate and a restart, rather than writing a column that is not there.
 */
function installShape(source: SourceConfig): string {
  return JSON.stringify(installFields(source, true));
}

/** The install's fields, its questions' columns among them only when `questions` says so. */
function installFields(source: SourceConfig, questions: boolean): unknown {
  if (source.api) {
    return { api: true, read: source.read };
  }
  return {
    databaseEnv: source.databaseEnv,
    connector: source.connector,
    capture: source.capture,
    lastChanged: source.lastChanged,
    table: source.table,
    where: source.where,
    read: source.read,
    storage: source.storage,
    onChange: source.onChange,
    ...(questions
      ? {
          questions: [...source.questions]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(columnOf),
        }
      : {}),
  };
}

/**
 * The questions `next` adds to what `ran` runs, when that is its only change to the install: every
 * question the loop runs is in the file's set with the same column, and every other field the
 * install depends on is equal. Undefined for any other change, and for an API source (no install).
 */
function questionsAdded(ran: SourceConfig, next: SourceConfig): readonly string[] | undefined {
  if (ran.api || next.api) {
    return undefined;
  }
  if (JSON.stringify(installFields(ran, false)) !== JSON.stringify(installFields(next, false))) {
    return undefined;
  }
  const kept = ran.questions.every((question) => {
    const found = next.questions.find((candidate) => candidate.name === question.name);
    return (
      found !== undefined && JSON.stringify(columnOf(found)) === JSON.stringify(columnOf(question))
    );
  });
  const names = new Set(ran.questions.map((question) => question.name));
  const added = next.questions
    .filter((question) => !names.has(question.name))
    .map((question) => question.name);
  return kept && added.length > 0 ? added : undefined;
}

/**
 * Compares what each loop runs with the config as the file now loads. A loop is compared with its
 * own source and model, not with the file it started from, so a source kept on its old set by an
 * earlier reload is judged again against what it really runs.
 */
export function planReload(
  running: ReadonlyMap<string, SourceLoop>,
  next: ProjectConfig,
): readonly ReloadStep[] {
  const steps: ReloadStep[] = [];
  for (const source of next.sources) {
    const loop = running.get(source.name);
    if (loop === undefined) {
      steps.push({ kind: "add", name: source.name });
      continue;
    }
    const same =
      JSON.stringify(sourceJsonOf(next, loop.source)) ===
        JSON.stringify(sourceJsonOf(next, source)) &&
      loop.questionSet.model === (source.model ?? next.model);
    if (same) {
      steps.push({ kind: "unchanged", name: source.name });
    } else if (installShape(loop.source) !== installShape(source)) {
      const added = questionsAdded(loop.source, source);
      steps.push(
        added === undefined
          ? { kind: "keep", name: source.name, migrate: !source.api }
          : { kind: "added", name: source.name, source, questions: added },
      );
    } else {
      steps.push({ kind: "restart", name: source.name, source });
    }
  }
  const named = new Set(next.sources.map((source) => source.name));
  for (const name of running.keys()) {
    if (!named.has(name)) {
      steps.push({ kind: "remove", name });
    }
  }
  return steps;
}

/** The project's own settings a running worker holds from its start: a change takes a restart. */
function projectNotes(started: ProjectConfig, next: ProjectConfig): string[] {
  const fields = (["modelUrl", "spendingCap", "onCapReached", "alerts"] as const).filter(
    (field) => JSON.stringify(started[field]) !== JSON.stringify(next[field]),
  );
  return fields.length === 0
    ? []
    : [
        `The project's ${fields.join(", ")} changed in facetdb.config.ts; the worker keeps what it started with until you restart facetdb worker.`,
      ];
}

/** What a reload says of a source that is new in the file: the Apply dialog and the pending list use it. */
const NOT_STARTED_MESSAGE =
  "new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.";

/** What a reload says of a source it keeps on what it runs, and why. */
function keptMessage(migrate: boolean, version: number | null): string {
  return migrate
    ? `the change reaches what facetdb migrate installed (a question added or removed, a type, options or levels, read, where, the table, storage or capture), so it keeps answering with version ${version} until you run facetdb migrate and restart facetdb worker.`
    : `the fields it reads changed, so it keeps answering with version ${version} until you restart facetdb worker.`;
}

/** The questions a source adds, named for a sentence: "the question a", "the questions a and b". */
function namesOf(questions: readonly string[]): string {
  return questions.length === 1
    ? `the question ${questions[0]}`
    : `the questions ${questions.slice(0, -1).join(", ")} and ${questions.at(-1)}`;
}

/** What a reload says of a source it switches once its added questions are installed. */
function switchedMessage(questions: readonly string[], version: number): string {
  return `the columns of ${namesOf(questions)} are in its database and the worker login may write them: it finishes the batch in hand, then answers with version ${version}; nothing already answered is asked again.`;
}

/** Why a source with questions added was not switched: the check's finding, or the read that failed. */
type Unswitched =
  | Exclude<InstallCheck, { readonly kind: "holds" }>
  | { readonly kind: "unread"; readonly why: string };

/** What a reload says of a source whose added questions it does not switch to, and what to do. */
function addedMessage(
  name: string,
  questions: readonly string[],
  check: Unswitched,
  version: number | null,
): string {
  const keeps = `so it keeps answering with version ${version}`;
  const one = questions.length === 1;
  switch (check.kind) {
    case "missing":
      return `${namesOf(questions)} ${one ? "is" : "are"} not installed in its database yet (${check.missing}), ${keeps}. Install ${one ? "it" : "them"} from the Questions page, or run facetdb migrate --source ${name}, then Check again.`;
    case "unread":
      return `its database could not be read to check ${namesOf(questions)} (${check.why}), ${keeps}. Check again once the database answers; facetdb doctor says what is wrong.`;
    case "cannot-tell":
      return `${namesOf(questions)} ${one ? "needs its columns" : "need their columns"}, and ${check.why}, ${keeps} until you run facetdb migrate --source ${name} and restart facetdb worker.`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Slot = {
  readonly loop: SourceLoop;
  /** Stops this loop alone, after its pass in hand. */
  readonly halt: AbortController;
  /** The loop's run; undefined until the fleet runs. It never rejects: a failure is the fleet's. */
  done: Promise<void> | undefined;
  /** Calls in flight on its connector from the review door (`Fleet.connector`). */
  busy: number;
  /** Told when `busy` comes back to 0: a retiring loop waits for it before it closes. */
  idle: (() => void)[];
};

export function createFleet(deps: FleetDeps): Fleet {
  const slots = new Map<string, Slot>();
  /** The config as the file loaded last; the project settings the worker started with. */
  let current: ProjectConfig | undefined;
  let started: ProjectConfig | undefined;
  /** Set by `run`: the stop of every loop, and whether loops are launched. */
  let ending: AbortSignal | undefined;
  const failed = new AbortController();
  let failure: { readonly error: unknown } | undefined;
  /** Reloads one at a time, each after the swap of the one before. */
  let queue: Promise<void> = Promise.resolve();
  /**
   * The last reading of each source whose added questions were not switched to, for the file's
   * source as it was then: `pending()` says the same until a reload reads the database again.
   */
  const unswitched = new Map<string, { readonly file: string; readonly check: Unswitched }>();

  const slotOf = (loop: SourceLoop): Slot => ({
    loop,
    halt: new AbortController(),
    done: undefined,
    busy: 0,
    idle: [],
  });

  /** Runs one connector call on the loop in force for `name`, held open until the call settles. */
  async function borrow<Result>(
    name: string,
    use: (connector: Connector) => Promise<Result>,
  ): Promise<Result> {
    const slot = slots.get(name);
    if (slot === undefined) {
      throw new Error(`the source ${name} no longer runs in this worker`);
    }
    slot.busy += 1;
    try {
      return await use(slot.loop.connector);
    } finally {
      slot.busy -= 1;
      if (slot.busy === 0) {
        for (const wake of slot.idle.splice(0)) {
          wake();
        }
      }
    }
  }

  function routed(name: string): Connector {
    const inForce = (): Connector => {
      const slot = slots.get(name);
      if (slot === undefined) {
        throw new Error(`the source ${name} no longer runs in this worker`);
      }
      return slot.loop.connector;
    };
    return {
      get capabilities() {
        return inForce().capabilities;
      },
      install: () => borrow(name, (connector) => connector.install()),
      uninstall: () => borrow(name, (connector) => connector.uninstall()),
      watch: () => inForce().watch(),
      read: (keys) => borrow(name, (connector) => connector.read(keys)),
      write: (key, decision, hash) =>
        borrow(name, (connector) => connector.write(key, decision, hash)),
      current: (keys) => borrow(name, (connector) => connector.current(keys)),
      scan: (cursor) => borrow(name, (connector) => connector.scan(cursor)),
      enqueue: (keys) => borrow(name, (connector) => connector.enqueue(keys)),
      claim: (limit) => borrow(name, (connector) => connector.claim(limit)),
      claimKey: (key) => borrow(name, (connector) => connector.claimKey(key)),
      ack: (keys) => borrow(name, (connector) => connector.ack(keys)),
      release: (keys) => borrow(name, (connector) => connector.release(keys)),
    };
  }

  function launch(slot: Slot, stop: AbortSignal): void {
    slot.done = slot.loop.worker
      .run(AbortSignal.any([stop, slot.halt.signal]), deps.onPass(slot.loop))
      .catch((error: unknown) => {
        // One loop failing (its database gone, say) stops the others too, so every claim is
        // settled before the connectors close; the first failure is what the run reports.
        failure ??= {
          error: deps.failure === undefined ? error : deps.failure(slot.loop.source.name, error),
        };
        failed.abort();
      });
  }

  /** Stops one loop after its pass in hand: every claim of that pass acked or released. */
  async function stop(slot: Slot): Promise<void> {
    slot.halt.abort();
    await slot.done;
  }

  /**
   * Closes a stopped loop once it is out of `slots` (no new call reaches it) and every review call
   * in flight on its connector has settled: those finish on the pool they started on.
   */
  async function retire(slot: Slot): Promise<void> {
    while (slot.busy > 0) {
      await new Promise<void>((wake) => {
        slot.idle.push(wake);
      });
    }
    try {
      await slot.loop.close();
    } catch (error) {
      deps.print(
        `${slot.loop.source.name}: closing its previous connection failed: ${messageOf(error)}`,
      );
    }
  }

  async function beat(source: string): Promise<void> {
    try {
      await deps.beat(source);
    } catch (error) {
      deps.print(`the heartbeat could not be saved during the reload: ${messageOf(error)}`);
    }
  }

  /** The loops of a reload stop and start; the fleet beats until every one has. */
  async function swap(
    restarts: readonly { readonly slot: Slot; readonly fresh: SourceLoop }[],
    removals: readonly Slot[],
  ): Promise<void> {
    const work = Promise.all([
      ...restarts.map(async ({ slot, fresh }) => {
        await stop(slot);
        // The records the old loop's outage policy holds are the new one's to retry: a restart
        // drops none of them (each comes back on the new policy's next retry).
        if (slot.loop.outage !== undefined && fresh.outage !== undefined) {
          fresh.outage.hold(slot.loop.outage.held);
        }
        const next = slotOf(fresh);
        slots.set(fresh.source.name, next);
        // A worker stopping meanwhile starts nothing: `close` closes it with the rest.
        if (ending !== undefined && !ending.aborted) {
          launch(next, ending);
        }
        await retire(slot);
      }),
      ...removals.map(async (slot) => {
        await stop(slot);
        slots.delete(slot.loop.source.name);
        await retire(slot);
      }),
    ]);
    const scope = (restarts[0]?.slot ?? removals[0])?.loop.source.name ?? "worker";
    const over = work.then(
      () => "over" as const,
      () => "over" as const,
    );
    for (;;) {
      await beat(scope);
      const woke = await Promise.race([
        deps.clock.sleep(RELOAD_BEAT_EVERY_MS).then(() => "beat" as const),
        over,
      ]);
      if (woke === "over") {
        break;
      }
    }
    await work;
  }

  async function reloadNow(): Promise<{ summary: ReloadSummary; swapped: Promise<void> }> {
    const done = Promise.resolve();
    let next: ProjectConfig;
    try {
      next = await deps.load();
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message
          : `facetdb.config.ts could not be loaded: ${messageOf(error)}`;
      deps.print(
        `${message}\nThe worker keeps running on the config it had; fix facetdb.config.ts, then apply again or restart facetdb worker.`,
      );
      return {
        summary: {
          loaded: false,
          message: `facetdb.config.ts was written but does not load, so the worker keeps running on the config it had. ${message}`,
          fix: "Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.",
        },
        swapped: done,
      };
    }
    const steps = planReload(new Map([...slots].map(([name, slot]) => [name, slot.loop])), next);
    const notes = started === undefined ? [] : projectNotes(started, next);
    current = next;
    const sources: SourceReload[] = [];
    const restarts: { slot: Slot; fresh: SourceLoop }[] = [];
    const removals: Slot[] = [];
    const say = (reload: SourceReload) => {
      sources.push(reload);
      if (reload.message !== null) {
        deps.print(`${reload.source}: ${reload.message}`);
      }
    };
    /** Opens the source anew under `source`; on success its loop swaps after the batch in hand. */
    const openAnew = async (
      slot: Slot,
      source: SourceConfig,
      words: (version: number) => string,
    ): Promise<void> => {
      const version = slot.loop.version;
      let fresh: SourceLoop;
      try {
        fresh = await deps.open(source, next);
      } catch (error) {
        say({
          source: source.name,
          outcome: "failed",
          version,
          message: `could not start with the new question set (${messageOf(error)}), so it keeps answering with version ${version}; check it with facetdb doctor, then restart facetdb worker.`,
        });
        return;
      }
      restarts.push({ slot, fresh });
      say({
        source: source.name,
        outcome: "restarted",
        version: fresh.version,
        message: words(fresh.version),
      });
    };
    for (const step of steps) {
      const slot = slots.get(step.name);
      const version = slot?.loop.version ?? null;
      switch (step.kind) {
        case "unchanged":
          say({ source: step.name, outcome: "unchanged", version, message: null });
          break;
        case "add":
          say({
            source: step.name,
            outcome: "not-started",
            version: null,
            message: NOT_STARTED_MESSAGE,
          });
          break;
        case "keep":
          say({
            source: step.name,
            outcome: "kept",
            version,
            message: keptMessage(step.migrate, version),
          });
          break;
        case "remove":
          if (slot !== undefined) {
            removals.push(slot);
          }
          say({
            source: step.name,
            outcome: "stopped",
            version: null,
            message:
              "no longer in facetdb.config.ts, so it stops after the batch in hand; its answers and log stay.",
          });
          break;
        case "restart":
          if (slot !== undefined) {
            await openAnew(
              slot,
              step.source,
              (fresh) =>
                `the question set changed: it finishes the batch in hand, then answers with version ${fresh}; nothing already answered is asked again.`,
            );
          }
          break;
        case "added": {
          if (slot === undefined) {
            break;
          }
          // The switch is made on the worker's own reading of the database, never on the page's
          // word: a loop started on missing columns would fail every write.
          let check: InstallCheck | Unswitched;
          try {
            check = await deps.installed(step.source, next);
          } catch (error) {
            check = { kind: "unread", why: messageOf(error) };
          }
          if (check.kind !== "holds") {
            unswitched.set(step.name, { file: sourceKey(next, step.source), check });
            say({
              source: step.name,
              outcome: "kept",
              version,
              message: addedMessage(step.name, step.questions, check, version),
            });
            break;
          }
          unswitched.delete(step.name);
          await openAnew(slot, step.source, (fresh) => switchedMessage(step.questions, fresh));
          break;
        }
      }
    }
    for (const note of notes) {
      deps.print(note);
    }
    const swapped = restarts.length + removals.length === 0 ? done : swap(restarts, removals);
    return { summary: { loaded: true, sources, notes }, swapped };
  }

  function loopsInOrder(): SourceLoop[] {
    const order = (current?.sources ?? []).map((source) => source.name);
    const at = (name: string) => {
      const index = order.indexOf(name);
      return index === -1 ? order.length : index;
    };
    return [...slots.values()]
      .map((slot) => slot.loop)
      .sort((a, b) => at(a.source.name) - at(b.source.name));
  }

  /** The reload's plan against the file as last loaded, read again whenever it is asked. */
  function pendingNow(): PendingSource[] {
    if (current === undefined) {
      return [];
    }
    const file = current;
    const steps = planReload(new Map([...slots].map(([name, slot]) => [name, slot.loop])), file);
    const pending: PendingSource[] = [];
    for (const step of steps) {
      const wanted = file.sources.find((source) => source.name === step.name);
      if (step.kind === "add" && wanted !== undefined) {
        pending.push({
          source: step.name,
          outcome: "not-started",
          message: NOT_STARTED_MESSAGE,
          migrate: !wanted.api,
          added: [],
          removed: [],
          checkAgain: false,
        });
      } else if (step.kind === "added" && wanted !== undefined) {
        const version = slots.get(step.name)?.loop.version ?? null;
        const read = unswitched.get(step.name);
        // Read for the file as it is now, or not since it changed: a reload reads it again.
        const check: Unswitched =
          read !== undefined && read.file === sourceKey(file, wanted)
            ? read.check
            : { kind: "missing", missing: "not checked since the file changed" };
        pending.push({
          source: step.name,
          outcome: "kept",
          message: addedMessage(step.name, step.questions, check, version),
          migrate: true,
          added: [...step.questions],
          removed: [],
          checkAgain: check.kind !== "cannot-tell",
        });
      } else if (step.kind === "keep" && wanted !== undefined) {
        const running = slots.get(step.name)?.loop;
        const ran = new Set(running?.questionSet.questions.map((question) => question.name));
        const held = new Set(wanted.questions.map((question) => question.name));
        pending.push({
          source: step.name,
          outcome: "kept",
          message: keptMessage(step.migrate, running?.version ?? null),
          migrate: step.migrate,
          added: [...held].filter((name) => !ran.has(name)),
          removed: [...ran].filter((name) => !held.has(name)),
          checkAgain: false,
        });
      }
    }
    return pending;
  }

  return {
    config() {
      if (current === undefined) {
        throw new Error("the fleet was never opened");
      }
      return current;
    },
    pending: pendingNow,
    loops: loopsInOrder,
    loop: (name) => slots.get(name)?.loop,
    connector: routed,

    async open(config) {
      current = config;
      started = config;
      for (const source of config.sources) {
        slots.set(source.name, slotOf(await deps.open(source, config)));
      }
    },

    async run(signal) {
      const stop = AbortSignal.any([signal, failed.signal]);
      ending = stop;
      for (const slot of slots.values()) {
        launch(slot, stop);
      }
      await new Promise<void>((resolve) => {
        if (stop.aborted) {
          resolve();
        } else {
          stop.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      // A reload in hand finishes its swap (it starts nothing now), then every loop has stopped.
      await queue;
      await Promise.all([...slots.values()].map((slot) => slot.done));
      if (failure !== undefined) {
        throw failure.error;
      }
    },

    reload() {
      const planned = queue.then(reloadNow);
      queue = planned.then(
        ({ swapped }) => swapped,
        () => undefined,
      );
      return planned.then(({ summary }) => summary);
    },

    settled: () => queue,

    async close() {
      await queue;
      for (const slot of slots.values()) {
        // A review call still in flight finishes on its pool first.
        while (slot.busy > 0) {
          await new Promise<void>((wake) => {
            slot.idle.push(wake);
          });
        }
        await slot.loop.close();
      }
    },
  };
}

/**
 * A read-only map whose every read asks `entries` afresh: the review door's per-source lookups
 * (`ReviewServiceDeps`) over the fleet, so a decision after a reload reads the loop in force, never a
 * map fixed at startup. The review service looks a source up once per call.
 */
class LiveMap<Value> implements ReadonlyMap<string, Value> {
  readonly #entries: () => Iterable<readonly [string, Value]>;

  constructor(entries: () => Iterable<readonly [string, Value]>) {
    this.#entries = entries;
  }

  #now(): Map<string, Value> {
    return new Map(this.#entries());
  }

  get size(): number {
    return this.#now().size;
  }

  get(key: string): Value | undefined {
    return this.#now().get(key);
  }

  has(key: string): boolean {
    return this.#now().has(key);
  }

  forEach(
    callback: (value: Value, key: string, map: ReadonlyMap<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#now()) {
      callback.call(thisArg, value, key, this);
    }
  }

  entries(): MapIterator<[string, Value]> {
    return this.#now().entries();
  }

  keys(): MapIterator<string> {
    return this.#now().keys();
  }

  values(): MapIterator<Value> {
    return this.#now().values();
  }

  [Symbol.iterator](): MapIterator<[string, Value]> {
    return this.#now()[Symbol.iterator]();
  }
}

/**
 * What the review door decides with, per source by its store id, read from the loop in force on
 * every call: the connector routed through the fleet, the question set and version the loop answers
 * under, the actions `actionsOf` gives that loop's source (the one source of actions for both
 * doors), and the source's decision log.
 */
export function reviewLookups(
  fleet: Pick<Fleet, "loops" | "connector">,
  of: {
    readonly idOf: (name: string) => string;
    readonly log: (name: string) => DecisionLog;
    readonly actionsOf: (source: SourceConfig) => readonly ActionStep[];
  },
): Pick<ReviewServiceDeps, "log" | "connectors" | "actions" | "questionSets"> {
  const each = <Value>(value: (loop: SourceLoop) => Value) =>
    new LiveMap(() =>
      fleet.loops().map((loop) => [of.idOf(loop.source.name), value(loop)] as const),
    );
  return {
    log: each((loop) => of.log(loop.source.name)),
    connectors: each((loop) => fleet.connector(loop.source.name)),
    actions: each((loop) => of.actionsOf(loop.source)),
    questionSets: each((loop) => ({ questionSet: loop.questionSet, version: loop.version })),
  };
}

/** Runs the work it is given one at a time, in the order given; a failure does not stop the next. */
export type FileQueue = <Result>(work: () => Promise<Result>) => Promise<Result>;

export function fileQueue(): FileQueue {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
}

/**
 * The studio's door to facetdb.config.ts (`ServerDeps.config.file`): the diff a draft makes, and on
 * confirmation the write and the fleet's reload. The draft is judged within the project as the file
 * loads now, so a change committed to the file since the worker started is kept, not reverted.
 * Applies run one at a time.
 */
export function configFileDoor(deps: {
  /** The config file, as `--config` names it. */
  readonly path: string;
  readonly files: ConfigFiles;
  /** The loader, quiet: its warnings are the draft's, returned with the diff. */
  readonly load: () => Promise<ProjectConfig>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reload: () => Promise<ReloadSummary>;
  /**
   * The queue its applies run in, one at a time; the studio's setup flow writes the same file
   * through the same queue. Its own when absent.
   */
  readonly serial?: FileQueue;
}): ConfigFileDoor {
  const { path, files } = deps;
  const serial = deps.serial ?? fileQueue();

  async function plan(
    draft: SourceDraft,
  ): Promise<
    | { readonly ok: true; readonly plan: ApplyPlan }
    | Extract<FileDiff, { readonly kind: "invalid" | "unreadable" }>
  > {
    const read = await files.read(path);
    if (read.kind !== "file") {
      return {
        kind: "unreadable",
        message:
          read.kind === "missing"
            ? `${path} is not there any more, so there is no file to apply the draft to`
            : `${path} is a link or a directory, and Apply writes only a regular file`,
        fix:
          read.kind === "missing"
            ? `put ${path} back (git checkout ${path}), then apply again`
            : `make ${path} a regular file in the project, then apply again`,
      };
    }
    let config: ProjectConfig;
    try {
      config = await deps.load();
    } catch (error) {
      if (error instanceof ConfigError) {
        return {
          kind: "unreadable",
          message: `${path} does not load as it is now, so the draft cannot be placed in it. ${error.message}`,
          fix: `fix each line named in ${path}, then apply again`,
        };
      }
      throw error;
    }
    const planned = planApply({ path, text: read.text, config }, draft, deps.env);
    return planned.ok ? planned : { kind: "invalid", issues: planned.issues };
  }

  return {
    // Check again: the file as it is, read again in the same queue as the writes.
    reload: () => serial(() => deps.reload()),

    diff: (draft) =>
      serial(async (): Promise<FileDiff> => {
        const planned = await plan(draft);
        if (!("ok" in planned)) {
          return planned;
        }
        const { plan: shown } = planned;
        return {
          kind: "planned",
          path,
          diff: shown.diff,
          changed: shown.changed,
          plan: shown.id,
          uncommitted: shown.changed
            ? (uncommittedWords(await files.gitState(path), path) ?? null)
            : null,
          warnings: shown.warnings,
        };
      }),

    apply: (draft, options) =>
      serial(async (): Promise<FileApply> => {
        const planned = await plan(draft);
        if (!("ok" in planned)) {
          return planned;
        }
        const { plan: shown } = planned;
        if (shown.id !== options.plan) {
          return { kind: "stale" };
        }
        const written = await apply(shown, { force: options.force, files });
        switch (written.kind) {
          case "unchanged":
            return { kind: "unchanged", path };
          case "moved":
            return { kind: "stale" };
          case "not-a-file":
            return {
              kind: "unreadable",
              message: `${path} is a link or a directory, and Apply writes only a regular file`,
              fix: `make ${path} a regular file in the project, then apply again`,
            };
          case "uncommitted":
            return { kind: "uncommitted", message: written.message, fix: written.fix };
          case "written": {
            const reload = await deps.reload();
            if (reload.loaded) {
              return { kind: "applied", path, diff: shown.diff, reload };
            }
            // The file as written does not load: put back the text the plan started from (aside
            // and renamed, as written), so the file and the worker agree again and a restart works.
            await files.replace(path, shown.before);
            return {
              kind: "reverted",
              message: `${path} was written, but it does not load, so it was put back as it was and nothing changed. ${reload.message}`,
              fix: `fix ${path} by hand so it loads, then apply again; if the draft alone causes this, report it with the draft`,
            };
          }
        }
      }),
  };
}
