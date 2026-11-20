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
 *  - a change that reaches the database's install (a question added or removed, a type, options or
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

export type FleetDeps = {
  /**
   * Records the source's question-set version, opens what it reads and builds its worker. The fleet
   * closes what it returns.
   */
  readonly open: (source: SourceConfig, config: ProjectConfig) => Promise<SourceLoop>;
  /** Reads facetdb.config.ts again through the loader; a `ConfigError` when it does not load. */
  readonly load: () => Promise<ProjectConfig>;
  /** Beats the project's heartbeat, in the scope of a source. */
  readonly beat: (source: string) => Promise<void>;
  readonly clock: Pick<Clock, "sleep">;
  readonly print: (line: string) => void;
  /** Sees each pass of a source's loop. */
  readonly onPass: (loop: SourceLoop) => (report: PassReport) => void;
};

export type Fleet = {
  /** The config as the file now loads: what `GET /v1/config` shows and drafts are judged in. */
  config(): ProjectConfig;
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
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "add"; readonly name: string }
  /** The change reaches the install (`facetdb migrate`) or the check API's fields (a restart). */
  | { readonly kind: "keep"; readonly name: string; readonly migrate: boolean };

function sourceJsonOf(config: ProjectConfig, source: SourceConfig): unknown {
  return toProjectJson({ ...config, sources: [source] }).sources[0];
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
  if (source.api) {
    return JSON.stringify({ api: true, read: source.read });
  }
  return JSON.stringify({
    databaseEnv: source.databaseEnv,
    connector: source.connector,
    capture: source.capture,
    lastChanged: source.lastChanged,
    table: source.table,
    where: source.where,
    read: source.read,
    storage: source.storage,
    onChange: source.onChange,
    questions: [...source.questions].sort((a, b) => a.name.localeCompare(b.name)).map(columnOf),
  });
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
      steps.push({ kind: "keep", name: source.name, migrate: !source.api });
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
        failure ??= { error };
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
            message:
              "new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.",
          });
          break;
        case "keep":
          say({
            source: step.name,
            outcome: "kept",
            version,
            message: step.migrate
              ? `the change reaches what facetdb migrate installed (a question added or removed, a type, options or levels, read, where, the table, storage or capture), so it keeps answering with version ${version} until you run facetdb migrate and restart facetdb worker.`
              : `the fields it reads changed, so it keeps answering with version ${version} until you restart facetdb worker.`,
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
        case "restart": {
          if (slot === undefined) {
            break;
          }
          let fresh: SourceLoop;
          try {
            fresh = await deps.open(step.source, next);
          } catch (error) {
            say({
              source: step.name,
              outcome: "failed",
              version,
              message: `could not start with the new question set (${messageOf(error)}), so it keeps answering with version ${version}; check it with facetdb doctor, then restart facetdb worker.`,
            });
            break;
          }
          restarts.push({ slot, fresh });
          say({
            source: step.name,
            outcome: "restarted",
            version: fresh.version,
            message: `the question set changed: it finishes the batch in hand, then answers with version ${fresh.version}; nothing already answered is asked again.`,
          });
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

  return {
    config() {
      if (current === undefined) {
        throw new Error("the fleet was never opened");
      }
      return current;
    },
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
}): ConfigFileDoor {
  const { path, files } = deps;
  let queue: Promise<unknown> = Promise.resolve();

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

  function serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
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
