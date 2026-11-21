import {
  type Capabilities,
  type DatabaseEngine,
  type DoctorCheck,
  type EngineDeps,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type InspectOptions,
  type InspectResult,
  type InstallOptions,
  type KeyText,
  type OpenConnector,
  type OpenOptions,
  type PlanResult,
  type PlanStatement,
  type ReadRow,
  type Refusal,
  type RunOptions,
  type RunResult,
  type UninstallOptions,
} from "../contracts/index.ts";
import { FakeConnector, type FakeDatabase } from "./connector.ts";

/** The plans a fake engine hands out, made from the target and options of each call. */
export type FakePlans = {
  readonly install?: (target: EngineTarget, options: InstallOptions) => PlanResult;
  readonly uninstall?: (target: EngineTarget, options: UninstallOptions) => PlanResult;
  readonly prune?: (target: EngineTarget) => PlanResult;
};

export type FakeEngineOptions = {
  /** Defaults to `fake`. */
  readonly name?: string;
  /** Defaults to `["fake"]`. */
  readonly schemes?: readonly string[];
  readonly capabilities?: Capabilities;
  /**
   * How the engine names a target's table (`DatabaseEngine.label`): a schema-bearing engine's
   * default, `dbo.listings`; a connection-database engine's, from `url`'s path (`app.listings`).
   * When absent, the table as the config writes it, with its schema only when it names one: a
   * schema-less engine's words.
   */
  readonly label?: (target: EngineTarget, url: string) => string;
  readonly plans?: FakePlans;
  /** A finished run's notes (`deleted` where the plan said `deletes`); the plan's when absent. */
  readonly runNotes?: (target: EngineTarget, plan: EnginePlan) => readonly string[];
  /**
   * Whether a target's run is its uninstall's last, which removes the `run`-scoped objects too: a
   * real engine learns it at run time (nothing needs them any more). Every run is, when absent.
   */
  readonly lastOfRun?: (target: EngineTarget) => boolean;
  /** What `doctor --dry-run` lists; none when absent. */
  readonly checks?: DatabaseEngine["checks"];
  /** What `doctor` reports for a target; no check at all when absent. */
  readonly doctor?: (target: EngineTarget) => readonly DoctorCheck[];
  /** The database `open` hands connectors over; `open` rejects without one. */
  readonly database?: FakeDatabase;
  /** How its keys are written on the terminal (a tagged-key engine's); absent, keys are text. */
  readonly keyText?: KeyText;
  /**
   * The key text a table's own database records (`DatabaseEngine.keyTextOf`: MongoDB's marker);
   * absent, the engine has none and `keyText` is every table's.
   */
  readonly keyTextOf?: (target: EngineTarget, url: string) => KeyText;
  /** How it reads a connection string's login (`DatabaseEngine.login`); absent, the URL's. */
  readonly login?: NonNullable<DatabaseEngine["login"]>;
  /**
   * What `inspect` finds, for a table or for none; absent, the engine has no `inspect`, as an
   * engine the studio cannot set up a source on yet. An insecure URL is refused before it.
   */
  readonly inspect?: (options: InspectOptions) => InspectResult;
  /**
   * The database's estimate of a source table's rows (`DatabaseEngine.estimateRows`); absent, the
   * engine has none. An insecure URL is refused before it, as `open` refuses one.
   */
  readonly estimateRows?: (target: EngineTarget) => number | null;
};

/** One `run` as the fake saw it. */
export type FakeRun = {
  /** The target's source name. */
  readonly source: string;
  readonly url: string;
  /** What it executed, in order: every statement, or up to and including the one it stopped at. */
  readonly statements: readonly PlanStatement[];
  /** Whether a worker password was given; the password itself is never kept. */
  readonly workerPassword: boolean;
};

/** Why a run stops: one of the engine's own checks refusing, or a database error. */
export type FakeStop = { readonly refusal: Refusal } | { readonly error: string };

const FAKE_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: true,
  transactions: true,
  sideTable: false,
  multipleWorkers: true,
};

/** What a real engine says when a plan sets the worker password and the run was given none. */
const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};

