import type { Clock, Connector, CursorStore, RecordKey, StateValue } from "@facetdb/core";
import { type PluginContext, SourceAccessLost, type SourceContext } from "./kinds.ts";
import type { HostedSource } from "./source-host.ts";

/**
 * A plugin source as a `Connector`: the queue, the claims, the writes and the reads of decided
 * records are the FacetDB store's, through its store connector, exactly as an API source's are; the
 * plugin only says which keys changed and what their state is. A plugin never writes a decision:
 * the worker writes it through the store, only while the record's state hash still matches, and a
 * record's state lives in `facetdb.records` alone.
 *
 * What feeds the store:
 * - `intake(keys)` reads the keys through the plugin's `read` and stores each row with the store's
 *   `upsertRecord`: a changed state (or a new record) goes back to pending and is queued, in one
 *   transaction; the same state again queues nothing; a key the plugin leaves out is skipped (its
 *   record, if the store holds one, stays as it was, and nothing is queued). What the plugin returns
 *   is untrusted: a row is refused, and its key not queued, when its key is not one it was asked
 *   for, when it returns a key twice, when its state is not an object of text-or-null for every
 *   field the source reads, holds text the store cannot keep, or is larger than `MAX_STATE_BYTES`.
 * - the pump runs the plugin's `watch` into `intake` from the first `watch()` until `close()`, under
 *   the source's own signal; a batch is taken in before the next is asked for, and the cursor the
 *   plugin saves is written only once every key it yielded before has been taken in.
 * - `receive(request)` runs the plugin's `receive` on an inbound HTTP event and takes its keys in.
 *
 * A plugin's own error never reaches a line, the store, an alert or the dashboard: what it threw
 * could quote a secret it was handed (the rule the plugin and action hosts follow). The worker
 * says, in fixed words, which plugin failed where; a `SourceAccessLost` is said as a refused
 * credential, naming the variables the source reads.
 */

/** The largest state a plugin's row may hold, as JSON in UTF-8: 1 MiB, far past the 32,000 tokens the worker asks about by default. */
export const MAX_STATE_BYTES = 1_048_576;

/** The longest cursor a plugin may save: one string per source, kept in the store. */
export const MAX_CURSOR_LENGTH = 65_536;

/**
 * The longest key a plugin may name, in UTF-8 bytes. A key is the store's `record_key`: text in the
 * primary key of `facetdb.records`, and, behind the source's length-prefixed store id, in the
 * primary key of `facetdb.jobs`. A btree entry holds at most about 2,700 bytes (a third of an 8 kB
 * page), so 1,024 bytes leaves room for the prefix and the other columns many times over, and is
 * far past any key a service hands out (`acme/web#1234`, a UUID, a ticket number).
 */
export const MAX_KEY_BYTES = 1_024;

/**
 * Why a key a plugin named is not one the store keeps, or undefined when it is: text, not empty,
 * with no control character (a NUL, which Postgres text cannot hold, a line break, an escape), no
 * lone surrogate (which a UTF-8 database refuses), and at most `MAX_KEY_BYTES`.
 */
export function keyProblem(key: unknown): string | undefined {
  if (typeof key !== "string") {
    return "it is not text";
  }
  if (key === "") {
    return "it is empty";
  }
  if (/\p{Cc}/u.test(key)) {
    return "it holds a control character (a NUL, a line break or an escape)";
  }
  if (!key.isWellFormed()) {
    return "it holds a lone surrogate";
  }
  const size = Buffer.byteLength(key, "utf8");
  if (size > MAX_KEY_BYTES) {
    return `it is ${size} bytes, more than the ${MAX_KEY_BYTES} a key may hold`;
  }
  return undefined;
}

/** The most characters of a plugin source's key a line prints. */
const SHOWN_KEY_LENGTH = 64;

/**
 * A plugin source's key as a line may print it: its control, format and line or paragraph
 * separator characters taken out (a line break or a terminal escape could forge or garble a line),
 * and at most `SHOWN_KEY_LENGTH` characters. A key printed otherwise than as it is ends with its
 * length, so two keys shown alike can be told apart in the store.
 */
export function printableKey(key: string): string {
  const cleaned = key.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  if (cleaned === key && [...key].length <= SHOWN_KEY_LENGTH) {
    return key;
  }
  const short = [...cleaned].slice(0, SHOWN_KEY_LENGTH).join("");
  return `${short}… (a key of ${key.length} characters, shown in part)`;
}

