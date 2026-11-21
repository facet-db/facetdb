import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Clock } from "@facetdb/core";
import type { DraftIssue, ReloadSummary, SourceDraft, Words } from "../config/service.ts";
import type {
  MigrateDoor,
  MigrateRunOutcome,
  SetupDoor,
  SetupInstallOutcome,
  SetupInvalid,
  SetupPlan,
  SetupRefused,
  StopReason,
} from "./door.ts";
import { INSTALL_OUTCOME_UNKNOWN, INSTALL_STOPPED } from "./install-codes.ts";
import { hideSecrets, secretParts } from "./redact.ts";

/**
 * The setup flow's service: the studio's six steps over the CLI's door (door.ts). What it adds to
 * the door is what the HTTP surface owes the operator:
 *  - the admin connection string is used for one call and never kept: not in a token, a log line,
 *    an error's words or a response; every word that leaves is passed through `hideSecrets`, and
 *    anything thrown is replaced by plain words chosen from its kind alone (`plainFailure`);
 *  - an install runs only a plan this worker showed (`/plan` answers a token naming the script, the
 *    diff's plan and the draft), once, within `PLAN_TOKEN_TTL_MS`; the door plans again and runs
 *    only when the script is still the one shown;
 *  - the log gets the step and the kind of each refusal or failure, never a message.
 * An added question's install is served on the same terms by the migrate door: its own token, which
 * says the kind of run it was made for (a setup's token runs no migration and the reverse), bound
 * to the source, the SQL shown and the admin string's HMAC.
 */

/** How long a shown plan may be installed. The setup's own decision. */
export const PLAN_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The most plans held at once; the oldest is dropped past it. */
const MAX_PLANS = 32;

/** The newest rows the setup's preview answers. */
export const SETUP_PREVIEW_ROWS = 20;