/** A host the connection never leaves this machine for; a URL with no host names a file. */
function loopback(host: string): boolean {
  return host === "" || host === "localhost" || host === "[::1]" || host.startsWith("127.");
}

/** The `sslmode`s that encrypt, and those that may not, as the Postgres store reads them. */
const TLS_MODES: ReadonlySet<string> = new Set(["require", "verify-ca", "verify-full"]);
const PLAINTEXT_MODES: ReadonlySet<string> = new Set(["disable", "allow", "prefer"]);

/**
 * The refusal a real engine gives, before it connects, for a URL that would carry a password to
 * another machine in the clear, unless the operator allowed it. The rule is the Postgres store's
 * (`requireTls`): the last `sslmode` counts, `require`, `verify-ca` and `verify-full` encrypt,
 * `disable`, `allow` and `prefer` do not even beside `ssl=true`, and otherwise `ssl=true` does. It
 * leaves out the store's `PGHOST`, socket and several-host cases, and takes `tls=true`, the other
 * drivers' spelling, as `ssl=true`.
 */
function plaintextRefusal(
  url: string,
  deps: Pick<EngineDeps, "allowInsecure">,
): Refusal | undefined {
  if (deps.allowInsecure || !URL.canParse(url)) {
    return undefined;
  }
  const { hostname, searchParams } = new URL(url);
  const mode = searchParams.getAll("sslmode").at(-1);
  const flag = searchParams.getAll("ssl").at(-1) ?? searchParams.getAll("tls").at(-1);
  const encrypted =
    mode !== undefined && PLAINTEXT_MODES.has(mode)
      ? false
      : (mode !== undefined && TLS_MODES.has(mode)) || flag === "true";
  if (encrypted || loopback(hostname)) {
    return undefined;
  }
  return {
    code: "insecure-url",
    message: `the URL would send the password to ${hostname} in the clear; nothing was connected`,
    fix: "add tls=true to the URL, or pass --allow-insecure for a network you trust",
  };
}

/** A connector `open` handed out; `closed` says whether whoever opened it let go of it. */
export class FakeOpenConnector extends FakeConnector implements OpenConnector {
  closed = false;

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/**
 * A database engine for the CLI's tests: its plans come from the test's fixtures, its runs are
 * recorded, and `open` hands out fake connectors over one `FakeDatabase`. A plan the test gave no
 * fixture for rejects, so a command that plans what the test did not expect fails loudly; so does a
 * fixture that plans the store while the store is not shared, which no engine may do. Like a real
 * engine, it refuses a plaintext URL to another host unless `allowInsecure` (`checkUrl` says so
 * without connecting, `open` throws it as an `EngineRefusal`), a run never keeps the worker
 * password, and a run stops at a `secret` statement when given none.
 */
export class FakeEngine implements DatabaseEngine {
  readonly name: string;
  readonly schemes: readonly string[];
  readonly capabilities: Capabilities;
  readonly checks: DatabaseEngine["checks"];
  readonly keyText?: KeyText;
  readonly keyTextOf?: NonNullable<DatabaseEngine["keyTextOf"]>;
  readonly login?: NonNullable<DatabaseEngine["login"]>;
  readonly inspect?: NonNullable<DatabaseEngine["inspect"]>;
  /** With `inspect` and a database: the database's newest rows. */
  readonly readRows?: NonNullable<DatabaseEngine["readRows"]>;
  readonly estimateRows?: NonNullable<DatabaseEngine["estimateRows"]>;
  /** The table each `inspect` asked about, `null` for none; the URL is never kept. */
  readonly inspected: (string | null)[] = [];
  readonly runs: FakeRun[] = [];
  readonly opened: FakeOpenConnector[] = [];
  readonly #label: (target: EngineTarget, url: string) => string;
  readonly #plans: FakePlans;
  readonly #runNotes: ((target: EngineTarget, plan: EnginePlan) => readonly string[]) | undefined;
  readonly #lastOfRun: (target: EngineTarget) => boolean;
  readonly #doctor: (target: EngineTarget) => readonly DoctorCheck[];
  readonly #database: FakeDatabase | undefined;
  #stop: (FakeStop & { readonly at: number }) | undefined;

