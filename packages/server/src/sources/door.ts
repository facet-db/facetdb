import type { BackfillEstimate, PreviewRow, Refusal, TableInspection } from "@facetdb/core";
import type {
  DraftIssue,
  DraftWarning,
  ReloadSummary,
  SourceDraft,
  UncommittedWords,
  Words,
} from "../config/service.ts";

/**
 * The CLI's door for the studio's setup flow: what only the `facetdb` package has (the engine
 * registry, `facetdb migrate`'s plan and its printout, Apply's judgement and write, the worker's
 * model and spending gate) handed to the server as plain operations. Each takes the admin
 * connection string for that one call, uses it and keeps nothing.
 *
 * The outcomes carry the engine's and the loader's words as they are; the setup service
 * (service.ts) is what turns them into a response, and it hides every part of the admin string and
 * puts plain words in place of anything thrown before a word leaves the server.
 */

/** A refusal before anything ran: the engine's, the scheme's, or the setup's own. */
export type SetupRefused = { readonly kind: "refused"; readonly code: string } & Words;

/** The draft broke a rule of the loader, or of the setup (a name taken, a variable unset). */
export type SetupInvalid = { readonly kind: "invalid"; readonly issues: readonly DraftIssue[] };

export type InspectOutcome =
  | {
      readonly kind: "inspected";
      /** The database in words: `Postgres`. */
      readonly database: string;
      readonly tables: readonly string[];
      /** The table asked about; null when none was. */
      readonly table: TableInspection["table"] | null;
      /**
       * A source the file already reads in this very database (host, port and name as the admin
       * string reaches them) and the variable it reads it through: the one the page suggests, so
       * one database stays one string (two variables holding one string left Apply unable to tell
       * which source reads which).
       */
      readonly sharedWith: { readonly source: string; readonly variable: string } | null;
    }
  | SetupRefused;

export type SetupPreviewOutcome =
  | {
      readonly kind: "previewed";
      readonly rows: readonly PreviewRow[];
      readonly decided: number;
      readonly review: number;
      readonly cost: { readonly inputTokens: number; readonly dollars: number };
      readonly warnings: readonly DraftWarning[];
    }
  | SetupInvalid
  | SetupRefused
  | {
      readonly kind: "capped";
      readonly message: string;
      readonly fix: string;
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: "model_failed"; readonly key: string; readonly reason: string };

/** What the install would do, shown in full before anything runs. */
export type SetupPlan = {
  readonly kind: "planned";
  /** The engine that planned it (`DatabaseEngine.name`): the install runs only on the same one. */
  readonly engine: string;
  /** The table as its engine names it: `public.listings`. */
  readonly table: string;
  /**
   * The source's install exactly as `facetdb migrate --dry-run` prints it for this source: the
   * header, the script and the notes (migrate.ts, `installPrintout`).
   */
  readonly sql: string;
  /** Whether the install runs as one transaction: all of it, or nothing. */
  readonly transactional: boolean;
  /** The config file as `--config` names it, its diff, and Apply's plan naming that diff. */
  readonly path: string;
  readonly diff: string;
  readonly diffPlan: string;
  /** Why the write would be refused without `force`: git keeps no copy of the file as it is. */
  readonly uncommitted: UncommittedWords | null;
  readonly warnings: readonly DraftWarning[];
  /** The first backfill's cost: every row of the table, priced from up to 100 of them. */
  readonly estimate: BackfillEstimate;
  /** The backfill's default pace, records per second. */
  readonly pace: number;
  /**
   * Where `estimate.records` comes from: the database's own statistics (no count was run, and the
   * where filter is not in it), or the rows read when it has none.
   */
  readonly counted: "statistics" | "rows-read";
  /**
   * The FacetDB store is another database than the source's. `facetdb migrate` prints the store's
   * part, and the line naming the source's database by its host, above this script wherever the
   * store is.
   */
  readonly storeElsewhere: boolean;
};

export type SetupPlanOutcome = SetupPlan | SetupInvalid | SetupRefused;

/** What the plan had shown, as the install is told it: the engine, the script and the diff's plan. */
export type ShownPlan = {
  readonly engine: string;
  readonly sql: string;
  readonly diffPlan: string;
  /** Replace a config file git keeps no copy of: only by the operator's choice. */
  readonly force: boolean;
};

/** Why an install run stopped: the engine's own check, the database's words, or a thrown error. */
export type StopReason =
  | { readonly kind: "refusal"; readonly refusal: Refusal }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "thrown"; readonly error: unknown };

