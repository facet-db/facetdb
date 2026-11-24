import { basename } from "node:path";
import {
  type AlertEvent,
  type AlertStore,
  type Alerts,
  type Clock,
  type DoctorCheck,
  EngineRefusal,
  eventKey,
  type PassReport,
  type QuestionSet,
  RETRY_EVERY_MS,
  sourceStoppedEvent,
} from "@facetdb/core";
import { doctorVerdict, losesAccess, type SourceVerdict, versionChanges } from "@facetdb/server";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import type { AppliedBy } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * The system alerts only the running worker can see: Connector lost access, Question set changed
 * and Source stopped. Each goes through the worker's one `createAlerts`, so the 30-minute rule, the
 * channels and their pace are its own.
 *
 * Connector lost access (critical, resolvable):
 *  - every `ACCESS_CHECK_EVERY_MS`, on the worker's clock and beside the passes, never inside one,
 *    the worker reads each running table source's doctor once (the engine's checks under the
 *    worker login: on PostgreSQL 9 statements, 10 when the store is the source's database, on
 *    connections borrowed from the source's own pool). A verdict that fails on any check but
 *    `install` raises it (`cause: "doctor"`), in the failed check's own words, the ones Home shows
 *    (the server's `doctorVerdict` and `losesAccess`, which Home reads by too). A failing `install`
 *    check is an install behind the file, which `facetdb migrate` fixes: it raises nothing. A trigger
 *    dropped or disabled, a jobs table or facetdb schema gone, fails the engine's `capture` check
 *    (SQL Server's `trigger`), which comes before `install` and raises. A look
 *    that cannot record its outcome (the store down) is a printed line and stops nothing; a stop
 *    between two sources ends the look;
 *  - a loop that stops alone because its database refused the worker login or a right it uses (the
 *    database's own code: `refusalOf`), or because its plugin threw `SourceAccessLost` (matched by
 *    name), raises it at once (`cause: "refusal"`), in
 *    fixed words: never the driver's message nor the plugin's, which can quote a connection string
 *    or a token. So does a pass whose records failed on such a refusal (a right to write the answer
 *    columns revoked fails each write and stops no loop, and PostgreSQL's doctor reads no rights),
 *    at most one raise per source per `RETRY_EVERY_MS` from this process, the store's 30-minute
 *    rule deciding the rest. Only a table source's: an API source's database is the store, which no
 *    look reads, so an alert raised for it could never be resolved;
 *  - the cause is kept on the active alert in the store, so every worker reading it knows it. At a
 *    look whose verdict does not lose access, an alert its doctor raised is resolved; one a refusal
 *    raised is resolved only when this process has proof made after the alert began: a pass of the
 *    source's loop, started after it, that wrote at least one decision through it with no refusal
 *    (a pass that claimed nothing, failed before any write, or only skipped blank records proves
 *    nothing), or for a plugin source a read through the plugin that answered (`proven`). A worker
 *    whose passes are empty while another's writes are refused never resolves it, and a write made
 *    before the refusal began is no proof. A doctor's raise over a refusal's alert keeps the
 *    refusal's cause. A source that came back with nothing to write or read keeps its alert open
 *    (raised once, not raised again, since nothing fails) until its first write or read;
 *  - a source taken out of the file has its alert resolved when the file without it loads, and
 *    nothing raised for it after (its last pass, a stop).
 * Under `--once` nothing here runs but the question-set raise: the run exits with a failed loop's
 * error, and could never resolve an alert it raised.
 *
 * Source stopped (critical, resolvable): a table or plugin source's loop that stopped by itself for
 * any other reason than a refused login or credential (which raises Connector lost access alone)
 * raises it at once, in Home's words for the stop (`sourceStoppedWords`): the fleet's words for the
 * failure, hidden here again and quoted by core, and whether the worker keeps trying. A stopped
 * source's failed try tells the same hook, with its new next try, so a source that stays stopped
 * raises again (a refused login at a try raises lost access, as at a first stop). A stop a reload
 * or the worker's own stop caused never reaches here (the fleet tells only a loop that stopped
 * alone). It is resolved at the next look once a pass of the source begun after the alert has run
 * (`ranAt`): the loop runs again, whether or not it had anything to write. An API source raises
 * none: no look reads it, so its alert could never be resolved. The key is the source's, not the
 * worker's: with two workers on one store, the stop of either raises the one alert, and a pass of
 * either resolves it, since the source's records are then answered; the stopped worker's next
 * failed try raises it again. Core holds every raise of this kind to one message per 30 minutes,
 * across a resolve (`HELD_AFTER_RESOLVE_KINDS`), so a source that stops, runs and stops again, or
 * two workers that raise and resolve it in turn, send one raise and one resolved message per 30
 * minutes; the alert is recorded open and resolved in between, withheld. Two things keep a held
 * raise from being the last word: a stop no wait mends is never held (sent at once), and every look
 * raises again each source the fleet still holds stopped whose stop raised Source stopped, so a
 * held raise goes out once its 30 minutes are over. A source whose first open failed at the
 * worker's start never reached the fleet's stopped list and raises nothing (the worker does not
 * start). The row a resolve keeps is deleted at the look once its 30 minutes are over, and at once
 * when its source leaves the file.
 *
 * Question set changed (information): a loop that opens under a version higher than the one the
 * source ran before (the row in force it replaced, store migration 8) raises it once. The first
 * version of a source raises nothing. The row is replaced under the source's version lock, so of
 * two workers that open the same new version at once only one is told of the old one, and the
 * event's key carries the version: one version is one alert, and the next is another. Who changed
 * it is the reviewer of the Apply whose write made the source's set as it now runs (this process
 * remembers, from the Apply's own reload, its reviewer for the source its draft wrote, until the
 * file says otherwise), else the config file; what changed is said as the Questions page's history
 * says it, with the thresholds that moved, never a question's wording, and held to `CHANGES_MAX`
 * characters.
 */

/** Each table source's doctor, every 5 minutes. */
export const ACCESS_CHECK_EVERY_MS = 5 * 60_000;

/** The longest "what changed" an alert carries; the Questions page lists every change. */
export const CHANGES_MAX = 300;

/** The longest doctor words an alert carries. */
const WORDS_MAX = 400;

/** A running source, as the 5-minute look reads it. */
export type WatchedSource =
  | {
      readonly kind: "table";
      readonly name: string;
      /** The engine's doctor under the worker login, for the question set the loop runs. */
      doctor(): Promise<readonly DoctorCheck[]>;
    }
  | { readonly kind: "plugin"; readonly name: string };

/** The row in force a loop's open replaced: its version, and its set (null when unreadable). */
export type ReplacedSet = {
  readonly version: number;
  readonly questionSet: QuestionSet | null;
};

export type AlertRaisersDeps = {
  readonly alerts: Pick<Alerts, "raise" | "resolve" | "dropKept">;
  /** The store's active alert of a key: what a look reads to know what raised it, and since when. */
  readonly active: AlertStore["getActive"];
  readonly clock: Pick<Clock, "now" | "sleep">;
  readonly project: string;
  readonly links: {
    readonly access: () => string;
    readonly stopped: () => string;
    readonly questionSet: (source: string) => string;
  };
  /** The sources that run now, read at each look: the fleet's loops in force. */
  readonly sources: () => readonly WatchedSource[];
  /**
   * The sources the fleet holds stopped now (Home's door's list), each with its words and next try:
   * read at each look, which raises their Source stopped again, so a raise held inside 30 minutes
   * of the last one goes out once they are over even when nothing else raises it.
   */
  readonly stoppedSources: () => readonly ({ readonly source: string } & LoopStop)[];
  /**
   * Every part of the store's and each source's connection string hidden (the config in force):
   * what every word that came from a database passes through before it is kept or printed.
   */
  readonly hide: (text: string) => string;
  readonly print: (line: string) => void;
  /** The config file as `--config` names it: who changed a set when no Apply did. */
  readonly configPath: string;
};

export type AlertRaisers = {
  /**
   * One look at every running source: the doctor of each table source, and the alert in the store
   * of each source this process has proof for. A `signal` aborted between two sources ends it.
   */
  look(signal?: AbortSignal): Promise<void>;
  /** A look every `ACCESS_CHECK_EVERY_MS` until `signal` aborts; no sleep of it is left after. */
  run(signal: AbortSignal): Promise<void>;
  /**
   * A loop stopped alone with `error` (the fleet's hook), `stop` its words and next try: raises
   * Connector lost access at once for a refused login or credential, Source stopped for any other.
   */
  stopped(source: SourceConfig, error: unknown, stop: LoopStop): void;
  /**
   * A pass of a running loop went through: its records' refusals raise, a write without one is
   * proof, stamped with the pass's start (`startedAt`, this worker's clock), never with its end.
   */
  passed(
    source: SourceConfig,
    report: Pick<PassReport, "startedAt" | "failures" | "written" | "alreadyAnswered">,
  ): void;
  /** A read through the plugin of `source` answered: proof for the next look. */
  proven(source: string): void;
  /**
   * Each config that loads, at the start and at every reload (the fleet's `project` hook), with the
   * Apply that reload follows: its reviewer is who the source its draft wrote is by.
   */
  loaded(config: ProjectConfig, applied?: AppliedBy): void;
  /** A loop opened under `version`, the open having replaced `before` as the set in force. */
  started(
    source: SourceConfig,
    questionSet: QuestionSet,
    version: number,
    before: ReplacedSet | null,
  ): void;
  /** Waits for every raise and resolve still on its way; never rejects. */
  settled(): Promise<void>;
};

/** A loop's stop as the fleet holds it: its failure in the fleet's words, and its next try (ms). */
export type LoopStop = { readonly why: string; readonly retryAt: number | null };

/** A refused login or right, by the database's own code (a boundary: only its code is read). */
type Refusal = { readonly kind: "login" | "right"; readonly code: string };

/**
 * The database codes of a refused login: PostgreSQL's and CockroachDB's invalid password and
 * authorization, MySQL's and MariaDB's access denied, SQL Server's failed login (tedious), Oracle's
 * invalid login and locked account, MongoDB's failed authentication (its `codeName`).
 */
const LOGIN_REFUSED: ReadonlySet<string> = new Set([
  "28P01",
  "28000",
  "ER_ACCESS_DENIED_ERROR",
  "ELOGIN",
  "ORA-01017",
  "ORA-28000",
  "AuthenticationFailed",
]);

/**
 * The database codes of a right the worker login uses that was taken away: PostgreSQL's
 * insufficient privilege, MySQL's and MariaDB's denied database, table, column and specific
 * rights, Oracle's insufficient privileges, MongoDB's unauthorized.
 */
const RIGHT_REFUSED: ReadonlySet<string> = new Set([
  "42501",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_COLUMNACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
  "ORA-01031",
  "Unauthorized",
]);

/** SQL Server's permission denied on an object or a column (tedious's `number` on `EREQUEST`). */
const MSSQL_RIGHT_REFUSED: ReadonlySet<number> = new Set([229, 230]);

/** A code as a word that may be shown: letters, digits, `_` and `-`, at most 40. */
const CODE = /^[A-Za-z0-9_-]{1,40}$/;

function field(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error
    ? (error as Readonly<Record<string, unknown>>)[name]
    : undefined;
}

function textField(error: unknown, name: string): string | undefined {
  const value = field(error, name);
  return typeof value === "string" && CODE.test(value) ? value : undefined;
}

/** A loop's error as a refused login or right, by its code alone; undefined for anything else. */
export function refusalOf(error: unknown): Refusal | undefined {
  if (error instanceof EngineRefusal) {
    // Oracle's ORA-01017 reaches the CLI as the engine's own refusal (`oracleFailure`).
    return error.refusal.code === "database-login"
      ? { kind: "login", code: "ORA-01017" }
      : undefined;
  }
  for (const code of [textField(error, "code"), textField(error, "codeName")]) {
    if (code === undefined) {
      continue;
    }
    if (LOGIN_REFUSED.has(code)) {
      return { kind: "login", code };
    }
    if (RIGHT_REFUSED.has(code)) {
      return { kind: "right", code };
    }
  }
  const number = field(error, "number");
  if (
    textField(error, "code") === "EREQUEST" &&
    typeof number === "number" &&
    MSSQL_RIGHT_REFUSED.has(number)
  ) {
    return { kind: "right", code: String(number) };
  }
  return undefined;
}

/**
 * The source connector's words for a `SourceAccessLost` (plugin/source-connector.ts, `worded`):
 * names only, the plugin's own message never in them. A message that is not exactly this shape is
 * not shown.
 */
const PLUGIN_LOST_WORDS =
  /^the plugin [^\s()]+ \(source [^\s()]+ of [^\s()]+\) lost access: the service it reads refused its credential in (?:watch|read|receive); check (?:the credential the plugin uses|the variables? [A-Za-z_][A-Za-z0-9_]*(?: and [A-Za-z_][A-Za-z0-9_]*)*) and the rights granted to it$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Words that came from elsewhere, on one line and held to `max`. */
function oneLine(text: string, max: number): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/** A sentence's first letter in capitals. */
function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The name a reviewer signed in under, as an alert may show it. */
function reviewerName(name: string): string {
  return oneLine(name, 64);
}

/**
 * The thresholds that moved between two sets, for the questions in both: a per-question override
 * or the stakes that pick its defaults. The content hash leaves them out, so a move alone makes no
 * version; beside a change that does, it is said.
 */
function thresholdsMoved(before: QuestionSet, after: QuestionSet): readonly string[] {
  return after.questions.flatMap((question) => {
    const earlier = before.questions.find((candidate) => candidate.name === question.name);
    if (earlier === undefined) {
      return [];
    }
    const moved =
      earlier.stakes !== question.stakes ||
      JSON.stringify(before.thresholds[question.name] ?? null) !==
        JSON.stringify(after.thresholds[question.name] ?? null);
    return moved ? [`the thresholds of ${question.name}`] : [];
  });
}

/**
 * What changed, in the Questions page's words (`versionChanges`: questions added, removed, their
 * wording, criteria, options or levels, the fields, the model) and the thresholds that moved, held
 * to `CHANGES_MAX` characters: past it, as many whole changes as fit and how many more there are.
 */
export function changesWords(before: QuestionSet, after: QuestionSet): string {
  const base = versionChanges(before, after);
  const parts = [
    base.startsWith("The ") ? `the ${base.slice(4)}` : base,
    ...thresholdsMoved(before, after),
  ]
    .join("; ")
    .split("; ");
  const whole = parts.join("; ");
  if (whole.length <= CHANGES_MAX) {
    return whole;
  }
  const kept: string[] = [];
  // Room for "; and 99 more changes, listed on the Questions page".
  const room = CHANGES_MAX - 52;
  for (const part of parts) {
    if ([...kept, part].join("; ").length > room) {
      break;
    }
    kept.push(part);
  }
  const more = parts.length - kept.length;
  const rest = `${more} ${kept.length === 0 ? "" : "more "}${more === 1 ? "change" : "changes"}, listed on the Questions page`;
  return kept.length === 0 ? rest : `${kept.join("; ")}; and ${rest}`;
}

export function createAlertRaisers(deps: AlertRaisersDeps): AlertRaisers {
  const { alerts, clock, project, links, hide, print } = deps;
  /** Raises and resolves on their way, off the path that started them: `settled` waits for them. */
  const inFlight = new Set<Promise<void>>();
  /**
   * Per source, when this process last had proof it reads well: a pass that wrote through it with no
   * refusal, stamped with the pass's start, or a plugin source's read that answered. Forgotten at a
   * refusal or a stop of its loop. Compared with the alert's `raisedAt`, the raising worker's clock:
   * the database's clock is not at hand where a pass reports, so two machines whose clocks differ by
   * more than the time from the raise to the proof's pass can take a write made before the refusal
   * for proof (this worker's clock ahead), or wait a pass longer than needed (behind). Clocks kept by
   * NTP (milliseconds apart) leave only a pass that began within that margin of the raise.
   */
  const provenAt = new Map<string, number>();
  /**
   * Per source, the start of the last pass its loop ran in this process, whatever it wrote: what
   * resolves Source stopped. Forgotten at a stop of its loop. Compared with the alert's `raisedAt`
   * as `provenAt` is, with the same margin between two machines' clocks.
   */
  const ranAt = new Map<string, number>();
  /**
   * The sources whose last stop told here raised Source stopped, not Connector lost access: the
   * ones the look raises it again for while the fleet holds them stopped.
   */
  const raisedStopped = new Set<string>();
  /** Per source, the reviewer of the last Apply that wrote it and its set as that write made it. */
  const appliedBy = new Map<string, { readonly by: string; readonly set: string }>();
  /** Per source, when a pass's refusal last went to the alerts: at most one per `RETRY_EVERY_MS`. */
  const passRaisedAt = new Map<string, number>();
  /** The sources of the file as it last loaded; undefined before the first load. */
  let inFile: ReadonlySet<string> | undefined;

  const lostKey = (source: string): string =>
    eventKey({ kind: "connector_lost_access", project, source, question: null });

  const stoppedKey = (source: string): string =>
    eventKey({ kind: "source_stopped", project, source, question: null });

  /** Whether a source is the file's: one taken out of it raises nothing more. */
  const listed = (name: string): boolean => inFile === undefined || inFile.has(name);

  /** A refused login or right in fixed words: the code, never what the driver said. */
  function refusedWords(name: string, refused: Refusal): string {
    return refused.kind === "login"
      ? `The database of ${name} refused the worker login (code ${refused.code}): its password, or its right to log in, changed.`
      : `The database of ${name} refused the worker login a right it uses (code ${refused.code}): a grant was taken away.`;
  }

  /** Raises it off the caller's path, as a refusal's: no doctor's pass resolves it. */
  function raiseRefused(name: string, what: string, did: string): void {
    track(name, "the Connector lost access alert could not be raised", () =>
      alerts.raise(lostEvent(name, what, did, "refusal")),
    );
  }

  /**
   * Source stopped: the fleet's words for the failure hidden here again, as every word from a
   * database is, then quoted by core as a channel may show them. A stop no wait mends is no flap:
   * sent at once, never held after a resolve, whatever was sent before.
   */
  function sendStopped(name: string, stop: LoopStop): Promise<unknown> {
    return alerts.raise(
      sourceStoppedEvent(
        // Hidden before core quotes and cuts it, so no part of a secret is left at the cut.
        { source: name, why: hide(stop.why), retryAt: stop.retryAt },
        { project, link: links.stopped() },
      ),
      stop.retryAt === null ? { atOnce: true } : {},
    );
  }

  /** Source stopped, off the caller's path. */
  function raiseStopped(name: string, stop: LoopStop): void {
    raisedStopped.add(name);
    track(name, "the Source stopped alert could not be raised", () => sendStopped(name, stop));
  }

  /** Says a raise or a resolve that failed, its words hidden; nothing else is stopped by it. */
  function failed(source: string, what: string, error: unknown): void {
    try {
      // Hidden before it is cut short, so no part of a secret is left at the cut.
      print(`${source}: ${what}: ${oneLine(hide(messageOf(error)), WORDS_MAX)}`);
    } catch {
      // Printing is a courtesy: the alert's own failure stops nothing either way.
    }
  }

  /** Starts `work` off the caller's path, said if it fails, and kept until it settles. */
  function track(source: string, what: string, work: () => Promise<unknown>): void {
    const running: Promise<void> = Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        (error: unknown) => failed(source, what, error),
      )
      .finally(() => inFlight.delete(running));
    inFlight.add(running);
  }

  function lostEvent(
    source: string,
    what: string,
    did: string,
    cause: NonNullable<AlertEvent["cause"]>,
  ): AlertEvent {
    return {
      kind: "connector_lost_access",
      what,
      project,
      source,
      question: null,
      did,
      link: links.access(),
      cause,
    };
  }

  /**
   * The look's alert: the failed check by its name, in the doctor's words, as Home shows them. Its
   * cause is the doctor's, unless the alert it raises again is a refusal's: then it stays one, so a
   * later doctor's pass does not resolve the refusal the doctor cannot see.
   */
  function doctorEvent(
    source: string,
    verdict: SourceVerdict,
    cause: NonNullable<AlertEvent["cause"]>,
  ): AlertEvent {
    // Hidden before it is cut short, so no part of a secret is left at the cut.
    const words = oneLine(hide(verdict.words), WORDS_MAX);
    return lostEvent(
      source,
      `The worker cannot use the database of ${source}: its ${verdict.failedCheck ?? "database"} check fails: ${words}.`,
      `The records it cannot read wait in its queue and the other sources keep running; the worker checks ${source} again every 5 minutes.`,
      cause,
    );
  }

  /** Whether `proof` holds a time for the source after `since`. */
  function after(proof: ReadonlyMap<string, number>, name: string, since: number): boolean {
    const at = proof.get(name);
    return at !== undefined && at > since;
  }

  /** Whether this process has proof the source works made after `since` (`provenAt`). */
  function provenSince(name: string, since: number): boolean {
    return after(provenAt, name, since);
  }

  async function lookAt(source: WatchedSource): Promise<void> {
    const key = lostKey(source.name);
    if (source.kind === "table") {
      const verdict = doctorVerdict(await source.doctor());
      // A source the file let go of while its doctor ran (its loop still finishing its pass, or a
      // reload that loaded meanwhile): its alert was resolved then, and nothing is raised for it.
      if (!listed(source.name)) {
        return;
      }
      if (losesAccess(verdict)) {
        const active = await deps.active(key);
        await alerts.raise(
          doctorEvent(
            source.name,
            verdict,
            active?.event.cause === "refusal" ? "refusal" : "doctor",
          ),
        );
        return;
      }
    }
    await resolveLost(source);
    await resolveStopped(source.name);
  }

  /** A look's resolve of Connector lost access, once its doctor passes or a proof stands for it. */
  async function resolveLost(source: WatchedSource): Promise<void> {
    // A plugin source has no doctor: with no read through it that answered, nothing to look up.
    if (source.kind === "plugin" && !provenAt.has(source.name)) {
      return;
    }
    const key = lostKey(source.name);
    const active = await deps.active(key);
    if (active === undefined || !listed(source.name)) {
      return;
    }
    // A table source's doctor that raised it and passes now answers for it. What a refusal raised
    // (a right PostgreSQL's doctor does not read, a plugin's credential) waits for this process's
    // proof made after the alert began: a write before the refusal, or another worker's empty
    // passes, prove nothing.
    if (
      (source.kind === "plugin" || active.event.cause === "refusal") &&
      !provenSince(source.name, active.raisedAt)
    ) {
      return;
    }
    await alerts.resolve(key);
  }

  /**
   * A look's resolve of Source stopped: a pass of the source begun after the alert has run, so its
   * loop runs again, whether or not it had a record to write (a source that comes back quiet is
   * running). With no pass at all the store is not read. A row its resolve kept (`resolvedAt`)
   * holds no open alert: it is deleted once its 30 minutes are over (`dropKept`).
   */
  async function resolveStopped(name: string): Promise<void> {
    if (!ranAt.has(name)) {
      return;
    }
    const key = stoppedKey(name);
    const active = await deps.active(key);
    if (active === undefined) {
      return;
    }
    if ((active.resolvedAt ?? null) !== null) {
      await alerts.dropKept(key);
      return;
    }
    if (!listed(name) || !after(ranAt, name, active.raisedAt)) {
      return;
    }
    await alerts.resolve(key);
  }

  async function look(signal?: AbortSignal): Promise<void> {
    let sources: readonly WatchedSource[];
    try {
      sources = deps.sources();
    } catch (error) {
      failed("worker", "the running sources could not be listed for their check", error);
      return;
    }
    // One source after another: a look costs one doctor run per table source, never several at once.
    for (const source of sources) {
      // A stop is not held by the doctors of the sources left (each up to a connect timeout).
      if (signal?.aborted === true) {
        return;
      }
      try {
        await lookAt(source);
      } catch (error) {
        failed(
          source.name,
          "the worker's check of its access could not be made or recorded",
          error,
        );
      }
    }
    await raiseStoppedAgain(signal);
  }

  /**
   * Each source the fleet still holds stopped whose stop raised Source stopped has it raised again,
   * in the stop's present words: core's 30-minute rule keeps one already sent silent, and a raise
   * held after a resolve goes out once its 30 minutes are over, though no failed try ever raises it
   * again (a stop no wait mends, which no try follows).
   */
  async function raiseStoppedAgain(signal?: AbortSignal): Promise<void> {
    let stops: readonly ({ readonly source: string } & LoopStop)[];
    try {
      stops = deps.stoppedSources();
    } catch (error) {
      failed("worker", "the stopped sources could not be listed for their alert", error);
      return;
    }
    for (const stop of stops) {
      if (signal?.aborted === true) {
        return;
      }
      if (!raisedStopped.has(stop.source) || !listed(stop.source)) {
        continue;
      }
      try {
        await sendStopped(stop.source, stop);
      } catch (error) {
        failed(stop.source, "the Source stopped alert could not be raised", error);
      }
    }
  }

  function whoChanged(source: SourceConfig, questionSet: QuestionSet): string {
    const applied = appliedBy.get(source.name);
    return applied !== undefined && applied.set === JSON.stringify(questionSet)
      ? `by ${reviewerName(applied.by)}, through Apply in the studio`
      : `by a change to ${basename(deps.configPath)}`;
  }

  return {
    look,

    async run(signal) {
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      // A function: the sleep is where the signal changes.
      const stopped = () => signal.aborted;
      while (!stopped()) {
        await Promise.race([clock.sleep(ACCESS_CHECK_EVERY_MS, signal), aborted]);
        if (stopped()) {
          return;
        }
        await look(signal);
      }
    },

    stopped(source, error, stop) {
      const { name } = source;
      // What proved it before this failure proves nothing now.
      provenAt.delete(name);
      ranAt.delete(name);
      // Raised again by the look only when this stop raises Source stopped (`raiseStopped`).
      raisedStopped.delete(name);
      // A loop stopping after its source left the file raises nothing that could stay open.
      if (!listed(name)) {
        return;
      }
      if (error instanceof Error && error.name === "SourceAccessLost") {
        const said = PLUGIN_LOST_WORDS.test(error.message)
          ? `${sentence(error.message)}.`
          : `The plugin that reads ${name} lost access: the service it reads refused its credential.`;
        raiseRefused(
          name,
          said,
          `Stopped ${name} alone: its records wait in its queue, the other sources keep running, and the worker tries it again after a wait.`,
        );
        return;
      }
      // A table source's database, which the 5-minute look reads: an API source's is the store,
      // which no look reads, so an alert raised for it could never be resolved.
      const refused = source.table === undefined ? undefined : refusalOf(error);
      if (refused === undefined) {
        if (source.table !== undefined || source.source !== undefined) {
          raiseStopped(name, stop);
        }
        return;
      }
      const again =
        error instanceof EngineRefusal
          ? "the worker tries it again on Check again or a restart"
          : "the worker tries it again after a wait";
      raiseRefused(
        name,
        refusedWords(name, refused),
        `Stopped ${name} alone: its records wait in its queue, the other sources keep running, and ${again}.`,
      );
    },

    passed(source, report) {
      const { name } = source;
      // Any pass of a table or plugin source is its loop running again, whatever it claimed or
      // wrote: Source stopped's proof, stamped with the pass's start.
      if (source.table !== undefined || source.source !== undefined) {
        ranAt.set(name, report.startedAt);
      }
      // A table source's records only: the look that resolves reads table sources.
      if (source.table === undefined) {
        return;
      }
      let refused: Refusal | undefined;
      for (const failure of report.failures) {
        refused ??= refusalOf(failure.error);
      }
      if (refused === undefined) {
        // Proof only from a pass that wrote decisions through the source: answers (`written`) or a
        // logged answer written again (`alreadyAnswered`), both into the answer columns. One that
        // claimed nothing, whose records failed before their write (a model that did not answer),
        // or that only skipped blank records (a write of the status column alone, which another
        // column's revoked right does not stop), says nothing of the right that was refused. It
        // is stamped with the pass's start: a write the pass made before a refusal raised while it
        // ran is no proof of what came after.
        if (report.written.length + report.alreadyAnswered.length > 0) {
          provenAt.set(name, report.startedAt);
        }
        return;
      }
      provenAt.delete(name);
      if (!listed(name)) {
        return;
      }
      // Passes come every few seconds while a record keeps failing: the store is asked at most once
      // per `RETRY_EVERY_MS`, and its 30-minute rule says whether a channel hears of it again.
      const last = passRaisedAt.get(name);
      const now = clock.now();
      if (last !== undefined && now - last < RETRY_EVERY_MS) {
        return;
      }
      passRaisedAt.set(name, now);
      raiseRefused(
        name,
        refusedWords(name, refused),
        "Its records that failed go back to its queue and are tried again, and the other sources keep running; the worker checks again every 5 minutes.",
      );
    },

    proven(source) {
      provenAt.set(source, clock.now());
    },

    loaded(config, applied) {
      const names = new Set(config.sources.map((source) => source.name));
      // A source taken out of the file is no longer read: its lost access and its stop, if any, are
      // over, once what was on its way for it has landed.
      for (const name of inFile ?? []) {
        if (names.has(name)) {
          continue;
        }
        provenAt.delete(name);
        ranAt.delete(name);
        passRaisedAt.delete(name);
        appliedBy.delete(name);
        const before = [...inFlight];
        track(name, "its Connector lost access alert could not be resolved", async () => {
          await Promise.all(before);
          return alerts.resolve(lostKey(name));
        });
        raisedStopped.delete(name);
        track(name, "its Source stopped alert could not be resolved", async () => {
          await Promise.all(before);
          await alerts.resolve(stoppedKey(name));
          // Its row kept after the resolve holds nothing for a source no longer read.
          await alerts.dropKept(stoppedKey(name), { anyTime: true });
        });
      }
      inFile = names;
      if (applied === undefined || applied.source === null) {
        return;
      }
      const source = config.sources.find((candidate) => candidate.name === applied.source);
      if (source === undefined) {
        return;
      }
      try {
        appliedBy.set(source.name, {
          by: applied.by,
          set: JSON.stringify(questionSetOf(config, source)),
        });
      } catch (error) {
        failed(source.name, "who applied its question set could not be kept", error);
      }
    },

    started(source, questionSet, version, before) {
      // The first version of a source, and a start under the version it ran, raise nothing.
      if (before === null || version <= before.version) {
        return;
      }
      const changes =
        before.questionSet === null
          ? `what changed cannot be said, as version ${before.version} is kept in a form this worker cannot read`
          : changesWords(before.questionSet, questionSet);
      const event: AlertEvent = {
        kind: "question_set_changed",
        what: `The question set of ${source.name} changed from version ${before.version} to version ${version}, ${whoChanged(source, questionSet)}: ${changes}.`,
        project,
        source: source.name,
        question: null,
        did: `Answers ${source.name} with version ${version} from now on; records already answered are not asked again.`,
        link: links.questionSet(source.name),
        version,
      };
      track(source.name, "the Question set changed alert could not be raised", () =>
        alerts.raise(event),
      );
    },

    async settled() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}
