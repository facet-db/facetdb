import {
  type Capabilities,
  type DatabaseEngine,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  type Refusal,
} from "@facetdb/core";
import { createPostgresConnector } from "../capture/index.ts";
import {
  draftInstall,
  draftPrune,
  draftUninstall,
  type MigrateSource,
  WORKER_ROLE,
} from "../install/index.ts";
import { connectPostgres, quoteIdent, type SqlClient, type SqlConnect } from "../sql/index.ts";
import { STORE_VERSION_TABLE } from "../store/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";
import { installPlan, prunePlan, refusedPlan, uninstallPlan } from "./plans.ts";
import { runPlan } from "./run.ts";
import { adminUrlRefusal, subjectOf, workerUrlRefusal } from "./urls.ts";

/**
 * The Postgres engine: the first `DatabaseEngine`, over today's migrate, uninstall, prune, capture
 * connector and doctor, without a byte of their SQL or a word of the CLI's changed
 * (install.listings.sql and install.listings.side-table.sql are the proof). The CLI calls it and
 * nothing else; the old exports stay `@deprecated`, run by this package's own tests (they prove the
 * drafts beneath both are one).
 *
 * Statements are tagged by the table they serve: the `facetdb` schema, `facetdb.jobs`,
 * `facetdb.projects`, `facetdb.table_owners` and the worker's grants on them are `source` whatever
 * the store; the store's other tables, their migration rows and the worker's grants on them are
 * `store`, planned only with `storeShared` (today's one script, byte for byte). An uninstall's log
 * purge is `store` too; its source-side checks (the guard and the re-check on `table_owners`) are
 * `source`. A plan runs as one transaction, as today.
 *
 * Where each field of today's results lives in a plan (the CLI's words, `uninstall-words.ts`, are
 * rebuilt from these; `T` is the table as `schema.table`, `G` the source's name, objects are
 * written kind:name, `scope` source unless marked run):
 *
 * | old field | new place |
 * |---|---|
 * | `UninstallPlan.mode` | `confirm.kind`: `project` for a table, `source` for a log-only purge |
 * | `confirmName` | `confirm.name` |
 * | `schema`, `table` | the target; the `of` of the table's objects (`T`) |
 * | `projectId` | `of` of the run's `marker:facetdb.projects` remove; inside the shared tables' keep reason |
 * | `purge` | the caller's own option; the plan's log removes say what it deletes |
 * | `tableRemoval.columns` | removes `column:<name>` of `T`, in table order |
 * | `tableRemoval.sideTable` | remove `side-table:facetdb.<table>_answers` of `T` |
 * | `tableRemoval.view` | remove `view:<schema>.<table>_with_answers` of `T` |
 * | `tableRemoval.trigger` | remove `trigger:facetdb_<table>` of `T` |
 * | `tableRemoval.policies` | removes `policy:<name>` of `T` |
 * | (its queued jobs) | remove `jobs-table:facetdb.jobs` of `T`, on every table uninstall |
 * | `tableRemoval.workerGrants` | remove `grant:facetdb_worker` of `T` |
 * | `tableRemoval.schemaUsage` | this script's revoke; the run's are `schemaUsageRevoked` below |
 * | `log` found, with `purge` | removes `log:facetdb.decisions` and `log:facetdb.question_set_versions` of `G`, `count` decisions and versions (storeShared only) |
 * | `log` found with rows, no `purge`, `logOnlyPurge` set | keeps of the same two, reason "run \`<command>\` later to delete it" |
 * | `log` found with rows, no `purge`, `logOnlyPurge` unset; `otherTables` | keeps of the same two, reason "which <otherTables> may share: run \`facetdb uninstall --purge --source G\` once no other table is installed to delete it" |
 * | `log` otherwise, no `purge` | keeps `log:facetdb.decisions` and `log:facetdb.question_set_versions`, no `of`, reason "only --purge deletes a log" |
 * | `otherSourceLogs` | keeps `log:facetdb.decisions` of each source, `count` its decisions, reason "another source of project P: run \`…\` if it was this table's under an earlier name" |
 * | `logTablesDropped` false with `purge`, `log.status`, `log.logged`, `log.found` | keeps of the two log tables, reason "which other sources or the FacetDB store still use" or "no decisions were ever logged for source G"; or keep `log:facetdb.decisions` of `G`, `count` logged, reason "no source named "G" belongs to this table's project, so none of it is deleted (sources found: …)" |
 * | `leftInPlace` | keeps `side-table:<name>`, reason "see the note above" |
 * | `schemaUsageRevoked` | run removes `grant:facetdb_worker` of each schema |
 * | `projectKeptBy` empty, `sharedTablesDropped` false | run remove `marker:facetdb.projects` of the project, reason "nothing of it remains" |
 * | `queueFunctionsDropped` | run removes `function:facetdb.<name>` of the enqueue functions there, reason "no trigger uses them any more" |
 * | `jobsTableDropped` | run remove `jobs-table:facetdb.jobs` (words: the jobs table and the marks) |
 * | `markerTablesDropped` | run remove `marker:facetdb.table_owners` |
 * | `sharedTablesDropped` | run removes `store-table:facetdb.<name>` of each shared table, reason "no project remains" (storeShared; else `marker:facetdb.projects`) |
 * | `logTablesDropped` | run removes of the two log tables, reason "now empty" (storeShared only) |
 * | `schemaDropped` | run remove `schema:facetdb`, reason "now empty" |
 * | `sharedTablesDropped` false: `projectKeptBy`, `otherTables`, `otherProjects`, `pendingDeliveries`, `pendingElsewhere`, `unfinishedCursors` | run keeps `store-table:facetdb.<name>` (storeShared; else `marker:facetdb.projects`), reason the words after "because" ("project P still has usage and worker heartbeats", "public.orders is still installed", "project proj_b remains", …) |
 * | `markerTablesDropped` with `queueTriggers` | run keeps `jobs-table:facetdb.jobs` and `function:facetdb.<name>`, reason "a trigger on <tables> still uses them" |
 * | `markerTablesDropped` with `queuedElsewhere` | run keep `jobs-table:facetdb.jobs`, `count` queuedElsewhere, reason "it holds N queued jobs of other tables" |
 * | (the logins) | run keeps `login:facetdb_worker` and `login:facetdb_enqueue`, reason "uninstall never drops them: every project on the server may share them" |
 * | `UninstallResult.notes`, `pendingDeliveries`, `unfinishedCursors` alone | `notes` (the run's: `RunResult.notes`, `will delete` → `deleted`) |
 * | `UninstallResult.sql`, `statements` | `render(plan)`, `statements` |
 * | `UninstallResult.applied` | `RunResult` (`ran`, `stopped`, `removed`) |
 * | `PruneResult.dropped` | removes `column:<name>` of `T`, reason the connector's |
 * | `PruneResult.revoked`, `foreignGrants` | removes `grant:facetdb_worker` of the column, reason "read no longer lists it" or "a grant by <roles> remains, see note" |
 * | `PruneResult.kept` | keeps `column:<name>` of `T`, reason "storeProbabilities is off" |
 * | `PruneResult.notes` | `notes` |
 * | `MigrateResult.notes` | `notes` (storeShared only: the store's) |
 * | `MigrateResult.workerPasswordApplied` | a `secret` statement in the plan |
 * | `MigrateResult.key`, `changed` | not in a plan: `open` reads the key; nothing prints `changed` |
 */