export type SetupInstallOutcome =
  | {
      readonly kind: "installed";
      readonly table: string;
      readonly path: string;
      readonly reload: ReloadSummary;
    }
  /** The file or the draft changed since the diff was shown: nothing was written or run. */
  | { readonly kind: "stale" }
  /** Planned again right before the run, the script is not the one shown: nothing was run. */
  | { readonly kind: "plan_changed" }
  /** git keeps no copy of the file and `force` was not chosen: nothing was written or run. */
  | ({ readonly kind: "uncommitted" } & Words)
  | SetupInvalid
  | SetupRefused
  | {
      readonly kind: "stopped";
      readonly table: string;
      readonly path: string;
      /** The statement it stopped at, and what that statement was for; null when it never said. */
      readonly at: number | null;
      readonly purpose: string | null;
      readonly why: StopReason;
      /**
       * Whether the engine said how the run ended. False when the run threw (a connection lost
       * during the commit, say): whether anything committed is not known, and `kept` is 0 only
       * because nothing reported a statement.
       */
      readonly known: boolean;
      /** Statements that ran and stay in the database: none on a transactional run. */
      readonly kept: number;
      readonly transactional: boolean;
      /**
       * The config file: `restored` as it was before (nothing in it names the source); `kept`
       * naming the source, so `facetdb migrate` finishes what stayed or `facetdb uninstall` takes it
       * out; `not-restored` when putting it back failed, and `changed` when the file was edited
       * while the install ran and so was not put back: both name a source nothing installed.
       */
      readonly file: "restored" | "kept" | "not-restored" | "changed";
    };

/**
 * An added question's install, shown: the whole idempotent install of the source as the file now
 * holds it, as `facetdb migrate --source <name> --dry-run` prints the source's part.
 */
export type MigratePlan = {
  readonly kind: "planned";
  /** The engine that planned it: the run runs only on the same one. */
  readonly engine: string;
  /** The table as its engine names it: `public.listings`. */
  readonly table: string;
  /** The source's part of `facetdb migrate --source <name> --dry-run`, byte for byte. */
  readonly sql: string;
  readonly transactional: boolean;
  /** The questions the file adds to what the source runs: what the install is for. */
  readonly questions: readonly string[];
  /** The store is another database; migrate prints its part above this one wherever it is. */
  readonly storeElsewhere: boolean;
};

export type MigratePlanOutcome = MigratePlan | SetupRefused;

/** What the plan had shown, as the run is told it. */
export type ShownMigration = { readonly engine: string; readonly sql: string };

export type MigrateRunOutcome =
  /** The install ran to its end, and the worker reloaded the file. */
  | {
      readonly kind: "migrated";
      readonly table: string;
      readonly reload: ReloadSummary;
    }
  /** Planned again right before the run, the script is not the one shown: nothing was run. */
  | { readonly kind: "plan_changed" }
  | SetupRefused
  | {
      readonly kind: "stopped";
      readonly table: string;
      readonly at: number | null;
      readonly purpose: string | null;
      readonly why: StopReason;
      /** Whether the engine said how the run ended; false when it threw. */
      readonly known: boolean;
      /** Statements that ran and stay in the database: none on a transactional run. */
      readonly kept: number;
      readonly transactional: boolean;
    };

/**
 * The CLI's door for installing an added question from the studio: `facetdb migrate`'s plan for one
 * source of the file as it loads now, refused for anything but questions added (the reload's own
 * rule), and its run, which writes no file and ends by asking the worker to reload. Each call takes
 * the admin connection string for that call and keeps nothing.
 */
export type MigrateDoor = {
  readonly available: boolean;
  plan(name: string, admin: string): Promise<MigratePlanOutcome>;
  run(name: string, admin: string, shown: ShownMigration): Promise<MigrateRunOutcome>;
};

export type SetupDoor = {
  /**
   * Whether this worker can add a source at all: it writes facetdb.config.ts (not under `--once`;
   * `facetdb dev` does, on its embedded database). The routes refuse before any call when it
   * cannot.
   */
  readonly available: boolean;
  inspect(admin: string, table: string | undefined): Promise<InspectOutcome>;
  preview(admin: string, draft: SourceDraft, limit: number): Promise<SetupPreviewOutcome>;
  plan(admin: string, draft: SourceDraft): Promise<SetupPlanOutcome>;
  install(admin: string, draft: SourceDraft, shown: ShownPlan): Promise<SetupInstallOutcome>;
};