  constructor(options: FakeEngineOptions = {}) {
    this.name = options.name ?? "fake";
    this.schemes = options.schemes ?? ["fake"];
    this.capabilities = options.capabilities ?? FAKE_CAPABILITIES;
    this.checks = options.checks ?? [];
    this.#label =
      options.label ??
      ((target) =>
        target.schema === undefined ? target.table : `${target.schema}.${target.table}`);
    this.#plans = options.plans ?? {};
    this.#runNotes = options.runNotes;
    this.#lastOfRun = options.lastOfRun ?? (() => true);
    this.#doctor = options.doctor ?? (() => []);
    this.#database = options.database;
    if (options.keyText !== undefined) {
      this.keyText = options.keyText;
    }
    const keyTextOf = options.keyTextOf;
    if (keyTextOf !== undefined) {
      // Like a real engine's, it refuses a plaintext URL to another host before reading anything.
      this.keyTextOf = (target, url, deps) => {
        const refused = this.checkUrl(target, url, deps);
        return refused === undefined
          ? Promise.resolve(keyTextOf(target, url))
          : Promise.reject(new EngineRefusal(refused));
      };
    }
    if (options.login !== undefined) {
      this.login = options.login;
    }
    const estimateRows = options.estimateRows;
    if (estimateRows !== undefined) {
      this.estimateRows = (target, url, deps) => {
        const refused = this.checkUrl(target, url, deps);
        return refused === undefined
          ? Promise.resolve(estimateRows(target))
          : Promise.reject(new EngineRefusal(refused));
      };
    }
    const inspect = options.inspect;
    const database = options.database;
    if (inspect !== undefined && database !== undefined) {
      // The newest rows of its database, as `scan` reads them, and its size as the estimate.
      this.readRows = async (_target, url, rowsOptions) => {
        const refused = plaintextRefusal(url, rowsOptions);
        if (refused !== undefined) {
          return { ok: false, refusal: refused };
        }
        const rows: ReadRow[] = [];
        let page = await new FakeConnector(database).scan(null);
        rows.push(...page.rows);
        while (rows.length < rowsOptions.limit && page.next !== null) {
          page = await new FakeConnector(database).scan(page.next);
          rows.push(...page.rows);
        }
        return {
          ok: true,
          rows: rows.slice(0, rowsOptions.limit),
          estimatedRows: database.rows.entries().length,
        };
      };
    }
    if (inspect !== undefined) {
      // Like a real engine's, it refuses a plaintext URL to another host before it connects.
      this.inspect = (url, inspectOptions) => {
        const refused = plaintextRefusal(url, inspectOptions);
        if (refused !== undefined) {
          return Promise.resolve({ ok: false, refusal: refused });
        }
        this.inspected.push(inspectOptions.table ?? null);
        return Promise.resolve(inspect(inspectOptions));
      };
    }
  }

  label(target: EngineTarget, url: string): string {
    return this.#label(target, url);
  }

  /** The next run stops at statement `at`, an index into its plan's statements. */
  stopNextRunAt(at: number, why: FakeStop): void {
    this.#stop = { at, ...why };
  }

  async planInstall(
    target: EngineTarget,
    url: string,
    options: InstallOptions,
  ): Promise<PlanResult> {
    return this.#plan("install", url, options, () =>
      this.#fixture("install", this.#plans.install)(target, options),
    );
  }