export type PostgresEngineOptions = {
  /** The driver: postgres.js in production, PGlite or a fake in a test, through the same parameter. */
  readonly connect: SqlConnect;
  /**
   * The environment's `PGHOST`, where the driver goes for a URL that names no host: the TLS rule
   * reads it (`requireTls`). A required key, so no caller forgets it: the composition root passes
   * `env.PGHOST` (undefined when unset), and without it a hostless admin URL with a remote `PGHOST`
   * would pass the TLS refusal. `undefined` takes such a URL as this machine's.
   */
  readonly pgHost: string | undefined;
};

/** What Postgres can do, as the capture connector declares it (the default driver can LISTEN). */
const CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: true,
  transactions: true,
  sideTable: true,
  multipleWorkers: true,
};

/** A plan with nothing to do: a prune of a source not installed yet. */
const NOTHING: EnginePlan = {
  statements: [],
  transactional: true,
  removes: [],
  keeps: [],
  notes: [],
};

const ROLE_EXISTS = "select 1 from pg_catalog.pg_roles where rolname = $1";

/** A FacetDB store lives in this database: its version table, which a source-only install never makes. */
const STORE_LEFT_HERE = `select to_regclass('facetdb.${STORE_VERSION_TABLE}') is not null as present`;

/**
 * Why an uninstall with the store elsewhere stops at a store left in the source's database. The
 * fix holds when DATABASE_URL already names this database by another address (a Supabase pooler
 * host against the direct one): the CLI tells one database by host, port and name as written, so
 * the two are aligned, and until they are the uninstall stays refused rather than sweep a store it
 * cannot tell from another project's.
 */
