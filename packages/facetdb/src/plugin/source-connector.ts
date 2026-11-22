import { createHash } from "node:crypto";
import {
  type Clock,
  type Connector,
  type CursorStore,
  type ReadRow,
  type RecordKey,
  type ScanCursor,
  type ScanPage,
  type StateValue,
  stateHash,
} from "@facetdb/core";
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
 * - `receive(request)` runs the plugin's `receive` on an inbound HTTP event and takes its keys in:
 *   only when it answered a 2xx, and never a key `eventKeyProblem` refuses.
 * - a backfill's own adapter (`createPluginBackfillConnector`; never the worker's, whose
 *   `scan` and `enqueue` stay the store's) pages through the plugin's own `scan`: `scan(cursor)`
 *   hands core one page of it, in the plugin's order (the SDK fixes none), each row
 *   judged at the boundary as `read`'s are and its hash the store's, and stores nothing;
 *   `enqueue(keys)` then takes each key of that page in by what the store holds of it now: stored
 *   if the store holds nothing, queued if it holds the page's state, read again through the
 *   plugin's `read` if it holds another, so an older page never overwrites a newer change. Core's
 *   backfill calls `enqueue` at its pace, after its estimate, and saves its cursor only after every
 *   key of the page is queued, so an estimate stores and queues nothing, and a crash repeats a
 *   page, never skips one.
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

/**
 * Why a key an inbound event named is not taken in, beyond `keyProblem`, or undefined when it is:
 * an invisible formatting character (a bidirectional override, a zero-width joiner) or a line or
 * paragraph separator. The store keeps such a key from `watch` and every page shows it raw, where
 * it can pass for another key; a webhook is the one way in a stranger reaches, so there it is
 * refused, and the source's own poll still finds the record if it is real.
 */