/** A failure in the surface's one shape, with its status and headers. */
export type SetupFailure = {
  readonly status: 400 | 403 | 409 | 429 | 500 | 502 | 503;
  readonly code: string;
  readonly message: string;
  readonly fix: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type SetupAnswer<Body> =
  | { readonly ok: true; readonly body: Body }
  | { readonly ok: false; readonly failure: SetupFailure };

/** `GET /v1/sources/setup`: whether this browser may add a source here, and if not why. */
export type SetupAccess =
  | { readonly open: true }
  | { readonly open: false; readonly code: string; readonly message: string; readonly fix: string };

/**
 * Whether the worker answers the source the setup installed: the reload after the install started
 * it, with the version it answers under; or it did not, with the reload's own why (what is missing
 * and the command) and how to restart the worker.
 */
export type SetupWorker =
  | { readonly running: true; readonly version: number; readonly words: string }
  | { readonly running: false; readonly why: string; readonly restart: string };

/** What the reload after an install says of the new source, as the page's last step shows it. */
export function workerAfterInstall(
  reload: ReloadSummary,
  name: string,
  table: string,
): SetupWorker {
  const restart = `Until then the worker that is running does not answer ${name}. To restart it, stop facetdb worker (Ctrl+C) and start it again: it reads facetdb.config.ts as it is and answers every change to ${table} from then on.`;
  if (!reload.loaded) {
    return { running: false, why: `${reload.message} ${reload.fix}`, restart };
  }
  const entry = reload.sources.find((source) => source.source === name);
  if (entry?.outcome === "started" && entry.version !== null) {
    return {
      running: true,
      version: entry.version,
      words: `${name} is running with version ${entry.version}: it answers every change to ${table} from now on.`,
    };
  }
  return {
    running: false,
    why:
      entry?.message ??
      `the worker read facetdb.config.ts again and did not say what it did with ${name}.`,
    restart,
  };
}

export type SetupService = {
  /** `operator`: the request is this machine's operator (loopback, no session cookie). */
  access(operator: boolean): SetupAccess;
  inspect(admin: string, table: string | undefined): Promise<SetupAnswer<unknown>>;
  preview(admin: string, draft: SourceDraft): Promise<SetupAnswer<unknown>>;
  plan(admin: string, draft: SourceDraft): Promise<SetupAnswer<unknown>>;
  install(
    admin: string,
    draft: SourceDraft,
    confirm: { readonly token: string; readonly force: boolean },
  ): Promise<SetupAnswer<unknown>>;
  /** An added question's install for the source `name`, shown with a token that runs it. */
  migratePlan(admin: string, name: string): Promise<SetupAnswer<unknown>>;
  /** Runs the install a `migratePlan` token names, once, then the worker reloads. */
  migrateRun(
    admin: string,
    name: string,
    confirm: { readonly token: string },
  ): Promise<SetupAnswer<unknown>>;
};

export type SetupServiceDeps = {
  readonly door: SetupDoor;
  /** The install of an added question; absent, this worker offers none. */
  readonly migrate?: MigrateDoor;
  readonly clock: Clock;
  /** The worker's log: the step and the kind of each refusal and failure, nothing else. */
  readonly log: (line: string) => void;
  /** Makes a plan token; the composition root's is random, a test's a counter. */
  readonly newToken?: () => string;
};

/** What a request from another machine, or one signed in, is told before step one. */
export const OPERATOR_ONLY: Words & { readonly code: string } = {
  code: "operator_only",
  message:
    "Adding a source connects to your database with an admin connection string, so it is done only in the studio on the machine that runs facetdb worker, opened there with no sign-in.",
  fix: "Open the studio on that machine (facetdb studio), or run facetdb init and facetdb migrate there.",
};

const UNAVAILABLE: Words & { readonly code: string } = {
  code: "setup_unavailable",
  message:
    "This worker does not write facetdb.config.ts (facetdb worker --once never does), so it cannot add a source.",
  fix: "Run facetdb worker to add a source from the studio, or add it to facetdb.config.ts and run facetdb migrate.",
};

/**
 * What a request from another machine, or one signed in, is told when it asks to install an added
 * question: the commands stay the way to do it from there.
 */
export const MIGRATE_OPERATOR_ONLY: Words & { readonly code: string } = {
  code: "operator_only",
  message:
    "Installing a question connects to your database with an admin connection string, so it is done only in the studio on the machine that runs facetdb worker, opened there with no sign-in.",
  fix: "Open the studio on that machine (facetdb studio), or run facetdb migrate --source <name> there, then restart facetdb worker.",
};

const MIGRATE_UNAVAILABLE: Words & { readonly code: string } = {
  code: "setup_unavailable",
  message:
    "This worker does not install questions from the studio (facetdb worker --once never does).",
  fix: "Run facetdb migrate --source <name> in a terminal, then restart the worker.",
};

/**
 * The setup of a surface that has none to offer (a test's app, a server made without a door): the
 * operator is told it cannot be done here, and nothing is called.
 */
export const NO_SETUP: SetupService = {
  access: (operator) =>
    operator ? { open: false, ...UNAVAILABLE } : { open: false, ...OPERATOR_ONLY },
  inspect: () => Promise.resolve({ ok: false, failure: { status: 409, ...UNAVAILABLE } }),
  preview: () => Promise.resolve({ ok: false, failure: { status: 409, ...UNAVAILABLE } }),
  plan: () => Promise.resolve({ ok: false, failure: { status: 409, ...UNAVAILABLE } }),
  install: () => Promise.resolve({ ok: false, failure: { status: 409, ...UNAVAILABLE } }),
  migratePlan: () =>
    Promise.resolve({ ok: false, failure: { status: 409, ...MIGRATE_UNAVAILABLE } }),
  migrateRun: () =>
    Promise.resolve({ ok: false, failure: { status: 409, ...MIGRATE_UNAVAILABLE } }),
};

/** A migrate door that offers nothing: the routes answer that this worker installs no question. */
const NO_MIGRATE: MigrateDoor = {
  available: false,
  plan: () => Promise.reject(new Error("this worker installs no question")),
  run: () => Promise.reject(new Error("this worker installs no question")),
};

/** A value as one string with every object's keys sorted: the same draft, whatever the order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(",")}}`;
  }
  // A draft is a parsed JSON body: every value is JSON's own, never undefined.
  return JSON.stringify(value);
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An error's own code when it is a plain one (`ECONNREFUSED`, `28P01`); nothing else of it is read. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/**
 * Plain words for something thrown, chosen from its code alone: its message is never read, since a
 * driver's message may carry the host, the user or the whole connection string.
 */
export function plainFailure(error: unknown): SetupFailure {
  const code = codeOf(error);
  const where =
    "Run facetdb migrate --dry-run on the machine that runs the worker to see the database's own words.";
  if (code !== undefined && UNREACHABLE.has(code)) {
    return {
      status: 502,
      code: "database_unreachable",
      message: "The database could not be reached at the address in the connection string.",
      fix: "Check the host and the port, that the database is running, and that this machine may reach it; then connect again.",
    };
  }
  if (code === "28P01" || code === "28000") {
    return {
      status: 502,
      code: "login_refused",
      message: "The database refused the login in the connection string.",
      fix: "Check the user and the password in the connection string, then connect again.",
    };
  }
  if (code === "3D000") {
    return {
      status: 502,
      code: "no_database",
      message: "The database named in the connection string does not exist on that server.",
      fix: "Check the database name at the end of the connection string, then connect again.",
    };
  }
  if (code === "42501") {
    return {
      status: 502,
      code: "permission_denied",
      message:
        "The role in the connection string may not do this (the database said permission denied).",
      fix: `Use the connection string of the table's owner, or of a role that may alter it. ${where}`,
    };
  }
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code)) {
    return {
      status: 502,
      code: "database_error",
      message: `The database answered with an error (SQLSTATE ${code}).`,
      fix: where,
    };
  }
  return {
    status: 500,
    code: "setup_failed",
    message: "The setup failed on the worker's side.",
    fix: `Try again; if it keeps failing, ${where.charAt(0).toLowerCase()}${where.slice(1)}`,
  };
}

