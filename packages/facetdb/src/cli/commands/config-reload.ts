import {
  type ActionStep,
  type Clock,
  type Connector,
  type DecisionLog,
  EngineRefusal,
  type KeyText,
  type PassReport,
  type Question,
  type QuestionSet,
  type RecordKey,
  type ReviewServiceDeps,
  type Worker,
  whenUtc,
} from "@facetdb/core";
import {
  type ConfigFileDoor,
  type FileApply,
  type FileDiff,
  hideSecrets,
  type PendingSource,
  type ReloadSummary,
  type SourceReload,
  secretParts,
  type TableFacts,
} from "@facetdb/server";
import {
  type ApplyPlan,
  apply,
  type ConfigDraft,
  ConfigError,
  type ConfigFiles,
  type ProjectConfig,
  planApply,
  type SourceConfig,
  toProjectJson,
  uncommittedWords,
} from "../../config/index.ts";
import { CliError } from "../program.ts";
import { hasUrl, variableOf } from "./database.ts";

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
 *    source keeps running what it ran, and the worker says so;
 *  - a table source new in the file is started once the same check
 *    of its database holds: its loop is opened, put in place and launched beside the others, which
 *    are never touched; until then, or when the check cannot be made, it is not started and the
 *    worker says what is missing and what to do. Its connection string is the one the loader read
 *    when the worker started: a variable set since is not seen, and the worker says to set it where
 *    it runs and restart. An API source new in the file still takes a restart (the check API's
 *    sources are set at start);
 *  - a source removed from the file stops after the pass in hand;
 *  - a file that does not load leaves every source as it was, and the worker says what to fix.
 * While a stopping source finishes its pass the fleet beats the heartbeat itself, so the heartbeat
 * never stops during a reload; the sources that keep running beat on every pass as always.
 *
 * A source whose loop fails (its database gone, an outside service down) stops alone: its connector
 * is closed and it leaves the running loops, while every other loop, the outbox and the HTTP
 * surface go on untouched. The fleet keeps why and when, `pending()` says so, and the source is
 * tried again through a reload's `add` path (`installed`, then `open`, then launch) after
 * `RETRY_FIRST_MS`, the wait doubling up to `RETRY_MAX_MS` and starting over once a pass of its
 * loop works. Retries and reloads run one at a time in the same queue, so a retry never opens a
 * loop for a source a reload started meanwhile. A stop cancels the wait; a reload during it tries
 * the source at once (the wait cancelled), and one that removes or changes the source replaces the
 * failure with what the file now says. A loop its engine refuses (another worker holds a SQLite
 * file's lock, say) stops alone as well, but no wait mends a refusal: it is tried on Check again or
 * a restart only, and a run left with no loop and nothing to try ends with the refusal, as the
 * worker's start would have.
 */

/** How often the fleet beats while a source it restarts finishes its pass in hand. */
export const RELOAD_BEAT_EVERY_MS = 15_000;

/** The wait before a stopped source is first tried again. */
export const RETRY_FIRST_MS = 30_000;

/** The longest wait between two tries of a stopped source: the wait doubles up to it. */
export const RETRY_MAX_MS = 10 * 60_000;

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
   * Its table as the dashboard's Home and Sources show it, with its doctor for the question set in
   * force, made when the loop opened; absent for an API source.
   */
  readonly table?: TableFacts;
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
  | { readonly kind: "holds"; readonly rightsRead: boolean }
  | { readonly kind: "missing"; readonly missing: string; readonly rightsRead: boolean }
  | { readonly kind: "cannot-tell"; readonly why: string };

/**
 * `rightsRead`: the doctor read the worker login's rights itself, so a reading asked for again can
 * hold on its own. False where only this worker's finished install stood in for them (PostgreSQL's
 * doctor has no rights check): that reading used the run up, so the next can only say it cannot
 * tell, and the words offer a restart rather than Check again.
 */

export type FleetDeps = {
  /**
   * Records the source's question-set version, opens what it reads and builds its worker, and last
   * writes the set in force (store migration 8): from its return on, a restart only swaps loops,
   * which fails on nothing. The fleet closes what it returns.
   */
  readonly open: (source: SourceConfig, config: ProjectConfig) => Promise<SourceLoop>;
  /**
   * Whether the source's database holds the install of `source`'s question set, as the worker reads
   * it under its own login. Asked for a source whose one change to the install is questions added,
   * and for a table source new in the file whose connection string is set; never taken from the
   * page's word.
   */
  readonly installed: (source: SourceConfig, config: ProjectConfig) => Promise<InstallCheck>;
  /**
   * A source removed from the file, once its loop has stopped and closed: the composition root
   * drops what it made for it (a table source's connection, engine and key text are kept per name,
   * and a source added again under that name is made anew).
   */
  readonly removed?: (source: SourceConfig) => void;
  /**
   * The project's settings a running worker takes up without a restart (the spending cap and what
   * happens at 100%): told each config that loads, at open and at every reload, before the
   * sources are swapped, so the gate reads the new cap at its next check.
   */
  readonly project?: (config: ProjectConfig) => void;
  /** Reads facetdb.config.ts again through the loader; a `ConfigError` when it does not load. */
  readonly load: () => Promise<ProjectConfig>;
  /** Beats the project's heartbeat, in the scope of a source. */
  readonly beat: (source: string) => Promise<void>;
  /** `now` times a stopped source's next try. */
  readonly clock: Pick<Clock, "sleep" | "now">;
  readonly print: (line: string) => void;
  /** Sees each pass of a source's loop. */
  readonly onPass: (loop: SourceLoop) => (report: PassReport) => void;
  /**
   * The failure a loop stopped with, in words: the error itself unless the worker words it for its
   * source (a missing install names the source and the fix).
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
  /**
   * The sources whose loop failed and that wait for their next try, as Home's door names them
   * (`DashboardDoor.stopped`): why, since when, and when they are tried again (ISO 8601). The
   * fleet's own state, read without planning a reload. `retryAt` is null for a refusal.
   */
  stopped(): readonly {
    readonly source: string;
    readonly why: string;
    readonly since: string;
    readonly retryAt: string | null;
  }[];
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
   * Runs every loop until `signal` aborts; then waits for any reload or retry in hand and every
   * loop. A loop that fails stops alone and is tried again, so it rejects only for a failure of the
   * fleet itself: every source it ran was refused, and none is left to run or try.
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
  /** New in the file: started once `installed` holds, else not started and said why. */
  | { readonly kind: "add"; readonly name: string; readonly source: SourceConfig }
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
      steps.push({ kind: "add", name: source.name, source });
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

/**
 * The project's own settings a running worker holds from its start: a change takes a restart. The
 * spending cap and what happens at 100% are not among them: the fleet hands each loaded config to
 * `deps.project`, and the worker's gate reads the cap in force on every check. `plugins` is: the
 * plugin host is loaded once, at the start, so the actions keep the settings it read.
 */
function projectNotes(started: ProjectConfig, next: ProjectConfig): string[] {
  const fields = (["modelUrl", "provider", "studioUrl", "alerts", "plugins"] as const).filter(
    (field) => JSON.stringify(started[field]) !== JSON.stringify(next[field]),
  );
  return fields.length === 0
    ? []
    : [
        `The project's ${fields.join(", ")} changed in facetdb.config.ts; the worker keeps what it started with until you restart facetdb worker.`,
      ];
}

/** Why a source with questions added was not switched: the check's finding, or the read that failed. */
type Unswitched =
  | Exclude<InstallCheck, { readonly kind: "holds" }>
  | { readonly kind: "unread"; readonly why: string }
  /**
   * Its database answered and refused the worker's string (another login than the worker's): the
   * CLI's own refusal with its fix, which no reading asked for again can mend while the worker's
   * environment stands, so the restart is the step.
   */
  | { readonly kind: "refused"; readonly message: string; readonly fix: string };

/**
 * Why a source new in the file was not started: a fact of the file (an API source, a connection
 * variable the worker started without), or the last reading of its database.
 */
type NotStarted =
  /** It answers through POST /v1/check, whose sources are set when the worker starts. */
  | { readonly kind: "api" }
  /** The loader found no connection string: the variable was not set when the worker started. */
  | { readonly kind: "no-url"; readonly variable: string }
  /** Not read for the file as it is now: the next reload reads it. */
  | { readonly kind: "unchecked" }
  /** The reload came while the worker was stopping, which starts nothing. */
  | { readonly kind: "stopping" }
  /**
   * The start's own checks refused the source before anything connected (its connection string,
   * its engine, the store's variable), or its database answered and refused the string (another
   * login than the worker's): a problem in the file or the environment, with the fix, which no
   * reading asked for again can mend while the worker's environment stands.
   */
  | { readonly kind: "refused"; readonly message: string; readonly fix: string }
  /** The check held, and the source could not be opened. */
  | { readonly kind: "failed"; readonly why: string; readonly rightsRead: boolean }
  /**
   * It ran, and its loop failed: it stopped alone at `at` and is tried again at `retryAt`, or at
   * once by a reload.
   */
  | {
      readonly kind: "stopped";
      readonly why: string;
      readonly at: number;
      /** Null for a refusal: no wait mends it, so only Check again or a restart tries it. */
      readonly retryAt: number | null;
    }
  | Unswitched;

/** Whether a reload asked for again can start it: the reasons a reading of the database may change. */
function checkAgainStarts(reason: NotStarted): boolean {
  switch (reason.kind) {
    case "unchecked":
    case "unread":
    case "stopped":
      return true;
    case "missing":
    case "failed":
      return reason.rightsRead;
    case "api":
    case "no-url":
    case "stopping":
    case "refused":
    case "cannot-tell":
      return false;
  }
}

const NEW_AND_NOT_ANSWERED = "new in facetdb.config.ts and not answered yet";

/** What a reload says of a source new in the file that it did not start, and what to do. */
function notStartedMessage(name: string, reason: NotStarted): string {
  switch (reason.kind) {
    case "api":
      return `${NEW_AND_NOT_ANSWERED}: it answers through POST /v1/check, whose sources are set when the worker starts, so restart facetdb worker.`;
    case "no-url":
      return `${NEW_AND_NOT_ANSWERED}: its connection string is read from ${reason.variable}, which was not set when facetdb worker started. Set ${reason.variable} where the worker runs, then restart facetdb worker.`;
    case "unchecked":
      return `${NEW_AND_NOT_ANSWERED}: its install was not checked since the file changed. Check again: the worker reads its database and starts the source once the install is there.`;
    case "stopping":
      return "new in facetdb.config.ts and not started: the worker is stopping, which starts nothing; it answers once facetdb worker runs again.";
    case "refused":
      return `${NEW_AND_NOT_ANSWERED}: ${reason.message}; ${reason.fix}. Then restart facetdb worker.`;
    case "failed":
      return `${NEW_AND_NOT_ANSWERED}: its install is in its database, and it could not be started (${reason.why}). Check it with facetdb doctor, then ${reason.rightsRead ? "Check again or restart facetdb worker" : "restart facetdb worker"}.`;
    case "missing":
      return `${NEW_AND_NOT_ANSWERED}: its database does not hold its install (${reason.missing}). Run facetdb migrate --source ${name} on this machine, then ${reason.rightsRead ? "Check again" : "restart facetdb worker"}.`;
    case "unread":
      return `${NEW_AND_NOT_ANSWERED}: its database could not be read to check its install (${reason.why}). Check again once the database answers; facetdb doctor says what is wrong.`;
    case "cannot-tell":
      return `${NEW_AND_NOT_ANSWERED}: its install cannot be checked from here (${reason.why}), so it waits for a restart. Run facetdb migrate --source ${name} if the install did not finish, then restart facetdb worker.`;
    case "stopped":
      return reason.retryAt === null
        ? `stopped at ${clockTime(reason.at)}: ${reason.why}. The other sources keep answering; no wait mends this, so fix it, then Check again or restart facetdb worker.`
        : `stopped at ${clockTime(reason.at)}: ${reason.why}. The other sources keep answering; the worker tries ${name} again at ${clockTime(reason.retryAt)}, or at once on Check again.`;
  }
}

/** A time as the worker's lines say it, in the house form: `YYYY-MM-DD HH:MM UTC`. */
function clockTime(ms: number): string {
  return whenUtc(new Date(ms));
}

/**
 * A loop's failure in words, scrubbed of the source's connection string (its whole string, its
 * password and credentials, its user and its host) as the setup and migrate doors scrub a driver's
 * words: a driver message often names them, and these words reach the log, Home and the Sources
 * page. `failure` is the worker's wording of the error, when it has one; the "the source "x"
 * stopped: " that wording begins with is left out, as every line names the source itself, and so is
 * a closing full stop.
 */
export function failureWords(source: SourceConfig, failure: unknown): string {
  const said = wordsOf(failure);
  const words =
    source.database === undefined || source.database === ""
      ? said
      : hideSecrets(said, secretParts(source.database));
  const prefix = `the source "${source.name}" stopped: `;
  return (words.startsWith(prefix) ? words.slice(prefix.length) : words).replace(/\.$/, "");
}

/** What a reload says of a source new in the file that it started. */
function startedMessage(version: number): string {
  return `its install is in its database and the worker login may write its columns, so it started: it answers every change from now on with version ${version}. The records already in the table are answered by a backfill, which shows its cost first.`;
}

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
    case "refused":
      return `${namesOf(questions)} ${one ? "needs its columns" : "need their columns"}, and the worker cannot check them (${check.message}; ${check.fix}), ${keeps} until you restart facetdb worker.`;
  }
}