function eventKeyProblem(key: string): string | undefined {
  return /[\p{Cf}\p{Zl}\p{Zp}]/u.test(key)
    ? "it holds an invisible formatting character (a direction override, a zero-width character) or a line separator"
    : undefined;
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

/** What a backfill's own adapter needs of the store besides `RecordStore`. */
export type BackfillStore = RecordStore & {
  /** Stores a record the store does not hold yet and queues it (true); one it holds is left as it is (false). */
  insertRecord(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<boolean>;
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
   * Runs the plugin's `receive` on an inbound event (`POST /v1/hooks/:plugin/:source`). A source
   * without `receive` answers 404, and a stopped one 503, with nothing taken in; so does any status
   * but a 2xx the plugin answers, whatever keys it named beside it. When `caller` aborts first, the
   * plugin's `receive` and the reads of the keys it named are abandoned (their signal aborted) and
   * it rejects with `ReceiveAbandoned`; what was stored before stays stored.
   */
  receive(request: Request, caller?: AbortSignal): Promise<ReceiveOutcome>;
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

/**
 * An inbound event's caller gave up on it (the webhook route's time ran out) while one of its
 * plugin calls was in hand: the call's signal is aborted and its outcome is not used. The words are
 * FacetDB's: they name the plugin and the step, never anything the plugin said.
 */
export class ReceiveAbandoned extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiveAbandoned";
  }
}

/** The source stopped while a plugin call was in hand: the call's outcome is not used. */
class Stopped extends Error {
  constructor() {
    super("the source stopped");
    this.name = "Stopped";
  }
}

type Step = "watch" | "read" | "receive" | "scan";

/**
 * One pass of a plugin's scan: a digest of each cursor its pages gave, so one given again is caught
 * at a fixed cost per page whatever the cursor's length; the rows it refused; and its empty pages
 * in a row.
 */
type ScanPass = { readonly cursors: Set<string>; refused: number; empty: number };

/**
 * The most empty pages in a row a plugin's scan may yield, each naming a next cursor, before the
 * scan is taken to never end: a filter that leaves pages empty (pull requests left out of issues)
 * passes far below it, and a plugin whose fresh cursors lead nowhere stops the backfill in words.
 */
export const MAX_EMPTY_PAGES = 1_000;

/** A cursor's digest: what a pass keeps of each cursor its pages gave. */
function digestOf(cursor: ScanCursor): string {
  return createHash("sha256").update(cursor, "utf8").digest("base64");
}

/** A row of a scanned page the store does not take: not a row at all, its key, or its state. */
type ScanRefusal = {
  readonly kind: "row" | "key" | "state";
  readonly key: string;
  readonly why: string;
};

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EMPTY: IntakeReport = { queued: [], unchanged: [], skipped: [], refused: [], strangers: 0 };

/** What a plugin call's race resolves to when its caller gave up first. */
const ABANDONED = Symbol("abandoned");

/**
 * The worker's adapter of a plugin source: `scan` and `enqueue` are the store's, as for every other
 * connector over it, so a preview reads the records the store holds and a record queued again (an
 * outage's retry) is queued at the state the store holds.
 */
export function createPluginSourceConnector(deps: PluginSourceDeps): PluginSourceConnector {
  return adapterOf(deps, undefined);
}

/**
 * A backfill's own adapter of a plugin source, never a worker loop's: `scan` pages through the
 * plugin's own `scan`, and `enqueue` takes each record of the page last scanned into the store by
 * what the store holds of it now, never writing the page's state over a newer one.
 */
export function createPluginBackfillConnector(
  deps: PluginSourceDeps & { readonly store: BackfillStore },
): PluginSourceConnector {
  return adapterOf(deps, deps.store);
}

function adapterOf(
  deps: PluginSourceDeps,
  backfill: BackfillStore | undefined,
): PluginSourceConnector {
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

  /**
   * A plugin call, abandoned when the source stops, or when `caller` aborts (an inbound event whose
   * caller gave up), its failure worded by FacetDB.
   */
  async function call<Result>(
    step: Step,
    work: () => Promise<Result>,
    caller?: AbortSignal,
  ): Promise<Result> {
    /** Read afresh every time, as `stopped`: the caller may give up during any wait. */
    const gaveUp = (): boolean => caller?.aborted === true;
    if (stopped()) {
      throw new Stopped();
    }
    if (gaveUp()) {
      throw abandoned(step);
    }
    // Started a turn later, so a function that throws at once is caught as one that rejects; and
    // its failure after a stop, when nobody waits for it any more, is dropped, never unhandled.
    const pending = Promise.resolve().then(work);
    pending.catch(() => undefined);
    const racing: Promise<Result | typeof stop | typeof ABANDONED>[] = [pending, aborted];
    if (caller !== undefined) {
      racing.push(
        new Promise((resolve) => {
          caller.addEventListener("abort", () => resolve(ABANDONED), { once: true });
        }),
      );
    }
    let outcome: Result | typeof stop | typeof ABANDONED;
    try {
      outcome = await Promise.race(racing);
    } catch (error) {
      if (stopped()) {
        throw new Stopped();
      }
      // A plugin that gave up on its own aborted signal is the caller's giving up, not its failure.
      if (gaveUp()) {
        throw abandoned(step);
      }
      throw worded(step, error);
    }
    if (outcome === stop) {
      throw new Stopped();
    }
    if (outcome === ABANDONED) {
      throw abandoned(step);
    }
    return outcome as Result;
  }

  function abandoned(step: Step): ReceiveAbandoned {
    return new ReceiveAbandoned(
      `${about} had not answered in ${step} when the event's time ran out; its work there is abandoned`,
    );
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

  /** `caller`: an inbound event's own signal, which abandons the read when it aborts. */
  async function intake(named: readonly unknown[], caller?: AbortSignal): Promise<IntakeReport> {
    const { asked, badKeys } = keysOf(named);
    for (const { key, why } of badKeys) {
      note(
        `${about} named a key the store cannot keep (${why}), so it is not read or queued: ${printableKey(key)}`,
      );
    }
    if (asked.length === 0 || stopped()) {
      return { ...EMPTY, refused: badKeys };
    }
    const signal = caller === undefined ? stop.signal : AbortSignal.any([stop.signal, caller]);
    const returned: unknown = await call(
      "read",
      () => hosted.definition.read(contextOf(signal), asked),
      caller,
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

  // --- the backfill's scan -------------------------------------------------------------

  /**
   * The plugin's scan in hand between two pages: its iterator, the `next` of the page it yielded
   * last, and the pass it belongs to. A `scan` from exactly that cursor takes the iterator's next
   * page, so a pass pages through one call of the plugin's `scan` and fetches each page once; any
   * other cursor (a new pass, a resume) starts the plugin's scan again from there.
   */
  let scanning:
    | {
        readonly iterator: AsyncIterator<unknown>;
        readonly after: ScanCursor;
        readonly pass: ScanPass;
      }
    | undefined;
  /**
   * The rows of the page `scan` returned last, by key, each until `enqueue` takes it in: the state
   * the page read and its hash.
   */
  let scanned = new Map<RecordKey, ReadRow>();

  /** Asks a plugin's iterator to end, never waiting for it: a generator may be parked on a fetch. */
  function letGo(iterator: AsyncIterator<unknown>): void {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }

  /**
   * The context a plugin's scan is handed: its cursor reads the source's one saved cursor but never
   * saves it, since that cursor is where `watch` resumes, and a backfill's place is FacetDB's own.
   */
  function scanContext(): SourceContext<unknown> {
    return {
      ...contextOf(stop.signal),
      cursor: {
        load: () => cursor.load(),
        save: () =>
          Promise.reject(
            new TypeError(
              "a source's scan saves no cursor: the one saved cursor is where watch resumes, and a backfill's place is kept by FacetDB",
            ),
          ),
      },
    };
  }

  /** The plugin's scan started from `from`; one that throws at once fails in FacetDB's words. */
  function started(from: ScanCursor | null): AsyncIterator<unknown> {
    if (stopped()) {
      throw new Stopped();
    }
    try {
      return hosted.definition.scan(scanContext(), from)[Symbol.asyncIterator]();
    } catch (error) {
      throw worded("scan", error);
    }
  }

  /** The iterator's next step; on a failure the iterator is let go, and nothing is kept of it. */
  async function stepOf(iterator: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> {
    try {
      return await call("scan", () => iterator.next());
    } catch (error) {
      letGo(iterator);
      throw error;
    }
  }

  /**
   * A page the plugin yielded, judged: a list of rows and a `next` that is a cursor the store can
   * keep, or null. A `next` the pass has given before (a fault in the plugin) would page forever,
   * and so might more than `MAX_EMPTY_PAGES` empty pages in a row: either fails the page in words,
   * before anything of it is used.
   */
  function pageOf(
    value: unknown,
    pass: ScanPass,
  ): { readonly rows: readonly unknown[]; readonly next: ScanCursor | null } {
    const rows = isObject(value) ? value["rows"] : undefined;
    const next = isObject(value) ? value["next"] : undefined;
    if (!Array.isArray(rows) || (next !== null && typeof next !== "string")) {
      throw new PluginSourceFailed(
        `${about} yielded something other than a page of { rows, next } from scan`,
      );
    }
    if (next === null) {
      return { rows: rows as readonly unknown[], next };
    }
    if (next.length > MAX_CURSOR_LENGTH || next.includes("\u0000") || !next.isWellFormed()) {
      throw new PluginSourceFailed(
        `${about} returned a page from scan whose next cursor the store cannot keep (longer than ${MAX_CURSOR_LENGTH} characters, or holding a NUL or a lone surrogate)`,
      );
    }
    const digest = digestOf(next);
    if (pass.cursors.has(digest)) {
      throw new PluginSourceFailed(
        `${about} returned a page from scan whose next cursor repeats one it gave earlier in the same scan, so its pages would never end; nothing of the page is taken in, and the backfill's saved place stays at the page before it`,
      );
    }
    pass.empty = rows.length === 0 ? pass.empty + 1 : 0;
    if (pass.empty > MAX_EMPTY_PAGES) {
      throw new PluginSourceFailed(
        `${about} returned more than ${MAX_EMPTY_PAGES} empty pages in a row from scan, each naming a next cursor, so its pages may never end; nothing more is taken in, and the next backfill resumes from the last page saved`,
      );
    }
    pass.cursors.add(digest);
    return { rows: rows as readonly unknown[], next };
  }

  /**
   * A page's rows judged at the boundary as `read`'s are, in the plugin's order: the rows the store
   * keeps (only the fields the source reads, hashed as the store hashes them), and the others with
   * why. A refused row is left out and the page goes on with the rest.
   */
  function judgeScanned(rows: readonly unknown[]): {
    readonly kept: readonly ReadRow[];
    readonly refused: readonly ScanRefusal[];
  } {
    const times = new Map<unknown, number>();
    for (const row of rows) {
      const key = isObject(row) ? row["key"] : undefined;
      times.set(key, (times.get(key) ?? 0) + 1);
    }
    const kept: ReadRow[] = [];
    const refused: ScanRefusal[] = [];
    for (const row of rows) {
      if (!isObject(row)) {
        refused.push({ kind: "row", key: "", why: "it is not a row of { key, state }" });
        continue;
      }
      const named = row["key"];
      const badKey = keyProblem(named);
      if (badKey !== undefined) {
        refused.push({ kind: "key", key: String(named), why: badKey });
        continue;
      }
      const key = named as RecordKey;
      if ((times.get(key) ?? 0) > 1) {
        // Which of two states is the record's cannot be told: neither is taken in.
        if (!refused.some((entry) => entry.kind === "state" && entry.key === key)) {
          refused.push({ kind: "state", key, why: "scan returned it more than once in one page" });
        }
        continue;
      }
      const why = stateProblem(row["state"]);
      if (why !== undefined) {
        refused.push({ kind: "state", key, why });
        continue;
      }
      const state = row["state"] as Readonly<Record<string, StateValue>>;
      const picked = Object.fromEntries(fields.map((field) => [field, state[field] ?? null]));
      kept.push({ key, state: picked, hash: stateHash(fields, picked), excluded: false });
    }
    return { kept, refused };
  }

  /** Says each refused row, and counts it in its pass. */
  function noteRefused(refused: readonly ScanRefusal[], pass: ScanPass): void {
    for (const entry of refused) {
      pass.refused += 1;
      switch (entry.kind) {
        case "row":
          note(
            `${about} yielded a row from scan that is not { key, state }; it is left out of the backfill`,
          );
          break;
        case "key":
          note(
            `${about} returned a record from scan whose key the store cannot keep (${entry.why}), so it is left out of the backfill: ${printableKey(entry.key)}`,
          );
          break;
        case "state":
          note(
            `${about} returned the record ${printableKey(entry.key)} from scan in a shape the store does not take (${entry.why}), so it is left out of the backfill`,
          );
          break;
      }
    }
  }

  /** The end of a pass: what it left out, counted, when it left anything out. */
  function passEnded(pass: ScanPass): void {
    if (pass.refused > 0) {
      note(
        `${about} returned ${pass.refused === 1 ? "1 row" : `${pass.refused} rows`} in this pass of its scan that the store does not take, each named above: left out of the backfill, its count and its estimate`,
      );
    }
  }

  /**
   * One page of the plugin's scan, as core's backfill reads a connector's: from the iterator in
   * hand when `from` is where its last page left off, else from the plugin's scan started at
   * `from`. Nothing is stored here: the page's rows are held until `enqueue` takes them in, so a
   * backfill's estimate, which pages through `scan` too, stores and queues nothing.
   */
  async function scan(from: ScanCursor | null): Promise<ScanPage> {
    const held = scanning;
    scanning = undefined;
    const goesOn = held !== undefined && from !== null && held.after === from;
    if (held !== undefined && !goesOn) {
      letGo(held.iterator);
    }
    const pass: ScanPass = goesOn
      ? held.pass
      : { cursors: new Set(from === null ? [] : [digestOf(from)]), refused: 0, empty: 0 };
    let iterator = goesOn ? held.iterator : started(from);
    let step = await stepOf(iterator);
    if (step.done === true && goesOn) {
      // Its scan ended although its last page named a next one (a plugin that yields one page a
      // call): it is started again from that cursor, as a resume would start it.
      iterator = started(from);
      step = await stepOf(iterator);
    }
    if (step.done === true) {
      // Nothing more from here: the last page, empty.
      scanned = new Map();
      passEnded(pass);
      return { rows: [], next: null };
    }
    let page: { readonly rows: readonly unknown[]; readonly next: ScanCursor | null };
    try {
      page = pageOf(step.value, pass);
    } catch (error) {
      letGo(iterator);
      throw error;
    }
    const judged = judgeScanned(page.rows);
    noteRefused(judged.refused, pass);
    scanned = new Map(judged.kept.map((row) => [row.key, row]));
    if (page.next === null) {
      letGo(iterator);
      passEnded(pass);
    } else {
      scanning = { iterator, after: page.next, pass };
    }
    return { rows: judged.kept, next: page.next };
  }

  /**
   * A backfill's queueing, at its pace and after its estimate: each key of the page `scan` returned
   * last is taken in by what the store holds of it now, never by writing the page's state over a
   * newer one (the page may be seconds old, and a change stored since is newer):
   * - nothing: the page's state is stored and queued in one transaction, if the store still holds
   *   nothing (`insertRecord`);
   * - the page's state (the same hash): queued as it is;
   * - another state, or one stored since the look: read again through the plugin's `read` and
   *   taken in by `intake`, which stores and queues a state that changed; a key it finds unchanged
   *   is queued as it is, one it leaves out or refuses is not queued.
   * A key of no page is queued as it is. Each key leaves the kept page as it is taken in.
   */
  async function takeIn(into: BackfillStore, keys: readonly RecordKey[]): Promise<void> {
    const unique = [...new Set(keys)];
    const kept = unique.flatMap((key) => {
      const row = scanned.get(key);
      return row === undefined ? [] : [row];
    });
    const waiting = unique.filter((key) => !scanned.has(key));
    if (kept.length > 0) {
      const { rows } = await into.read(kept.map((row) => row.key));
      const held = new Map(rows.map((row) => [row.key, row.hash]));
      const readAgain: RecordKey[] = [];
      for (const row of kept) {
        const hash = held.get(row.key);
        if (hash === row.hash) {
          waiting.push(row.key);
        } else if (hash !== undefined || !(await into.insertRecord(row.key, row.state))) {
          readAgain.push(row.key);
        }
        scanned.delete(row.key);
      }
      if (readAgain.length > 0) {
        waiting.push(...(await intake(readAgain)).unchanged);
      }
    }
    if (waiting.length > 0) {
      await into.enqueue(waiting);
    }
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
    // The worker's adapter pages and queues through the store; only a backfill's own pages through
    // the plugin's scan and takes records in as it queues them.
    scan: backfill === undefined ? (from) => store.scan(from) : scan,
    enqueue:
      backfill === undefined ? (keys) => store.enqueue(keys) : (keys) => takeIn(backfill, keys),
    claim: (limit) => store.claim(limit),
    claimKey: (key) => store.claimKey(key),
    ack: (keys) => store.ack(keys),
    release: (keys) => store.release(keys),
    intake,
    onWorking(heard) {
      working.push(heard);
    },
    async receive(request, caller) {
      const receive = hosted.definition.receive;
      if (receive === undefined) {
        return { status: 404, intake: EMPTY };
      }
      if (stopped()) {
        return { status: 503, intake: EMPTY };
      }
      // The plugin is told of a caller that gave up through its own signal, as of a stop.
      const signal = caller === undefined ? stop.signal : AbortSignal.any([stop.signal, caller]);
      try {
        const receipt = receiptOf(
          await call("receive", () => receive(contextOf(signal), request), caller),
        );
        // Only a delivery the plugin took names keys. One it refused (a bad signature is a 401)
        // queues nothing whatever keys came with it, so a plugin that returns keys beside a refusal
        // cannot queue a record for a sender it did not believe.
        if (receipt.status < 200 || receipt.status > 299) {
          if (receipt.keys.length > 0) {
            note(
              `${about} refused an event (HTTP ${receipt.status}) and still named keys with it; none is read or queued`,
            );
          }
          return { status: receipt.status, intake: EMPTY };
        }
        const formatted = new Map<RecordKey, string>();
        for (const key of receipt.keys) {
          const why = typeof key === "string" ? eventKeyProblem(key) : undefined;
          if (why !== undefined) {
            formatted.set(key as RecordKey, why);
          }
        }
        for (const [key, why] of formatted) {
          note(
            `${about} named a key in an event that a webhook may not name (${why}), so it is not read or queued: ${printableKey(key)}`,
          );
        }
        const taken = await intake(
          receipt.keys.filter((key) => typeof key !== "string" || !formatted.has(key)),
          caller,
        );
        return {
          status: receipt.status,
          intake: {
            ...taken,
            refused: [...[...formatted].map(([key, why]) => ({ key, why })), ...taken.refused],
          },
        };
      } catch (error) {
        if (error instanceof Stopped) {
          return { status: 503, intake: EMPTY };
        }
        throw error;
      }
    },
    async close() {
      stop.abort();
      if (scanning !== undefined) {
        letGo(scanning.iterator);
        scanning = undefined;
      }
      for (const listener of listeners) {
        listener.wake();
      }
      await pump;
    },
  };
}