  async planUninstall(
    target: EngineTarget,
    url: string,
    options: UninstallOptions,
  ): Promise<PlanResult> {
    return this.#plan("uninstall", url, options, () =>
      this.#fixture("uninstall", this.#plans.uninstall)(target, options),
    );
  }

  async planPrune(target: EngineTarget, url: string, deps: EngineDeps): Promise<PlanResult> {
    return this.#plan("prune", url, deps, () => this.#fixture("prune", this.#plans.prune)(target));
  }

  /** A statement a line with its semicolon, between `begin;` and `commit;` when transactional. */
  render(plan: EnginePlan): string {
    if (plan.statements.length === 0) {
      return "";
    }
    const lines = plan.statements.map((statement) => `${statement.text};`);
    return `${(plan.transactional ? ["begin;", ...lines, "commit;"] : lines).join("\n")}\n`;
  }

  async run(
    target: EngineTarget,
    plan: EnginePlan,
    url: string,
    options: RunOptions,
  ): Promise<RunResult> {
    const stop = this.#stop;
    this.#stop = undefined;
    const source = target.source;
    const workerPassword = options.workerPassword !== undefined;
    const insecure = plaintextRefusal(url, options);
    if (insecure !== undefined) {
      this.runs.push({ source, url, statements: [], workerPassword });
      return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
    }
    const executed: PlanStatement[] = [];
    for (const [at, statement] of plan.statements.entries()) {
      executed.push(statement);
      const why: FakeStop | undefined =
        statement.secret === true && !workerPassword
          ? { refusal: NO_PASSWORD }
          : stop?.at === at
            ? stop
            : undefined;
      if (why !== undefined) {
        this.runs.push({ source, url, statements: executed, workerPassword });
        // A transaction rolls back whole; without one, what ran before the stop stays. Nothing
        // links an object to a statement, so a stopped run reports none removed.
        return {
          ran: plan.transactional ? [] : executed.slice(0, -1),
          stopped: { at, ...why },
          removed: [],
          notes: [],
        };
      }
    }
    this.runs.push({ source, url, statements: executed, workerPassword });
    const notes = this.#runNotes?.(target, plan) ?? plan.notes;
    // The run's shared objects go with the last table's run, once nothing needs them.
    const removed = this.#lastOfRun(target)
      ? plan.removes
      : plan.removes.filter((object) => object.scope === "source");
    return { ran: executed, removed, notes };
  }

  checkUrl(
    _target: EngineTarget,
    url: string,
    deps: Pick<EngineDeps, "allowInsecure">,
  ): Refusal | undefined {
    return plaintextRefusal(url, deps);
  }

  async open(target: EngineTarget, url: string, options: OpenOptions): Promise<OpenConnector> {
    const insecure = this.checkUrl(target, url, options);
    if (insecure !== undefined) {
      throw new EngineRefusal(insecure);
    }
    if (this.#database === undefined) {
      throw new Error(`the fake engine "${this.name}" has no database to open: pass one`);
    }
    const connector = new FakeOpenConnector(this.#database);
    this.opened.push(connector);
    return connector;
  }

  async doctor(
    target: EngineTarget,
    url: string,
    deps: EngineDeps,
  ): Promise<readonly DoctorCheck[]> {
    const insecure = plaintextRefusal(url, deps);
    if (insecure !== undefined) {
      return [{ name: "connection", status: "fail", detail: insecure.message, fix: insecure.fix }];
    }
    return this.#doctor(target);
  }

  /** A plan from its fixture, after the refusal a real engine gives before it connects. */
  #plan(
    operation: keyof FakePlans,
    url: string,
    deps: EngineDeps,
    make: () => PlanResult,
  ): PlanResult {
    const insecure = plaintextRefusal(url, deps);
    if (insecure !== undefined) {
      return { ok: false, refusal: insecure };
    }
    const result = make();
    if (result.ok && !deps.storeShared) {
      const { statements, removes, keeps } = result.plan;
      const store = (kind: string) => kind === "log" || kind === "store-table";
      if (
        statements.some((statement) => statement.database === "store") ||
        [...removes, ...keeps].some((object) => store(object.kind))
      ) {
        throw new Error(
          `the fake engine's ${operation} fixture plans the store, which no engine does unless storeShared`,
        );
      }
    }
    return result;
  }

  #fixture<F>(operation: keyof FakePlans, fixture: F | undefined): F {
    if (fixture === undefined) {
      throw new Error(
        `the fake engine "${this.name}" has no ${operation} plan: pass plans.${operation}`,
      );
    }
    return fixture;
  }
}