/**
 * Whether `facetdb migrate --source X` is a step toward starting a source new in the file: where
 * the install itself is the question, and where a loop failed to open (the check held, yet an
 * engine may still refuse a table it was not installed on and say to migrate it first, so the
 * command stays on the page). A string its database refuses, a variable unset at the start, an
 * API source or a database that did not answer is not mended by an install: the reason's own
 * words say what is.
 */
function migrateHelps(reason: NotStarted): boolean {
  switch (reason.kind) {
    case "missing":
    case "unchecked":
    case "cannot-tell":
    case "failed":
      return true;
    case "api":
    case "no-url":
    case "stopping":
    case "refused":
    case "unread":
    case "stopped":
      return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error in words, with its fix when the CLI's own check refused (the start's checks). */
function wordsOf(error: unknown): string {
  return error instanceof CliError ? `${error.message}; ${error.fix}` : messageOf(error);
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

/** A source whose loop failed, waiting for its next try. */
type Stopped = {
  /** The source and project as its loop ran them: a try opens the same. */
  readonly source: SourceConfig;
  readonly config: ProjectConfig;
  /**
   * The file and its source when it stopped: a reload that changes the source replaces the try.
   * Compared (`sourceKey`) only when a reload asks, never as it stops: nothing may throw there.
   */
  readonly file: { readonly config: ProjectConfig; readonly source: SourceConfig } | undefined;
  /** The failure in words: the loop's, then the last try's. */
  why: string;
  /** When its loop failed. */
  readonly at: number;
  /** When the next try is due; null for a refusal, which no wait mends (`refuse`). */
  retryAt: number | null;
  /**
   * The wait in force, by its token: a try that comes due runs only while its token is still this
   * one, so a reload's own try (which starts a new wait) leaves one timer per source, never two.
   */
  wait: object | undefined;
  /** Ends the wait for the next try, its timer cleared. */
  cancel: () => void;
  /**
   * The failed loop's outage policy: the records it holds (error or unchecked during a model
   * outage) are handed to the loop a try opens, as a reload's swap hands them on.
   */
  readonly outage: SourceLoop["outage"];
};

/** Resolves once `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}

export function createFleet(deps: FleetDeps): Fleet {
  const slots = new Map<string, Slot>();
  /** The config as the file loaded last; the project settings the worker started with. */
  let current: ProjectConfig | undefined;
  let started: ProjectConfig | undefined;
  /** Set by `run`: the stop of every loop, and whether loops are launched. */
  let ending: AbortSignal | undefined;
  /** Reloads and retries one at a time, each after the swap of the one before. */
  let queue: Promise<void> = Promise.resolve();
  /** The sources whose loop failed and that wait for their next try, by name. */
  const stopped = new Map<string, Stopped>();
  /**
   * The wait before each source's next try should its loop fail again: doubled at every try, up to
   * `RETRY_MAX_MS`, and forgotten once a pass of its loop works.
   */
  const backoff = new Map<string, number>();
  /** Failed loops still closing (review calls in flight finish first): `close` waits for them. */
  const closing = new Set<Promise<void>>();
  /** The first refusal a stopped source met (`refuse`), and the fleet's end once nothing is left. */
  let refusal: { readonly error: unknown } | undefined;
  /** Aborted when nothing runs and nothing waits for a try; `run` makes it anew if a source did. */
  let exhausted = new AbortController();
  /**
   * The last reading of each source whose added questions were not switched to, for the file's
   * source as it was then: `pending()` says the same until a reload reads the database again.
   */
  const unswitched = new Map<string, { readonly file: string; readonly check: Unswitched }>();
  /**
   * The last reading of each source new in the file that was not started, for the file's source as
   * it was then: `pending()` says the same until a reload reads the database again.
   */
  const unstarted = new Map<string, { readonly file: string; readonly reason: NotStarted }>();

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
    const name = slot.loop.source.name;
    const seen = deps.onPass(slot.loop);
    slot.done = slot.loop.worker
      .run(AbortSignal.any([stop, slot.halt.signal]), (report) => {
        // A pass that works: the next failure waits the first wait again.
        backoff.delete(name);
        seen(report);
      })
      .catch((error: unknown) => {
        stopAlone(slot, error);
      });
  }

  /** The config as the file loaded last; the fleet is opened before anything asks for it. */
  function inForce(): ProjectConfig {
    if (current === undefined) {
      throw new Error("the fleet was never opened");
    }
    return current;
  }

  /** A loop's failure as the worker words it, scrubbed (`failureWords`). */
  function whyOf(source: SourceConfig, error: unknown): string {
    return failureWords(
      source,
      deps.failure === undefined ? error : deps.failure(source.name, error),
    );
  }

  /**
   * One loop failed: it alone leaves the running loops and its connector is closed once the review
   * calls in flight on it settle (its pass gave back the batch it could before it threw; a claim
   * its database could not take back returns when its lease ends). The others, the outbox and the
   * HTTP surface are never touched. A loop that fails while a reload or the worker stops it is said
   * and left to that stop, which closes it.
   */
  function stopAlone(slot: Slot, error: unknown): void {
    const name = slot.loop.source.name;
    const why = whyOf(slot.loop.source, error);
    if (
      slots.get(name) !== slot ||
      slot.halt.signal.aborted ||
      ending === undefined ||
      ending.aborted
    ) {
      deps.print(`${name}: its loop failed as it stopped: ${why}`);
      return;
    }
    slots.delete(name);
    const file = inForce();
    const wanted = file.sources.find((source) => source.name === name);
    const now = deps.clock.now();
    const entry: Stopped = {
      source: slot.loop.source,
      // The loop's own question set: the file's model may have moved on since it opened.
      config: { ...file, model: slot.loop.questionSet.model },
      file: wanted === undefined ? undefined : { config: file, source: wanted },
      why,
      at: now,
      retryAt: null,
      wait: undefined,
      cancel: () => undefined,
      outage: slot.loop.outage,
    };
    stopped.set(name, entry);
    const closed = retire(slot);
    closing.add(closed);
    void closed.then(() => closing.delete(closed));
    if (error instanceof EngineRefusal) {
      refuse(name, entry, deps.failure === undefined ? error : deps.failure(name, error));
      return;
    }
    const retryAt = schedule(name, entry);
    deps.print(
      `${name} stopped: ${why}. The other sources keep running; the worker tries ${name} again at ${clockTime(retryAt)}.`,
    );
  }

  /**
   * A stopped source its engine refused (another worker holds a SQLite file's lock, the table is
   * another project's) or the CLI's own checks refused: no wait mends that, so it is not tried
   * again until a reload asks (Check again) or the worker restarts. A fleet left with no loop
   * running and no source waiting for a try has nothing more to do: its run ends with the first
   * refusal, as the worker's start would have (no running loop is touched by it, there is none).
   */
  function refuse(name: string, entry: Stopped, error: unknown): void {
    entry.retryAt = null;
    refusal ??= { error };
    deps.print(
      `${name} stopped: ${entry.why}. The other sources keep running; no wait mends this, so the worker does not try ${name} again until Check again or a restart.`,
    );
    if (slots.size === 0 && [...stopped.values()].every((other) => other.retryAt === null)) {
      exhausted.abort();
    }
  }

  /**
   * Waits the source's next wait, then tries it in the queue. The wait is the source's only one: a
   * wait made before it is cancelled and its token retired, and a stop or `entry.cancel` ends the
   * sleep itself, its timer cleared, so a stopping worker holds no timer for it.
   */
  function schedule(name: string, entry: Stopped): number {
    entry.cancel();
    const wait = backoff.get(name) ?? RETRY_FIRST_MS;
    backoff.set(name, Math.min(wait * 2, RETRY_MAX_MS));
    const retryAt = deps.clock.now() + wait;
    entry.retryAt = retryAt;
    const token = {};
    entry.wait = token;
    const cancelled = new AbortController();
    entry.cancel = () => {
      cancelled.abort();
      if (entry.wait === token) {
        entry.wait = undefined;
      }
    };
    const signal =
      ending === undefined ? cancelled.signal : AbortSignal.any([cancelled.signal, ending]);
    void deps.clock.sleep(wait, signal).then(() => {
      if (!signal.aborted && entry.wait === token) {
        const tried = queue.then(() => startAgain(name, entry, token));
        queue = tried.then(
          () => undefined,
          () => undefined,
        );
      }
    });
    return retryAt;
  }

  /**
   * Tries a stopped source again as a reload's `add` starts one: the worker's own reading of its
   * database, then its loop opened, put in place and launched. A reading that finds the install
   * missing, a database that does not answer, or an open that fails keeps it stopped, and the next
   * try waits longer; a reading that cannot tell (an engine whose doctor reads no rights) lets the
   * open try, since the source ran on that install. Skipped when a reload took the source meanwhile
   * (started, removed or changed it), when `token` names a wait no longer in force (a reload tried
   * the source and made a wait of its own since), or the worker is stopping: nothing opens then. A
   * reload's own try passes no token. The loop it opens takes the records the failed loop's outage
   * policy holds, as a reload's swap hands them on.
   */
  async function startAgain(
    name: string,
    entry: Stopped,
    token?: object,
  ): Promise<
    | { readonly kind: "started"; readonly version: number }
    | { readonly kind: "stopped" }
    | { readonly kind: "skipped" }
  > {
    const stopping = () => ending === undefined || ending.aborted;
    if (
      stopped.get(name) !== entry ||
      slots.has(name) ||
      stopping() ||
      (token !== undefined && entry.wait !== token)
    ) {
      return { kind: "skipped" };
    }
    // This try is the one in force: the wait that led here is spent.
    entry.cancel();
    /** Kept stopped: tried again after the next wait, or not at all for a refusal. */
    const failedAgain = (why: string, error?: unknown) => {
      entry.why = why;
      if (error instanceof CliError || error instanceof EngineRefusal) {
        refuse(name, entry, error);
      } else {
        const retryAt = schedule(name, entry);
        deps.print(
          `${name}: could not start again (${why}); the worker tries it again at ${clockTime(retryAt)}.`,
        );
      }
      return { kind: "stopped" } as const;
    };
    if (!entry.source.api) {
      let check: InstallCheck;
      try {
        check = await deps.installed(entry.source, entry.config);
      } catch (error) {
        return stopping()
          ? { kind: "skipped" }
          : failedAgain(failureWords(entry.source, error), error);
      }
      if (check.kind === "missing") {
        return failedAgain(
          failureWords(entry.source, `its database does not hold its install: ${check.missing}`),
        );
      }
    }
    if (stopping()) {
      return { kind: "skipped" };
    }
    let fresh: SourceLoop;
    try {
      fresh = await deps.open(entry.source, entry.config);
    } catch (error) {
      return stopping() ? { kind: "skipped" } : failedAgain(whyOf(entry.source, error), error);
    }
    if (stopping() || ending === undefined) {
      try {
        await fresh.close();
      } catch (error) {
        deps.print(`${name}: closing its connection failed: ${messageOf(error)}`);
      }
      return { kind: "skipped" };
    }
    stopped.delete(name);
    // The records the failed loop's outage policy holds are the new loop's to retry, as a swap's.
    if (entry.outage !== undefined && fresh.outage !== undefined) {
      fresh.outage.hold(entry.outage.held);
    }
    const slot = slotOf(fresh);
    slots.set(name, slot);
    launch(slot, ending);
    deps.print(
      `${name}: started again after it stopped; it answers with version ${fresh.version}.`,
    );
    return { kind: "started", version: fresh.version };
  }

  /** Forgets a stopped source: its wait cancelled, its next wait dropped. */
  function forget(name: string): Stopped | undefined {
    const entry = stopped.get(name);
    entry?.cancel();
    stopped.delete(name);
    backoff.delete(name);
    return entry;
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
        // A loop that failed while the reload opened its successor stopped alone and was closed:
        // the new loop takes its place, and the old one's next try is forgotten.
        const failed = slots.get(fresh.source.name) !== slot;
        forget(fresh.source.name);
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
        if (!failed) {
          await retire(slot);
        }
      }),
      ...removals.map(async (slot) => {
        await stop(slot);
        // One that failed meanwhile was closed then, and the reload forgot it.
        if (slots.get(slot.loop.source.name) !== slot) {
          return;
        }
        slots.delete(slot.loop.source.name);
        await retire(slot);
        deps.removed?.(slot.loop.source);
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
    deps.project?.(next);
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
          message: `could not start with what the file now says (${messageOf(error)}), so it keeps answering with version ${version}; check it with facetdb doctor, then restart facetdb worker.`,
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
    /**
     * Starts a source new in the file: its loop opened and launched beside the others once the
     * worker's own reading of its database holds, never on the page's word; otherwise it is not
     * started, and the reason is kept for `pending()`. Nothing stops, so the other loops beat on as
     * always and the fleet has nothing to beat for.
     */
    const startAdded = async (source: SourceConfig): Promise<void> => {
      const notStarted = (reason: NotStarted) => {
        unstarted.set(source.name, { file: sourceKey(next, source), reason });
        say({
          source: source.name,
          outcome: "not-started",
          version: null,
          message: notStartedMessage(source.name, reason),
        });
      };
      if (source.api) {
        notStarted({ kind: "api" });
        return;
      }
      if (!hasUrl(source)) {
        notStarted({ kind: "no-url", variable: variableOf(source) });
        return;
      }
      /** Read afresh at each step: the stop may fire during the check or the open. */
      const stopping = () => ending?.aborted === true;
      // A worker that is stopping starts nothing, and reads nothing for it: `run` waits for this
      // plan, then closes what runs.
      if (stopping()) {
        notStarted({ kind: "stopping" });
        return;
      }
      let check: InstallCheck | NotStarted;
      try {
        check = await deps.installed(source, next);
      } catch (error) {
        // The start's own checks refusing (the string, its engine, the store's variable), or the
        // database answering and refusing the string (another login than the worker's), is a
        // problem in the file or the environment, said with its fix; anything else is a read that
        // failed on the database, which a reading asked for again may make.
        check =
          error instanceof CliError
            ? { kind: "refused", message: error.message, fix: error.fix }
            : { kind: "unread", why: messageOf(error) };
      }
      if (check.kind !== "holds") {
        notStarted(check);
        return;
      }
      // A stop that came during the check: nothing opens on the customer's database for a source
      // that will never run, and no version is recorded.
      if (stopping()) {
        notStarted({ kind: "stopping" });
        return;
      }
      let fresh: SourceLoop;
      try {
        fresh = await deps.open(source, next);
      } catch (error) {
        notStarted({ kind: "failed", why: wordsOf(error), rightsRead: check.rightsRead });
        return;
      }
      // A stop that came during the open: the connection is closed again and the loop never put
      // in place nor launched.
      if (stopping()) {
        try {
          await fresh.close();
        } catch (error) {
          deps.print(`${source.name}: closing its connection failed: ${messageOf(error)}`);
        }
        notStarted({ kind: "stopping" });
        return;
      }
      unstarted.delete(source.name);
      const slot = slotOf(fresh);
      slots.set(source.name, slot);
      // Launched now under the run's stop; before `run`, it is launched with the rest.
      if (ending !== undefined) {
        launch(slot, ending);
      }
      say({
        source: source.name,
        outcome: "started",
        version: fresh.version,
        message: startedMessage(fresh.version),
      });
    };
    for (const step of steps) {
      const slot = slots.get(step.name);
      const version = slot?.loop.version ?? null;
      switch (step.kind) {
        case "unchanged":
          say({ source: step.name, outcome: "unchanged", version, message: null });
          break;
        case "add": {
          const entry = stopped.get(step.name);
          if (
            entry === undefined ||
            entry.file === undefined ||
            sourceKey(entry.file.config, entry.file.source) !== sourceKey(next, step.source)
          ) {
            // A source changed in the file since its loop failed is the file's now: started as a
            // new one is, and no longer tried on what the failed loop ran.
            forget(step.name);
            await startAdded(step.source);
            break;
          }
          // Stopped, and the file says of it what it said: tried at once, the wait cancelled.
          entry.cancel();
          const tried = await startAgain(step.name, entry);
          say(
            tried.kind === "started"
              ? {
                  source: step.name,
                  outcome: "started",
                  version: tried.version,
                  message: `it had stopped, and it started again: it answers every change from now on with version ${tried.version}.`,
                }
              : {
                  source: step.name,
                  outcome: "not-started",
                  version: null,
                  message: notStartedMessage(
                    step.name,
                    tried.kind === "stopped"
                      ? { kind: "stopped", why: entry.why, at: entry.at, retryAt: entry.retryAt }
                      : { kind: "stopping" },
                  ),
                },
          );
          break;
        }
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
            // The database refusing the string (the CLI's own refusal, with its fix) is mended
            // only by a restart after a change to the environment; anything else is a read that
            // failed on the database, which a reading asked for again may make.
            check =
              error instanceof CliError
                ? { kind: "refused", message: error.message, fix: error.fix }
                : { kind: "unread", why: messageOf(error) };
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
    // A source taken out of the file before it was ever started is nothing to say more of.
    for (const name of [...unstarted.keys()]) {
      if (!next.sources.some((source) => source.name === name)) {
        unstarted.delete(name);
      }
    }
    // A stopped source taken out of the file is tried no more, and what was made for it dropped.
    for (const name of [...stopped.keys()]) {
      if (!next.sources.some((source) => source.name === name)) {
        const entry = forget(name);
        if (entry !== undefined) {
          deps.removed?.(entry.source);
        }
        deps.print(
          `${name}: no longer in facetdb.config.ts; it had stopped, and the worker no longer tries it.`,
        );
      }
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
        const halted = stopped.get(step.name);
        if (halted !== undefined) {
          // It ran and its loop failed: why, and when the worker tries it again.
          const reason = {
            kind: "stopped",
            why: halted.why,
            at: halted.at,
            retryAt: halted.retryAt,
          } as const;
          pending.push({
            source: step.name,
            outcome: "not-started",
            message: notStartedMessage(step.name, reason),
            migrate: migrateHelps(reason),
            added: [],
            removed: [],
            checkAgain: checkAgainStarts(reason),
          });
          continue;
        }
        // What the file says of it, else the last reading of its database for the file as it is
        // now, else not read since the file changed: a reload reads it again.
        const read = unstarted.get(step.name);
        const reason: NotStarted = wanted.api
          ? { kind: "api" }
          : !hasUrl(wanted)
            ? { kind: "no-url", variable: variableOf(wanted) }
            : read !== undefined && read.file === sourceKey(file, wanted)
              ? read.reason
              : { kind: "unchecked" };
        pending.push({
          source: step.name,
          outcome: "not-started",
          message: notStartedMessage(step.name, reason),
          migrate: migrateHelps(reason),
          added: [],
          removed: [],
          checkAgain: checkAgainStarts(reason),
        });
      } else if (step.kind === "added" && wanted !== undefined) {
        const version = slots.get(step.name)?.loop.version ?? null;
        const read = unswitched.get(step.name);
        // Read for the file as it is now, or not since it changed: a reload reads it again.
        const check: Unswitched =
          read !== undefined && read.file === sourceKey(file, wanted)
            ? read.check
            : { kind: "missing", missing: "not checked since the file changed", rightsRead: true };
        pending.push({
          source: step.name,
          outcome: "kept",
          message: addedMessage(step.name, step.questions, check, version),
          migrate: true,
          added: [...step.questions],
          removed: [],
          checkAgain: check.kind !== "cannot-tell" && check.kind !== "refused",
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
    config: inForce,
    pending: pendingNow,
    stopped: () =>
      [...stopped].map(([name, entry]) => ({
        source: name,
        why: entry.why,
        since: new Date(entry.at).toISOString(),
        retryAt: entry.retryAt === null ? null : new Date(entry.retryAt).toISOString(),
      })),
    loops: loopsInOrder,
    loop: (name) => slots.get(name)?.loop,
    connector: routed,

    async open(config) {
      current = config;
      started = config;
      deps.project?.(config);
      for (const source of config.sources) {
        slots.set(source.name, slotOf(await deps.open(source, config)));
      }
    },

    async run(signal) {
      ending = signal;
      for (const slot of slots.values()) {
        launch(slot, signal);
      }
      // The stop also ends every stopped source's wait: nothing is tried again from now on. A
      // fleet whose every source was refused has no loop left to stop (`refuse`).
      for (;;) {
        const ended = exhausted.signal;
        await whenAborted(AbortSignal.any([signal, ended]));
        // A reload or retry in hand finishes (it starts nothing once the worker stops).
        await queue;
        if (signal.aborted) {
          break;
        }
        // Nothing ran when the last source was refused, but a reload queued then may have started
        // one: the run goes on with it, and a later stop ends it cleanly.
        const waiting = [...stopped.values()].some((entry) => entry.retryAt !== null);
        if (slots.size === 0 && !waiting && refusal !== undefined) {
          throw refusal.error;
        }
        if (exhausted.signal === ended) {
          exhausted = new AbortController();
        }
      }
      await Promise.all([...slots.values()].map((slot) => slot.done));
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
      await Promise.all(closing);
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
 * The studio's door to facetdb.config.ts (`ServerDeps.config.file`): the diff a draft makes (one
 * source, or the project's spending settings from Settings), and on confirmation the write and the
 * fleet's reload, which puts the written cap in force at once. The draft is judged within the
 * project as the file loads now, so a change committed to the file since the worker started is
 * kept, not reverted. Applies run one at a time.
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
    draft: ConfigDraft,
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
          dropsOwnText: shown.dropsOwnText,
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
            return {
              kind: "uncommitted",
              state: written.state,
              message: written.message,
              fix: written.fix,
            };
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