const STORE_LEFT_BEHIND: Refusal = {
  code: "store-left-behind",
  message: `this database still holds a FacetDB store (facetdb.${STORE_VERSION_TABLE} and the tables beside it) from when DATABASE_URL named it, and with the store now elsewhere this uninstall would drop those tables without naming them; nothing was changed`,
  fix: "run facetdb uninstall with DATABASE_URL naming this database by the same host, port and database name as the source's connection string: it then removes the source's install and that store together, and names everything it drops. A pooler's host and the direct host (Supabase's) reach one database but read as two, so write both the same way; until they match, the uninstall stays refused rather than drop a store that may be another project's",
};

/** The table's single-column primary key as the catalog reports it to the worker login. */
const PRIMARY_KEY_QUERY = `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indrelid = to_regclass($1) and i.indisprimary`;

/** The plan as one script, exactly as `renderSql` printed it: one transaction, `;` and a blank line between. */
function render(plan: EnginePlan): string {
  if (plan.statements.length === 0) {
    return "";
  }
  const body = plan.statements.map((statement) => statement.text).join(";\n\n");
  return plan.transactional ? `begin;\n\n${body};\n\ncommit;\n` : `${body};\n`;
}

/** The target as `draftInstall` and `draftPrune` take it; the schema is `public` when absent. */
function tableOf(target: EngineTarget): { readonly table: string; readonly schema?: string } {
  return { table: target.table, ...(target.schema === undefined ? {} : { schema: target.schema }) };
}