function issuesInWords(issues: readonly DraftIssue[]): string {
  return issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ");
}

/** One call's words, its admin string hidden: `hide` for an answer, `say` for the log. */
type Tools = {
  readonly hide: (text: string) => string;
  readonly say: (line: string) => void;
};

/**
 * A shown plan, held by its token: what it showed, for which kind of run, and for which draft or
 * source. A setup's token runs no migration and a migration's token installs no new source.
 */
type HeldPlan = {
  /** `install`: a new source's setup; `migrate`: an added question's install. */
  readonly kind: "install" | "migrate";
  /** The draft's hash for an install; the source's name for a migration. */
  readonly subject: string;
  /** The admin string as a keyed hash under this process's key: never the string. */
  readonly admin: string;
  readonly engine: string;
  readonly sql: string;
  readonly diffPlan: string;
  readonly expiresAt: number;
};

/** Plain words on what a stopped install left, in the database and in the file, and what to run. */
function stoppedWords(
  outcome: Extract<SetupInstallOutcome, { kind: "stopped" }>,
  source: string,
  reason: string,
): Words {
  const where =
    outcome.at === null
      ? "The install failed"
      : `The install stopped at statement ${outcome.at + 1}${outcome.purpose === null ? "" : ` (${outcome.purpose})`}`;
  const database =
    outcome.kept === 0
      ? outcome.transactional
        ? `Nothing changed in the database: the install runs as one transaction, and it was rolled back.`
        : "Nothing changed in the database: no statement ran."
      : `${outcome.kept} statement(s) before it ran and stay in the database on ${outcome.table}.`;
  const file = {
    restored: `${outcome.path} was put back as it was.`,
    kept: `${outcome.path} keeps the source ${source}, so the install can be finished.`,
    "not-restored": `${outcome.path} names the source ${source}, and putting it back as it was failed.`,
    changed: `${outcome.path} names the source ${source}; it was edited while the install ran, so it was not put back over that edit.`,
  }[outcome.file];
  const fix =
    outcome.file === "kept"
      ? `Run facetdb migrate --source ${source} on this machine: it plans afresh from what is in the database and finishes the install. To take it out instead, run facetdb uninstall --source ${source}.`
      : outcome.file === "restored"
        ? "Fix what the database said, then show the SQL again and install."
        : `Run facetdb migrate --source ${source} to install it (the SQL is printed first), or remove the source ${source} from ${outcome.path}.`;
  return { message: `${where}: ${reason}. ${database} ${file}`, fix };
}

