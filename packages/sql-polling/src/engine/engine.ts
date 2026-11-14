import {
  type DatabaseEngine,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  type PlanResult,
  type Refusal,
} from "@facetdb/core";
import { createPollingConnector, POLLING_CAPABILITIES } from "../connector/index.ts";
import type { PollingConnect, PollingQuery, SqlDialect } from "../dialect/index.ts";
import { labelOf, type PollingTable, readTable, tableOf } from "../install/index.ts";
import { doctorChecks, doctorChecksOf } from "./doctor.ts";
import {
  anotherProject,
  installPlan,
  keyProblem,
  logOnlyPlan,
  missingTable,
  prunePlan,
  refusedPlan,
  triggerInstall,
  uninstallPlan,
  unreadColumn,
} from "./plans.ts";
import { runPlan } from "./run.ts";
import { adminUrlRefusal, subjectOf, workerUrlRefusal } from "./urls.ts";

/**
 * The polling engine: a `DatabaseEngine` for any SQL database through its dialect, and for a
 * Postgres host that forbids triggers (`connector: "polling"`). It plans the answer and status
 * columns, `facetdb_state_hash`, the table's project mark, and the worker login with its grants
 * where the dialect has logins; no trigger and no jobs table. Its plans hold `source` statements
 * only, whatever `storeShared` says: the store is always a Postgres and this engine is every SQL
 * database's, so the CLI's store door runs the store's part for a polling source. `open` hands out
 * the polling connector, with the column it polls by found in the catalog.
 */

export type PollingEngineOptions = {
  /**
   * Where the connector's warning goes when a table has no column to poll by; the composition root
   * passes its logger.
   */
  readonly warn: (message: string) => void;
};

/** A plan with nothing to do: a prune of a source not installed yet. */
function nothing(dialect: SqlDialect): EnginePlan {
  return {
    statements: [],
    transactional: dialect.transactionalDdl,
    removes: [],
    keeps: [],
    notes: [],
  };
}

/** The polling connector keeps the answers in the table's own columns (`sideTable: false`). */
function sideTableRefusal(target: EngineTarget): Refusal | undefined {
  return target.storage === "side-table"
    ? {
        code: "polling-side-table",
        message: `the source "${target.source}" asks for side-table mode, and the polling connector keeps the answers in the table's own columns`,
        fix: 'use storage: "inline" for a source watched by polling, or watch it with the trigger (without connector: "polling")',
      }
    : undefined;
}