export function createPostgresEngine(options: PostgresEngineOptions): DatabaseEngine {
  const { connect, pgHost } = options;

  /** Plans with the admin URL: opened for the call, closed whatever happens, kept nowhere. */
  async function withAdmin<T>(url: string, work: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = connect(url);
    try {
      return await work(client);
    } finally {
      await client.close();
    }
  }

  /** The key `open` keys the connector by: the target's, or the catalog's single-column one. */
  async function primaryKey(
    url: string,
    schema: string,
    table: string,
  ): Promise<{ readonly name: string; readonly type?: string }> {
    const client = connect(url);
    try {
      const rows = await client.query(PRIMARY_KEY_QUERY, [
        `${quoteIdent(schema)}.${quoteIdent(table)}`,
      ]);
      const [row] = rows;
      if (row === undefined || rows.length > 1) {
        throw new EngineRefusal({
          code: "primary-key",
          message: `${schema}.${table} needs a single-column primary key, and ${rows.length === 0 ? "has none, or does not exist" : "has a composite one"}`,
          fix: "run facetdb migrate first; a table needs a primary key (or a surrogate key), FacetDB keys its answers by it",
        });
      }
      return { name: String(row["name"]), type: String(row["type"]) };
    } finally {
      await client.close();
    }
  }

  return {
    name: "postgres",
    schemes: ["postgres", "postgresql"],
    capabilities: CAPABILITIES,
    checks: DOCTOR_CHECKS,

    async planInstall(target, url, installOptions) {
      const insecure = adminUrlRefusal(url, installOptions.allowInsecure, pgHost);
      if (insecure !== undefined) {
        return { ok: false, refusal: insecure };
      }
      return withAdmin(url, async ({ query }) => {
        // An existing login keeps its password: other projects on the server may share it.
        const exists = (await query(ROLE_EXISTS, [WORKER_ROLE])).length > 0;
        if (!exists && installOptions.workerPassword === undefined) {
          // The contract's code, before anything is drafted, as the CLI refused before printing
          //: the CLI words it from the source's connection string.
          return {
            ok: false,
            refusal: {
              code: "worker-login",
              message: `the worker login ${WORKER_ROLE} does not exist yet, and no password was given to create it with`,
              fix: `put the worker login and a long random password in ${subjectOf(target)}: postgres://${WORKER_ROLE}:<a long random password>@<host>/<database>; the install creates the login with that password`,
            },
          };
        }
        const source: MigrateSource = {
          ...tableOf(target),
          ...(target.key === undefined ? {} : { key: target.key }),
          onChange: target.onChange,
          storage: target.storage,
        };
        const draft = await draftInstall(query, {
          source,
          questionSet: target.questionSet,
          project: target.project,
          ...(exists || installOptions.workerPassword === undefined
            ? {}
            : { workerPassword: installOptions.workerPassword }),
        });
        return draft.ok
          ? { ok: true, plan: installPlan(draft, installOptions.storeShared) }
          : refusedPlan("migrate-refused", draft.reason);
      });
    },

    async planUninstall(target, url, uninstallOptions) {
      const insecure = adminUrlRefusal(url, uninstallOptions.allowInsecure, pgHost);
      if (insecure !== undefined) {
        return { ok: false, refusal: insecure };
      }
      return withAdmin(url, async ({ query }) => {
        const draft = await draftUninstall(query, {
          source: { ...tableOf(target), name: target.source, projectId: target.project.id },
          purge: uninstallOptions.purge,
          alsoUninstalling: uninstallOptions.alsoUninstalling.map((other) => ({
            schema: other.schema ?? "public",
            table: other.table,
          })),
          store: uninstallOptions.storeShared,
        });
        if (!draft.ok) {
          return refusedPlan("uninstall-refused", draft.reason);
        }
        // With the store elsewhere the sweep is the source's, and it would drop a store an earlier
        // DATABASE_URL left in this database without naming one table of it: refuse.
        if (
          !uninstallOptions.storeShared &&
          draft.plan.sharedTablesDropped &&
          (await query(STORE_LEFT_HERE))[0]?.["present"] === true
        ) {
          return { ok: false, refusal: STORE_LEFT_BEHIND };
        }
        return { ok: true, plan: uninstallPlan(draft, uninstallOptions.storeShared) };
      });
    },

    async planPrune(target, url, deps) {
      const insecure = adminUrlRefusal(url, deps.allowInsecure, pgHost);
      if (insecure !== undefined) {
        return { ok: false, refusal: insecure };
      }
      return withAdmin(url, async ({ query }) => {
        const draft = await draftPrune(query, {
          source: tableOf(target),
          questionSet: target.questionSet,
          project: target.project,
        });
        if (draft.ok) {
          return { ok: true, plan: prunePlan(draft) };
        }
        // A source not installed yet has nothing to prune: an empty plan, not a refusal.
        return draft.absent
          ? { ok: true, plan: NOTHING }
          : refusedPlan("prune-refused", draft.reason);
      });
    },

    render,

    run: (target, plan, url, runOptions) => runPlan(connect, pgHost, target, plan, url, runOptions),

    checkUrl: (target, url, deps) =>
      workerUrlRefusal(url, deps.allowInsecure, pgHost, subjectOf(target)),

    async open(target, url, openOptions): Promise<OpenConnector> {
      const insecure = workerUrlRefusal(url, openOptions.allowInsecure, pgHost, subjectOf(target));
      if (insecure !== undefined) {
        throw new EngineRefusal(insecure);
      }
      const schema = target.schema ?? "public";
      // The worker login reads the key from pg_catalog; the CLI reads no catalog.
      const key =
        target.key === undefined
          ? await primaryKey(url, schema, target.table)
          : { name: target.key };
      const max = openOptions.maxConnections;
      return createPostgresConnector({
        workerUrl: url,
        source: {
          table: target.table,
          schema,
          key: key.name,
          ...(key.type === undefined ? {} : { keyType: key.type }),
          onChange: target.onChange,
          storage: target.storage,
        },
        questionSet: target.questionSet,
        clock: openOptions.clock,
        ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
        connect: max === undefined ? connect : (workerUrl) => connect(workerUrl, { max }),
      });
    },

    doctor: (target, url, deps) => doctorChecks(connect, pgHost, target, url, deps),
  };
}

/**
 * The engine over postgres.js with no `PGHOST`, for tools and tests that never read the
 * environment. The CLI's composition root does not use it: main.ts builds its own with
 * `createPostgresEngine({ connect, pgHost: env.PGHOST })`, so a hostless URL is judged where the
 * driver really goes.
 */
export const postgresEngine: DatabaseEngine = createPostgresEngine({
  connect: connectPostgres,
  pgHost: undefined,
});