/**
 * What the worker answers when the install's outcome is not known: the request reached the door
 * and something failed without the engine saying how the run ended.
 */
function unknownOutcome(source: string): SetupFailure {
  return {
    status: 502,
    code: INSTALL_OUTCOME_UNKNOWN,
    message: `The install of ${source} was started, and the worker could not learn how it ended: it may have run, in whole or not at all, and facetdb.config.ts keeps the source ${source}.`,
    fix: `Look before anything else: run facetdb migrate --source ${source} --dry-run on the machine that runs the worker (it prints nothing to run once the install is there, or the SQL still to run), then facetdb migrate --source ${source} to finish it or facetdb uninstall --source ${source} to take it out.`,
  };
}

export function createSetupService(deps: SetupServiceDeps): SetupService {
  const { door, clock, log } = deps;
  const migrate = deps.migrate ?? NO_MIGRATE;
  // Offered only where the setup is: the same worker, writing the same file, on this machine.
  const migrating = { available: door.available && migrate.available, words: MIGRATE_UNAVAILABLE };
  const newToken = deps.newToken ?? (() => randomBytes(24).toString("base64url"));
  const plans = new Map<string, HeldPlan>();
  // A key made once for this process: a held plan names its admin string by a keyed hash, so an
  // install with another string is refused, and nothing held can be turned back into the string.
  const bindingKey = randomBytes(32);
  const bound = (admin: string) => createHmac("sha256", bindingKey).update(admin).digest("hex");

  /** Drops what is past its life, and the oldest past `MAX_PLANS`. */
  function prune(now: number): void {
    for (const [token, held] of plans) {
      if (held.expiresAt <= now) {
        plans.delete(token);
      }
    }
    for (const token of plans.keys()) {
      if (plans.size <= MAX_PLANS) {
        break;
      }
      plans.delete(token);
    }
  }

  /**
   * Runs one door call with its words hidden: `hide` for what is answered, `say` for the log, both
   * without any part of this call's admin string. Anything thrown becomes plain words, and its kind
   * alone is logged.
   */
  async function guarded<Body>(
    step: string,
    admin: string,
    work: (tools: Tools) => Promise<SetupAnswer<Body>>,
    offered: { readonly available: boolean; readonly words: Words & { readonly code: string } } = {
      available: door.available,
      words: UNAVAILABLE,
    },
  ): Promise<SetupAnswer<Body>> {
    const parts = secretParts(admin);
    const hide = (text: string) => hideSecrets(text, parts);
    const say = (line: string) => {
      log(hide(line));
    };
    if (!offered.available) {
      return { ok: false, failure: { status: 409, ...offered.words } };
    }
    try {
      return await work({ hide, say });
    } catch (error) {
      const failure = plainFailure(error);
      say(
        `setup: ${step} failed (${codeOf(error) ?? (error instanceof Error ? error.name : "error")})`,
      );
      return { ok: false, failure };
    }
  }

  function refused(step: string, outcome: SetupRefused, { hide, say }: Tools) {
    say(`setup: ${step} refused (${outcome.code})`);
    return {
      ok: false as const,
      failure: {
        status: 409 as const,
        code: outcome.code,
        message: hide(outcome.message),
        fix: hide(outcome.fix),
      },
    };
  }

  function invalid(step: string, outcome: SetupInvalid, { hide, say }: Tools) {
    say(`setup: ${step} refused the draft (${outcome.issues.length} problem(s))`);
    return {
      ok: false as const,
      failure: {
        status: 400 as const,
        code: "invalid_draft",
        message: hide(
          `The draft has problems: ${issuesInWords(outcome.issues)}. Nothing was changed.`,
        ),
        fix: "Fix each field named, then try again.",
      },
    };
  }

  function stopWords(why: StopReason, hide: (text: string) => string): string {
    switch (why.kind) {
      case "refusal":
        return hide(`${why.refusal.message}; ${why.refusal.fix}`);
      case "error":
        return hide(`the database said: ${why.error}`);
      case "thrown":
        return plainFailure(why.error).message.replace(/\.$/, "");
    }
  }

  return {
    access(operator) {
      if (!operator) {
        return { open: false, ...OPERATOR_ONLY };
      }
      return door.available ? { open: true } : { open: false, ...UNAVAILABLE };
    },

    inspect: (admin, table) =>
      guarded("inspect", admin, async (tools) => {
        const outcome = await door.inspect(admin, table);
        if (outcome.kind === "refused") {
          return refused("inspect", outcome, tools);
        }
        return {
          ok: true,
          body: {
            database: outcome.database,
            tables: outcome.tables,
            table: outcome.table,
            sharedWith: outcome.sharedWith,
          },
        };
      }),

    preview: (admin, draft) =>
      guarded("preview", admin, async (tools) => {
        const outcome = await door.preview(admin, draft, SETUP_PREVIEW_ROWS);
        switch (outcome.kind) {
          case "previewed": {
            const { kind: _kind, ...body } = outcome;
            return { ok: true, body };
          }
          case "refused":
            return refused("preview", outcome, tools);
          case "invalid":
            return invalid("preview", outcome, tools);
          case "capped":
            tools.say("setup: preview stopped at the spending cap");
            return {
              ok: false,
              failure: {
                status: 429,
                code: "spending_cap_reached",
                message: outcome.message,
                fix: outcome.fix,
                headers: { "retry-after": String(outcome.retryAfterSeconds) },
              },
            };
          case "model_failed":
            tools.say("setup: preview's model call failed");
            return {
              ok: false,
              failure: {
                status: 503,
                code: "model_unavailable",
                message: tools.hide(
                  `The model did not answer for row ${outcome.key}: ${outcome.reason}. Nothing was written.`,
                ),
                fix: "Preview again in a minute; if it keeps failing, run facetdb doctor to check the model key.",
              },
            };
        }
      }),

    plan: (admin, draft) =>
      guarded("plan", admin, async (tools) => {
        const outcome = await door.plan(admin, draft);
        if (outcome.kind === "refused") {
          return refused("plan", outcome, tools);
        }
        if (outcome.kind === "invalid") {
          return invalid("plan", outcome, tools);
        }
        const now = clock.now();
        prune(now);
        const token = newToken();
        plans.set(token, {
          kind: "install",
          subject: hash(canonical(draft)),
          admin: bound(admin),
          engine: outcome.engine,
          sql: outcome.sql,
          diffPlan: outcome.diffPlan,
          expiresAt: now + PLAN_TOKEN_TTL_MS,
        });
        tools.say(`setup: planned the install of ${draft.name} on ${outcome.table}`);
        return { ok: true, body: planBody(outcome, draft.name, token, tools.hide) };
      }),

    install: (admin, draft, confirm) =>
      guarded("install", admin, async (tools) => {
        const now = clock.now();
        const held = plans.get(confirm.token);
        // Once: a token is spent by the attempt, whatever the attempt's outcome.
        plans.delete(confirm.token);
        if (
          held === undefined ||
          held.expiresAt <= now ||
          held.kind !== "install" ||
          held.subject !== hash(canonical(draft))
        ) {
          tools.say("setup: install refused (no plan shown for this draft)");
          return {
            ok: false,
            failure: {
              status: 409,
              code: "plan_not_shown",
              message:
                "This install names no plan this worker showed for this draft: the plan was never shown, was already used, is more than 10 minutes old, or was made for other questions. Nothing ran.",
              fix: "Show the SQL again, read it, and install the plan it answers with.",
            },
          };
        }
        // The plan was made against one database: another connection string is another database
        // (or another role), whose script nobody read.
        if (held.admin !== bound(admin)) {
          tools.say("setup: install refused (another connection string than the plan's)");
          return {
            ok: false,
            failure: {
              status: 409,
              code: "plan_changed",
              message:
                "This install came with another connection string than the one the SQL was shown for, so nothing was written and nothing ran.",
              fix: "Show the SQL again with the connection string you mean to install with, read it, and install.",
            },
          };
        }
        let outcome: SetupInstallOutcome;
        try {
          outcome = await door.install(admin, draft, {
            engine: held.engine,
            sql: held.sql,
            diffPlan: held.diffPlan,
            force: confirm.force,
          });
        } catch (error) {
          // Thrown once the door had the request: the file may be written and the plan may have
          // run, so nothing here says it did not.
          tools.say(
            `setup: install of ${draft.name} failed, outcome unknown (${codeOf(error) ?? (error instanceof Error ? error.name : "error")})`,
          );
          return { ok: false, failure: unknownOutcome(draft.name) };
        }
        switch (outcome.kind) {
          case "installed":
            tools.say(`setup: installed ${draft.name} on ${outcome.table}`);
            return {
              ok: true,
              body: {
                installed: true,
                table: outcome.table,
                path: outcome.path,
                reload: outcome.reload,
                // Started by the reload, or why not and the restart.
                worker: workerAfterInstall(outcome.reload, draft.name, outcome.table),
                backfill: `Then answer the records already in ${outcome.table}: facetdb backfill --source ${draft.name} shows its estimate before it asks anything.`,
              },
            };
          case "stale":
            tools.say("setup: install refused (the file or the draft changed since the diff)");
            return {
              ok: false,
              failure: {
                status: 409,
                code: "plan_changed",
                message:
                  "facetdb.config.ts or the draft changed since the diff that was shown, so nothing was written and nothing ran.",
                fix: "Show the SQL and the diff again, read them, and install.",
              },
            };
          case "plan_changed":
            tools.say("setup: install refused (the database changed since the plan)");
            return {
              ok: false,
              failure: {
                status: 409,
                code: "database_changed",
                message:
                  "The database changed since the SQL was shown: planned again, the install is not the script you read, so nothing was written and nothing ran.",
                fix: "Show the SQL again, read the new script, and install that.",
              },
            };
          case "uncommitted":
            tools.say("setup: install refused (the config file holds changes git has not kept)");
            return {
              ok: false,
              failure: {
                status: 409,
                code: "uncommitted_changes",
                message: `${tools.hide(outcome.message)}. Nothing was written and nothing ran.`,
                fix: tools.hide(outcome.fix),
              },
            };
          case "invalid":
            return invalid("install", outcome, tools);
          case "refused": {
            // Refused before the file was written or anything ran; one code for every such
            // refusal, so the page can tell it from an install that started.
            const words = refused("install", outcome, tools);
            return {
              ok: false,
              failure: { ...words.failure, code: "install_refused" },
            };
          }
          case "stopped": {
            tools.say(
              `setup: install of ${draft.name} stopped (${outcome.why.kind === "refusal" ? outcome.why.refusal.code : outcome.why.kind === "thrown" ? (codeOf(outcome.why.error) ?? "thrown") : "database error"}; file ${outcome.file})`,
            );
            if (!outcome.known) {
              return { ok: false, failure: unknownOutcome(draft.name) };
            }
            const words = stoppedWords(outcome, draft.name, stopWords(outcome.why, tools.hide));
            return {
              ok: false,
              failure: { status: 409, code: INSTALL_STOPPED, ...words },
            };
          }
        }
      }),

    migratePlan: (admin, name) =>
      guarded(
        "migrate plan",
        admin,
        async (tools) => {
          const outcome = await migrate.plan(name, admin);
          if (outcome.kind === "refused") {
            return refused("migrate plan", outcome, tools);
          }
          const now = clock.now();
          prune(now);
          const token = newToken();
          plans.set(token, {
            kind: "migrate",
            subject: name,
            admin: bound(admin),
            engine: outcome.engine,
            sql: outcome.sql,
            diffPlan: "",
            expiresAt: now + PLAN_TOKEN_TTL_MS,
          });
          tools.say(`setup: planned the install of ${name}'s added questions on ${outcome.table}`);
          return {
            ok: true,
            body: {
              token,
              expiresInSeconds: PLAN_TOKEN_TTL_MS / 1000,
              table: outcome.table,
              sql: outcome.sql,
              transactional: outcome.transactional,
              questions: outcome.questions,
              storeElsewhere: outcome.storeElsewhere,
            },
          };
        },
        migrating,
      ),

    migrateRun: (admin, name, confirm) =>
      guarded(
        "migrate run",
        admin,
        async (tools) => {
          const now = clock.now();
          const held = plans.get(confirm.token);
          // Once: a token is spent by the attempt, whatever the attempt's outcome.
          plans.delete(confirm.token);
          if (
            held === undefined ||
            held.expiresAt <= now ||
            held.kind !== "migrate" ||
            held.subject !== name
          ) {
            tools.say("setup: migrate run refused (no plan shown for this source)");
            return {
              ok: false,
              failure: {
                status: 409,
                code: "plan_not_shown",
                message: `This run names no install this worker showed for ${name}: it was never shown, was already used, is more than 10 minutes old, or was made for something else. Nothing ran.`,
                fix: "Show the SQL again, read it, and install the plan it answers with.",
              },
            };
          }
          if (held.admin !== bound(admin)) {
            tools.say("setup: migrate run refused (another connection string than the plan's)");
            return {
              ok: false,
              failure: {
                status: 409,
                code: "plan_changed",
                message:
                  "This run came with another connection string than the one the SQL was shown for, so nothing ran.",
                fix: "Show the SQL again with the connection string you mean to install with, read it, and install.",
              },
            };
          }
          let outcome: MigrateRunOutcome;
          try {
            outcome = await migrate.run(name, admin, { engine: held.engine, sql: held.sql });
          } catch (error) {
            // Thrown once the door had the request: the plan may have run, so nothing here says
            // it did not.
            tools.say(
              `setup: migrate run of ${name} failed, outcome unknown (${codeOf(error) ?? (error instanceof Error ? error.name : "error")})`,
            );
            return { ok: false, failure: migrateUnknown(name) };
          }
          switch (outcome.kind) {
            case "migrated":
              tools.say(`setup: installed ${name}'s added questions on ${outcome.table}`);
              return {
                ok: true,
                body: { migrated: true, table: outcome.table, reload: outcome.reload },
              };
            case "plan_changed":
              tools.say(
                "setup: migrate run refused (the database or the file changed since the plan)",
              );
              return {
                ok: false,
                failure: {
                  status: 409,
                  code: "database_changed",
                  message:
                    "The database or facetdb.config.ts changed since the SQL was shown: planned again, the install is not the script you read, so nothing ran.",
                  fix: "Show the SQL again, read the new script, and install that.",
                },
              };
            case "refused": {
              // Refused before any statement ran; one code for every such refusal.
              const words = refused("migrate run", outcome, tools);
              return { ok: false, failure: { ...words.failure, code: "install_refused" } };
            }
            case "stopped": {
              tools.say(
                `setup: migrate run of ${name} stopped (${outcome.why.kind === "refusal" ? outcome.why.refusal.code : outcome.why.kind === "thrown" ? (codeOf(outcome.why.error) ?? "thrown") : "database error"})`,
              );
              if (!outcome.known) {
                return { ok: false, failure: migrateUnknown(name) };
              }
              return {
                ok: false,
                failure: {
                  status: 409,
                  code: INSTALL_STOPPED,
                  ...migrateStoppedWords(outcome, name, stopWords(outcome.why, tools.hide)),
                },
              };
            }
          }
        },
        migrating,
      ),
  };
}