export function pollingEngine(
  dialect: SqlDialect,
  connect: PollingConnect,
  options: PollingEngineOptions,
): DatabaseEngine {
  /** Plans with the admin URL: opened for the call, closed whatever happens, kept nowhere. */
  async function withAdmin<T>(url: string, work: (query: PollingQuery) => Promise<T>): Promise<T> {
    const client = connect(url);
    try {
      return await work(client.query);
    } finally {
      await client.close();
    }
  }

  /** The worker login as the plan sees it: its rule, and whether it exists already. */
  async function loginOf(query: PollingQuery) {
    const rule = dialect.login;
    return rule === undefined ? undefined : { rule, exists: await rule.exists(query) };
  }

  /** Why a plan cannot touch the table: a trigger install's, or another project's. */
  function claimed(
    found: PollingTable,
    target: EngineTarget,
    code: string,
  ): PlanResult | undefined {
    const label = labelOf(found.table);
    if (found.facts.triggers.length > 0) {
      return refusedPlan(code, triggerInstall(label, found.facts.triggers));
    }
    return found.project !== undefined && found.project !== target.project.id
      ? refusedPlan(code, anotherProject(label, found.project))
      : undefined;
  }

  return {
    name: "polling",
    schemes: dialect.schemes,
    capabilities: POLLING_CAPABILITIES,
    checks: doctorChecksOf(dialect),

    async planInstall(target, url, installOptions) {
      const refused =
        adminUrlRefusal(dialect, url, installOptions.allowInsecure) ?? sideTableRefusal(target);
      if (refused !== undefined) {
        return { ok: false, refusal: refused };
      }
      return withAdmin(url, async (query) => {
        const found = await readTable(dialect, query, target);
        if (found === undefined) {
          return refusedPlan(
            "migrate-refused",
            missingTable(labelOf(tableOf(dialect, target)), "install"),
          );
        }
        const label = labelOf(found.table);
        const key = target.key ?? found.key;
        if (key === undefined) {
          return refusedPlan("migrate-refused", `${keyProblem(label, found.facts.key)}.`);
        }
        if (found.collisions.length > 0) {
          return refusedPlan(
            "migrate-refused",
            `${label} already has ${found.collisions.map((name) => `"${name}"`).join(", ")}, which FacetDB did not create; rename the question or the column.`,
          );
        }
        const taken = claimed(found, target, "migrate-refused");
        if (taken !== undefined) {
          return taken;
        }
        const login = await loginOf(query);
        if (login !== undefined && !login.exists && installOptions.workerPassword === undefined) {
          // The contract's code, before anything is drafted: the CLI words it from the source's
          // connection string.
          return {
            ok: false,
            refusal: {
              code: "worker-login",
              message: `the worker login ${login.rule.name} does not exist yet, and no password was given to create it with`,
              fix: `put the worker login and a long random password in ${subjectOf(target)}: ${login.rule.urlShape}; the install creates the login with that password`,
            },
          };
        }
        return { ok: true, plan: installPlan(dialect, target, found, key, login) };
      });
    },

    async planUninstall(target, url, uninstallOptions) {
      const refused = adminUrlRefusal(dialect, url, uninstallOptions.allowInsecure);
      if (refused !== undefined) {
        return { ok: false, refusal: refused };
      }
      return withAdmin(url, async (query) => {
        const found = await readTable(dialect, query, target);
        const label = labelOf(tableOf(dialect, target));
        if (found !== undefined) {
          const taken = claimed(found, target, "uninstall-refused");
          if (taken !== undefined) {
            return taken;
          }
        }
        if (found?.installed !== true) {
          // No polling install left: `--purge` deletes the log alone (the store door's), and the
          // source's name is typed back; without it there is nothing to do, said as the trigger
          // engine says it.
          if (uninstallOptions.purge && (found === undefined || found.owned.length === 0)) {
            return { ok: true, plan: logOnlyPlan(dialect, target) };
          }
          return refusedPlan(
            "uninstall-refused",
            found === undefined
              ? missingTable(label, "remove")
              : `FacetDB is not installed on ${label} in polling mode (it has no facetdb_state_hash of FacetDB's); run migrate first, or check the source's schema and table.`,
          );
        }
        return { ok: true, plan: uninstallPlan(dialect, target, found, await loginOf(query)) };
      });
    },

    async planPrune(target, url, deps) {
      const refused = adminUrlRefusal(dialect, url, deps.allowInsecure);
      if (refused !== undefined) {
        return { ok: false, refusal: refused };
      }
      return withAdmin(url, async (query) => {
        const found = await readTable(dialect, query, target);
        if (found === undefined) {
          return { ok: true, plan: nothing(dialect) };
        }
        const taken = claimed(found, target, "prune-refused");
        if (taken !== undefined) {
          return taken;
        }
        // A source not installed yet has nothing to prune: an empty plan, not a refusal.
        if (!found.installed) {
          return { ok: true, plan: nothing(dialect) };
        }
        const key = target.key ?? found.key;
        if (key === undefined) {
          return refusedPlan(
            "prune-refused",
            `${labelOf(found.table)} no longer has a single-column primary key, which FacetDB installed by; restore it first.`,
          );
        }
        return { ok: true, plan: prunePlan(dialect, target, found, key, await loginOf(query)) };
      });
    },

    render(plan) {
      if (plan.statements.length === 0) {
        return "";
      }
      const body = plan.statements.map((statement) => statement.text).join(";\n\n");
      return plan.transactional ? `begin;\n\n${body};\n\ncommit;\n` : `${body};\n`;
    },

    run: (target, plan, url, runOptions) =>
      runPlan(dialect, connect, target, plan, url, runOptions),

    checkUrl: (target, url, deps) =>
      workerUrlRefusal(dialect, url, deps.allowInsecure, subjectOf(target)) ??
      sideTableRefusal(target),

    async open(target, url, openOptions): Promise<OpenConnector> {
      const refused =
        workerUrlRefusal(dialect, url, openOptions.allowInsecure, subjectOf(target)) ??
        sideTableRefusal(target);
      if (refused !== undefined) {
        throw new EngineRefusal(refused);
      }
      const max = openOptions.maxConnections;
      const client = max === undefined ? connect(url) : connect(url, { max });
      try {
        // The worker login reads the key and the column to poll by from the catalog; the CLI reads
        // no catalog.
        const found = await readTable(dialect, client.query, target);
        const key = target.key ?? found?.key;
        if (found === undefined || key === undefined) {
          const label = labelOf(tableOf(dialect, target));
          throw new EngineRefusal({
            code: "primary-key",
            message:
              found === undefined
                ? `${label} needs a single-column primary key, and has none, or does not exist`
                : keyProblem(label, found.facts.key),
            fix: "run facetdb migrate first; a table needs a primary key (or a surrogate key), FacetDB keys its answers by it",
          });
        }
        const column = found.lastChanged.column;
        // A column the application added after the install: the worker's first poll would fail on
        // it, so it is refused now, with the command that grants the read.
        const unread = unreadColumn(found);
        if (unread !== undefined) {
          throw new EngineRefusal(unread);
        }
        return createPollingConnector(
          dialect,
          client,
          { ...target, key },
          {
            ...(column === undefined ? {} : { lastChangedColumn: column }),
            clock: openOptions.clock,
            warn: options.warn,
          },
        );
      } catch (error) {
        await client.close();
        throw error;
      }
    },

    doctor: (target, url, deps) => doctorChecks(dialect, connect, target, url, deps),
  };
}