/** The store connector's side the adapter needs: the connector contract, and the app's own write. */
export type RecordStore = Connector & {
  /** Stores a record's state; a changed or new state is queued, the same state changes nothing (false). */
  upsertRecord(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<boolean>;
};

/** What one `intake` did with each key it was given. */
export type IntakeReport = {
  /** Stored with a state that changed, or new: queued for the worker. */
  readonly queued: readonly RecordKey[];
  /** Stored at the state the store already held: nothing queued. */
  readonly unchanged: readonly RecordKey[];
  /** Left out by the plugin's `read` (gone from the service, or never there): nothing stored or queued. */
  readonly skipped: readonly RecordKey[];
  /**
   * A key the store cannot keep (`keyProblem`), or a row returned in a shape the store does not
   * take, with why: nothing read, stored or queued for it, and the batch's other keys go on.
   */
  readonly refused: readonly { readonly key: RecordKey; readonly why: string }[];
  /** Rows the plugin returned for keys it was not asked for: dropped, never stored. */
  readonly strangers: number;
};

/** What `receive` answered: the plugin's status, and what was taken in of the keys it named. */
export type ReceiveOutcome = {
  readonly status: number;
  readonly intake: IntakeReport;
};

export type PluginSourceConnector = Connector & {
  intake(keys: readonly RecordKey[]): Promise<IntakeReport>;
  /**
   * Runs the plugin's `receive` on an inbound event (the route that calls it is not built yet). A
   * source without `receive` answers 404, and a stopped one 503, with nothing taken in.
   */
  receive(request: Request): Promise<ReceiveOutcome>;
  /**
   * Tells `heard` each time the plugin is seen working: a read through it that answered. A pass of
   * the store's queue says nothing of the plugin, so the worker's backoff after a failure starts
   * over on this alone.
   */
  onWorking(heard: () => void): void;
  /** Stops the pump and waits for the batch in hand to be stored; the plugin's `watch` is told by its signal. */
  close(): Promise<void>;
};

export type PluginSourceDeps = {
  /** The source's queue and records in the store (`store.connector({ sourceId, fields, workerId })`). */
  readonly store: RecordStore;
  /** The source's name in the config. */
  readonly name: string;
  readonly hosted: HostedSource;
  /** The plugin's context with `signal`: the plugin host's `contextFor` of the source's plugin. */
  readonly context: (signal: AbortSignal) => PluginContext<unknown>;
  /** The state fields the source reads, in config order: what the store keeps and hashes. */
  readonly fields: readonly string[];
  /** The worker's clock, handed to the plugin as its own. */
  readonly clock: Pick<Clock, "now" | "sleep">;
  /** Where the source's one cursor is kept: the store's cursors. */
  readonly cursors: CursorStore;
  /** The cursor's key there: `plugin-source:` and the source's store id (`sourceIdOf(project, name)`). */
  readonly cursorRun: string;
  /** Tells the operator of a row refused or a key not asked for, in the worker's lines. */
  readonly note: (line: string) => void;
};

/** A plugin function failed in a way that is not a refused credential, in FacetDB's words alone. */
export class PluginSourceFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSourceFailed";
  }
}

/** The source stopped while a plugin call was in hand: the call's outcome is not used. */
class Stopped extends Error {
  constructor() {
    super("the source stopped");
    this.name = "Stopped";
  }
}

type Step = "watch" | "read" | "receive";

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EMPTY: IntakeReport = { queued: [], unchanged: [], skipped: [], refused: [], strangers: 0 };

