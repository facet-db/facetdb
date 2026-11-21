import type { DoctorCheck, SpendingCap } from "@facetdb/core";

/**
 * What only the CLI knows of a project, handed to the Home and Sources endpoints through
 * `ServerDeps` (this package never imports the `facetdb` package): the config's sources with the
 * engine each table source runs on, and the spending cap. The store's figures are read apart
 * (`DashboardReads`).
 */

/** How a table source notices a change. */
export type Capture = "trigger" | "change-tracking" | "change-stream" | "polling";

/**
 * Who the worker is on the source's database, and how far the install's grants let it reach: the
 * columns `read` names (Postgres, MySQL, SQL Server), every column for reading (Oracle), or the
 * whole table or collection (CockroachDB refuses column grants; MongoDB grants per collection).
 * SQLite has no login, only the file; libSQL an auth token.
 */
export type WorkerLogin =
  | {
      readonly kind: "user";
      readonly user: string;
      readonly reach: "columns" | "reads-table" | "table";
    }
  | { readonly kind: "file" }
  | { readonly kind: "token"; readonly variable: string };

/** A table source as its engine runs it. */
export type TableFacts = {
  /** The database as doctor names it: `Postgres`, `MySQL`, `SQL Server`, `MongoDB`. */
  readonly database: string;
  readonly capture: Capture;
  /** Whether the database wakes the worker itself (NOTIFY, a change stream) instead of a poll. */
  readonly pushWakeup: boolean;
  /** The table as the engine's words name it: `public.listings`. */
  readonly label: string;
  readonly storage: "inline" | "side-table";
  /** What the answers are kept in: a SQL table's columns, a document's fields. */
  readonly answersIn: "columns" | "fields";
  readonly login: WorkerLogin;
  /** The engine's doctor under the worker login: never throws, a failure is a failed check. */
  doctor(): Promise<readonly DoctorCheck[]>;
  /**
   * The database's own estimate of the table's rows, under the worker login; null when it has none
   * (an engine without one, a table never analysed). Never throws: a failed read is no estimate,
   * and the doctor beside it says why the database could not be read.
   */
  estimateRows(): Promise<number | null>;
};

export type SourceFacts = {
  readonly name: string;
  /** The state fields the questions read, in config order. */
  readonly read: readonly string[];
  readonly questions: number;
  /** The question-set version the worker runs it under. */
  readonly version: number;
  /** How its database is reached; undefined for an API source, whose records arrive by POST /v1/check. */
  readonly table: TableFacts | undefined;
};

/**
 * A source the worker ran whose loop failed: it stopped alone, the others answering on, and the
 * worker tries it again at `retryAt`. It is not among `DashboardDoor.sources`.
 */
export type StoppedSource = {
  readonly source: string;
  /** The failure in words. */
  readonly why: string;
  /** When it stopped, ISO 8601. */
  readonly since: string;
  /**
   * When the worker tries it again, ISO 8601; null when its engine refused it (another worker holds
   * a SQLite file's lock, say), which no wait mends: Check again or a restart tries it.
   */
  readonly retryAt: string | null;
};

export type DashboardDoor = {
  readonly projectId: string;
  /** The project's monthly cap; undefined when the config sets none. */
  readonly cap: SpendingCap | undefined;
  /** Every source the worker runs, in config order. */
  readonly sources: readonly SourceFacts[];
  /** The sources whose loop failed and stopped alone, waiting for their next try. */
  readonly stopped: readonly StoppedSource[];
};