/**
 * Plain words on what a stopped install of added questions left: the database as the engine said,
 * and the source, which keeps answering with the version it ran, since no reload follows a run that
 * did not finish.
 */
function migrateStoppedWords(
  outcome: Extract<MigrateRunOutcome, { kind: "stopped" }>,
  source: string,
  reason: string,
): Words {
  const where =
    outcome.at === null
      ? "The install failed"
      : `The install stopped at statement ${outcome.at + 1}${outcome.purpose === null ? "" : ` (${outcome.purpose})`}`;
  const database =
    outcome.kept === 0
      ? outcome.transactional
        ? "Nothing changed in the database: the install runs as one transaction, and it was rolled back."
        : "Nothing changed in the database: no statement ran."
      : `${outcome.kept} statement(s) before it ran and stay in the database on ${outcome.table}.`;
  return {
    message: `${where}: ${reason}. ${database} ${source} keeps answering with the version it ran.`,
    fix:
      outcome.kept === 0
        ? "Fix what the database said, then show the SQL again and install."
        : `Show the SQL again: the install plans afresh from what is in the database and finishes it. Or run facetdb migrate --source ${source} on this machine, then restart facetdb worker.`,
  };
}

/** What the worker answers when an added question's install was started and its end is not known. */
function migrateUnknown(source: string): SetupFailure {
  return {
    status: 502,
    code: INSTALL_OUTCOME_UNKNOWN,
    message: `The install for ${source} was started, and the worker could not learn how it ended: it may have run, in whole or not at all. ${source} keeps answering with the version it ran.`,
    fix: `Look before anything else: run facetdb migrate --source ${source} --dry-run on the machine that runs the worker (it prints the SQL still to run). Then show the SQL here again, or run facetdb migrate --source ${source} and restart facetdb worker.`,
  };
}

/** The plan as the page shows it: the script, the diff, the estimate, and the token to install it. */
function planBody(plan: SetupPlan, source: string, token: string, hide: (text: string) => string) {
  const seconds = plan.pace > 0 ? Math.ceil(plan.estimate.records / plan.pace) : 0;
  return {
    token,
    expiresInSeconds: PLAN_TOKEN_TTL_MS / 1000,
    table: plan.table,
    sql: plan.sql,
    transactional: plan.transactional,
    path: plan.path,
    diff: plan.diff,
    uncommitted:
      plan.uncommitted === null
        ? null
        : {
            state: plan.uncommitted.state,
            message: hide(plan.uncommitted.message),
            fix: hide(plan.uncommitted.fix),
          },
    warnings: plan.warnings,
    backfill: {
      records: plan.estimate.records,
      inputTokens: Math.round(plan.estimate.tokens),
      dollars: plan.estimate.dollars,
      pace: plan.pace,
      seconds,
      command: `facetdb backfill --source ${source}`,
      counted: plan.counted,
    },
    storeElsewhere: plan.storeElsewhere,
  };
}