export function createPluginSourceConnector(deps: PluginSourceDeps): PluginSourceConnector {
  const { store, hosted, fields, clock, cursors, cursorRun, note } = deps;
  const about = `the plugin ${hosted.packageName} (source ${hosted.entry} of ${deps.name})`;
  /** The source's own signal: aborted by `close`, it ends the pump, the plugin's waits and its calls. */
  const stop = new AbortController();
  /** Read afresh every time: the stop may come during any wait. */
  const stopped = (): boolean => stop.signal.aborted;
  /** Each `watch()` running, told of the keys an intake queued and of the pump's failure. */
  const listeners = new Set<{ push(keys: readonly RecordKey[]): void; wake(): void }>();
  /** Told each time a read through the plugin answers (`onWorking`). */
  const working: (() => void)[] = [];
  let pump: Promise<void> | undefined;
  let failure: { readonly error: Error } | undefined;
  /** The pump's batch in hand: a cursor is saved only once it has been taken in. */
  let taking: Promise<unknown> = Promise.resolve();

  const aborted = new Promise<typeof stop>((resolve) => {
    stop.signal.addEventListener("abort", () => resolve(stop), { once: true });
  });

  /** A plugin call, abandoned when the source stops, its failure worded by FacetDB. */
  async function call<Result>(step: Step, work: () => Promise<Result>): Promise<Result> {
    if (stopped()) {
      throw new Stopped();
    }
    // Started a turn later, so a function that throws at once is caught as one that rejects; and
    // its failure after a stop, when nobody waits for it any more, is dropped, never unhandled.
    const pending = Promise.resolve().then(work);
    pending.catch(() => undefined);
    let outcome: Result | typeof stop;
    try {
      outcome = await Promise.race([pending, aborted]);
    } catch (error) {
      if (stopped()) {
        throw new Stopped();
      }
      throw worded(step, error);
    }
    if (outcome === stop) {
      throw new Stopped();
    }
    return outcome as Result;
  }

  /** What a plugin's failure says, in fixed words: its own message is never kept. */
  function worded(step: Step, error: unknown): Error {
    if (error instanceof Error && error.name === "SourceAccessLost") {
      const reads =
        hosted.variables.length === 0
          ? "the credential the plugin uses"
          : `the ${hosted.variables.length === 1 ? "variable" : "variables"} ${hosted.variables.join(" and ")}`;
      return new SourceAccessLost(
        `${about} lost access: the service it reads refused its credential in ${step}; check ${reads} and the rights granted to it`,
      );
    }
    return new PluginSourceFailed(
      `${about} failed in ${step} (its own words are not shown, as they could quote a secret it was handed)`,
    );
  }

  const cursor: SourceContext<unknown>["cursor"] = {
    async load() {
      const saved = await cursors.load(cursorRun);
      return saved?.cursor ?? null;
    },
    async save(value) {
      if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) {
        throw new TypeError(
          `a source's cursor is a string of at most ${MAX_CURSOR_LENGTH} characters`,
        );
      }
      // Only once every key yielded before it is in the store: a crash between the two then
      // repeats work and never skips it. A batch that failed was not taken in: nothing is saved.
      await taking;
      if (stopped() || failure !== undefined) {
        throw new Stopped();
      }
      // `done`: a resting place, never an unfinished backfill, so uninstall's sweep never reads
      // it as one that keeps the store (it names no source a table uninstall knows).
      await cursors.save(cursorRun, { cursor: value, done: true });
    },
  };

  function contextOf(signal: AbortSignal): SourceContext<unknown> {
    return {
      ...deps.context(signal),
      source: { name: deps.name, settings: hosted.settings, actions: hosted.actions },
      clock: {
        now: () => clock.now(),
        // The source's stop ends any wait, whatever signal the plugin passes.
        sleep: (ms, own) =>
          clock.sleep(ms, own === undefined ? stop.signal : AbortSignal.any([own, stop.signal])),
      },
      cursor,
    };
  }

  /** The rows a plugin returned, judged: the stored states by key, and what was refused. */
  function judge(asked: readonly RecordKey[], returned: unknown) {
    if (!Array.isArray(returned)) {
      throw new PluginSourceFailed(
        `${about} returned something other than a list of rows from read`,
      );
    }
    const wanted = new Set(asked);
    const seen = new Map<RecordKey, number>();
    let strangers = 0;
    for (const row of returned as readonly unknown[]) {
      const key = isObject(row) ? row["key"] : undefined;
      if (typeof key !== "string" || !wanted.has(key)) {
        strangers += 1;
        continue;
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const states = new Map<RecordKey, Record<string, StateValue>>();
    const refused: { key: RecordKey; why: string }[] = [];
    for (const row of returned as readonly unknown[]) {
      const key = isObject(row) ? row["key"] : undefined;
      if (typeof key !== "string" || !wanted.has(key) || !isObject(row)) {
        continue;
      }
      if ((seen.get(key) ?? 0) > 1) {
        // Which of two states is the record's cannot be told: neither is stored.
        if (!refused.some((entry) => entry.key === key)) {
          refused.push({ key, why: "read returned it more than once" });
        }
        continue;
      }
      const why = stateProblem(row["state"]);
      if (why !== undefined) {
        refused.push({ key, why });
        continue;
      }
      const state = row["state"] as Readonly<Record<string, StateValue>>;
      states.set(key, Object.fromEntries(fields.map((field) => [field, state[field] ?? null])));
    }
    return { states, refused, strangers };
  }

  /** Why a row's state is not one the store keeps, or undefined when it is. */
  function stateProblem(state: unknown): string | undefined {
    if (!isObject(state)) {
      return "its state is not an object of fields";
    }
    for (const field of fields) {
      if (!Object.hasOwn(state, field)) {
        return `its state lacks the field ${field}, which the source reads (a field with no value is null)`;
      }
      const value = state[field];
      if (value === null) {
        continue;
      }
      if (typeof value !== "string") {
        return `its field ${field} is ${Array.isArray(value) ? "a list" : typeof value}, not text or null`;
      }
      if (value.includes("\u0000") || !value.isWellFormed()) {
        return `its field ${field} holds a character the store cannot keep (a NUL or a lone surrogate)`;
      }
    }
    const size = Buffer.byteLength(
      JSON.stringify(Object.fromEntries(fields.map((field) => [field, state[field]]))),
      "utf8",
    );
    if (size > MAX_STATE_BYTES) {
      return `its state is ${size} bytes, more than the ${MAX_STATE_BYTES} a record may hold`;
    }
    return undefined;
  }

  /**
   * The keys a plugin named (from `watch`, `receive` or a caller), judged at the boundary: the ones
   * the store can keep, each once, and the others with why. A key refused here is never read nor
   * queued, and never stops the source: a plugin that names it again from its saved cursor has it
   * refused again while its other keys are answered.
   */
  function keysOf(named: readonly unknown[]): {
    readonly asked: readonly RecordKey[];
    readonly badKeys: readonly { readonly key: RecordKey; readonly why: string }[];
  } {
    const asked = new Set<RecordKey>();
    const badKeys = new Map<RecordKey, string>();
    for (const value of named) {
      const why = keyProblem(value);
      if (why === undefined) {
        asked.add(value as RecordKey);
      } else {
        badKeys.set(String(value), why);
      }
    }
    return { asked: [...asked], badKeys: [...badKeys].map(([key, why]) => ({ key, why })) };
  }

  async function intake(named: readonly unknown[]): Promise<IntakeReport> {
    const { asked, badKeys } = keysOf(named);
    for (const { key, why } of badKeys) {
      note(
        `${about} named a key the store cannot keep (${why}), so it is not read or queued: ${printableKey(key)}`,
      );
    }
    if (asked.length === 0 || stopped()) {
      return { ...EMPTY, refused: badKeys };
    }
    const returned: unknown = await call("read", () =>
      hosted.definition.read(contextOf(stop.signal), asked),
    );
    const judged = judge(asked, returned);
    // The plugin answered a read: it works, whatever the store does next.
    for (const heard of working) {
      heard();
    }
    const { states, strangers } = judged;
    const refused = [...badKeys, ...judged.refused];
    const queued: RecordKey[] = [];
    const unchanged: RecordKey[] = [];
    for (const [key, state] of states) {
      if (await store.upsertRecord(key, state)) {
        queued.push(key);
      } else {
        unchanged.push(key);
      }
    }
    const answered = new Set([...states.keys(), ...refused.map((entry) => entry.key)]);
    const skipped = asked.filter((key) => !answered.has(key));
    for (const { key, why } of judged.refused) {
      note(
        `${about} returned the record ${printableKey(key)} in a shape the store does not take (${why}), so it is not queued; it is read again at its next change`,
      );
    }
    if (strangers > 0) {
      note(
        `${about} returned ${strangers === 1 ? "a row" : `${strangers} rows`} for keys it was not asked for; ${strangers === 1 ? "it is" : "they are"} not kept (a plugin names its changed keys in watch)`,
      );
    }
    if (queued.length > 0) {
      for (const listener of listeners) {
        listener.push(queued);
      }
    }
    return { queued, unchanged, skipped, refused, strangers };
  }

  /** A `watch` batch: a list, or the plugin's failure; each key in it is judged by `intake`. */
  function batchOf(value: unknown): readonly unknown[] {
    if (!Array.isArray(value)) {
      throw new PluginSourceFailed(
        `${about} yielded something other than a list of keys from watch`,
      );
    }
    return value as readonly unknown[];
  }

  async function runPump(): Promise<void> {
    const iterator = hosted.definition.watch(contextOf(stop.signal))[Symbol.asyncIterator]();
    try {
      while (!stopped()) {
        const next = await call("watch", () => iterator.next());
        if (next.done === true) {
          // A watch that ends notices nothing more: the source stops and is started again.
          throw new PluginSourceFailed(
            `${about} ended its watch, so no change would be noticed; the source starts it again`,
          );
        }
        const batch = intake(batchOf(next.value));
        taking = batch;
        await batch;
      }
    } finally {
      // A generator parked on its next change finishes only when that change comes (or its signal
      // fires, which `close` did): its end is asked for, never waited for.
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    }
  }

  function startPump(): void {
    if (pump !== undefined || stopped()) {
      return;
    }
    pump = runPump().catch((error: unknown) => {
      if (error instanceof Stopped || stopped()) {
        return;
      }
      // A store error is the store's words, as any loop's; a plugin's is already worded.
      failure = { error: error instanceof Error ? error : new Error(String(error)) };
      for (const listener of listeners) {
        listener.wake();
      }
    });
  }

  /**
   * The worker's wake-up: the keys this source's intake queued, from the pump and `receive`. The
   * worker's own poll of the store's queue finds the keys queued by anyone else. The first call
   * starts the pump; a pump that failed fails the watch with its error, which stops the loop.
   */
  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    startPump();
    const mine: RecordKey[] = [];
    let wake: (() => void) | undefined;
    const listener = {
      push(keys: readonly RecordKey[]) {
        mine.push(...keys);
        wake?.();
      },
      wake() {
        wake?.();
      },
    };
    listeners.add(listener);
    try {
      for (;;) {
        if (failure !== undefined) {
          throw failure.error;
        }
        if (mine.length > 0) {
          yield mine.splice(0);
          continue;
        }
        if (stopped()) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      listeners.delete(listener);
    }
  }

  /** The status and keys a plugin's `receive` answered, judged; each key is judged by `intake`. */
  function receiptOf(value: unknown): {
    readonly status: number;
    readonly keys: readonly unknown[];
  } {
    const status = isObject(value) ? value["status"] : undefined;
    const keys = isObject(value) ? value["keys"] : undefined;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      !Array.isArray(keys)
    ) {
      throw new PluginSourceFailed(
        `${about} answered an event with something other than { status, keys }`,
      );
    }
    return { status, keys: keys as readonly unknown[] };
  }

  return {
    capabilities: store.capabilities,
    // The store's tables, brought up to date; a plugin source adds nothing of its own anywhere, so
    // there is nothing to uninstall: its records and log go only by an explicit purge.
    install: () => store.install(),
    uninstall: () => store.uninstall(),
    watch,
    read: (keys) => store.read(keys),
    write: (key, decision, expectedHash) => store.write(key, decision, expectedHash),
    current: (keys) => store.current(keys),
    scan: (from) => store.scan(from),
    enqueue: (keys) => store.enqueue(keys),
    claim: (limit) => store.claim(limit),
    claimKey: (key) => store.claimKey(key),
    ack: (keys) => store.ack(keys),
    release: (keys) => store.release(keys),
    intake,
    onWorking(heard) {
      working.push(heard);
    },
    async receive(request) {
      const receive = hosted.definition.receive;
      if (receive === undefined) {
        return { status: 404, intake: EMPTY };
      }
      if (stopped()) {
        return { status: 503, intake: EMPTY };
      }
      try {
        const receipt = receiptOf(
          await call("receive", () => receive(contextOf(stop.signal), request)),
        );
        return { status: receipt.status, intake: await intake(receipt.keys) };
      } catch (error) {
        if (error instanceof Stopped) {
          return { status: 503, intake: EMPTY };
        }
        throw error;
      }
    },
    async close() {
      stop.abort();
      for (const listener of listeners) {
        listener.wake();
      }
      await pump;
    },
  };
}
