import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  KeptObject,
  PlanResult,
  PlanStatement,
  Refusal,
} from "@facetdb/core";
import { POLL_INTERVAL_MS } from "../connector/index.ts";
import type { LoginRule, SqlDialect } from "../dialect/index.ts";
import {
  droppedColumns,
  grantStatements,
  installStatements,
  KEPT_REASON,
  keptColumns,
  type LastChanged,
  labelOf,
  loginStatements,
  ownedColumnNames,
  type PollingTable,
  pruneStatements,
  revokedColumns,
  type Statement,
  uninstallStatements,
  withHeader,
} from "../install/index.ts";

/**
 * A polling source's install, uninstall and prune as the engine contract's plans, from the table as
 * the catalog shows it: every statement as printed and run, all of them the source's (the store is
 * the CLI's store door's), and what goes and what stays as typed objects carrying the words the CLI
 * prints. The refusals and the reasons are the Postgres trigger engine's words where the two modes
 * meet the same thing, so a table says one thing whichever mode watches it.
 */

/** The fix of every refusal of a plan, as the trigger engine words it. */
export const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/** A refusal with the trigger engine's code (`migrate-refused`, `uninstall-refused`, `prune-refused`). */
export function refusedPlan(code: string, message: string): PlanResult {
  return { ok: false, refusal: { code, message, fix: REFUSED_FIX } };
}

/** The table another project marked, in the trigger install's words. */
export function anotherProject(table: string, owner: string): string {
  return `${table} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/** A table FacetDB's trigger watches: a trigger install, which polling neither makes nor removes. */
export function triggerInstall(table: string, triggers: readonly string[]): string {
  return `${table} is watched by FacetDB's trigger (${triggers.join(", ")}), a trigger install that the polling connector does not manage; run facetdb uninstall for it without connector: "polling" first, or watch it with the trigger.`;
}

/** The table a plan needs and the catalog does not show. */
export function missingTable(table: string, what: "install" | "remove"): string {
  return what === "install"
    ? `${table} does not exist; FacetDB adds columns to a table, it does not create one.`
    : `${table} does not exist; there is nothing of FacetDB's on it to remove.`;
}

/** Why a table without a single-column key cannot be installed, read or written. */
export function keyProblem(table: string, key: readonly string[]): string {
  return `${table} needs a single-column primary key, and ${key.length === 0 ? "has none" : `has a composite one (${key.join(", ")})`}; FacetDB keys its answers by it`;
}

/** The polling installs FacetDB made before it marked a table's project. */
function unmarkedNote(table: string, projectId: string, then: "marks" | "uninstalls"): string {
  return then === "marks"
    ? `${table} was installed in polling mode before FacetDB marked a table's project; this migrate marks it as project ${projectId}'s, so facetdb uninstall and migrate --prune find it`
    : `${table} carries no project mark (a polling install from before FacetDB marked one), so it is uninstalled as project ${projectId}'s`;
}

/** How the worker reads the table, by its column or by the hourly full scan, said in the config's terms when it chose. */
function pollingWay(table: string, lastChanged: LastChanged): string {
  if (lastChanged.column !== undefined) {
    const named = lastChanged.named === true ? ", the column lastChanged names" : "";
    return `FacetDB polls ${table} every ${POLL_INTERVAL_MS / 1000} seconds by ${lastChanged.column}${named}`;
  }
  const chosen = lastChanged.chosen === true ? ", as lastChanged: false says" : "";
  return `FacetDB reads ${table} whole every hour${chosen}`;
}

/** How often the worker reads the table, by the column it polls by or by the hourly full scan. */
export function pollingWords(table: string, lastChanged: LastChanged): string {
  return `${pollingWay(table, lastChanged)}; no trigger`;
}

/**
 * Why the worker falls back to the hourly full scan ("without one, a full scan every hour, with a
 * warning"), and how to get the 10-second poll; undefined with a column, and when the config chose
 * the scan (`lastChanged: false`): nothing to warn of then.
 */
export function hourlyScan(
  table: string,
  lastChanged: LastChanged,
): { readonly detail: string; readonly fix: string } | undefined {
  if (lastChanged.column !== undefined || lastChanged.chosen === true) {
    return undefined;
  }
  const seconds = POLL_INTERVAL_MS / 1000;
  return lastChanged.nullable === undefined
    ? {
        detail: `${table} has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour`,
        fix: `give ${table} an updated_at, NOT NULL, that the application sets on every insert and every update; FacetDB then polls it every ${seconds} seconds`,
      }
    : {
        detail: `${table}'s ${lastChanged.nullable} may be NULL, and a row whose ${lastChanged.nullable} is NULL would never be read again, so FacetDB does not poll by it and reads the whole table every hour`,
        fix: `make ${lastChanged.nullable} NOT NULL, and set it on every insert and every update; FacetDB then polls it every ${seconds} seconds`,
      };
}

/**
 * The column FacetDB polls by, when the connection's login (the worker's, in `open` and doctor)
 * may not read it, as the refusal that says so: a column the application added after the install.
 * Undefined when it may, or when there is no such column.
 */
export function unreadColumn(found: PollingTable): Refusal | undefined {
  const column = found.lastChanged.column;
  const facts = found.facts.columns.find((one) => one.name === column);
  return column === undefined || facts === undefined || facts.readable
    ? undefined
    : {
        code: "polling-read",
        message: `the worker login may not read ${column}, the column FacetDB polls ${labelOf(found.table)} by`,
        fix: "run facetdb migrate: it grants the worker its read of that column",
      };
}

/**
 * What the polling depends on when it has a column: the application keeps it current. Set on
 * insert only, it stops change detection silently, which no catalog read can tell; said at migrate.
 * When the config chose the hourly scan, what that costs and how to poll instead. Undefined for the
 * scan nothing chose: the hourly-scan warning says it then.
 */
function pollingNote(table: string, lastChanged: LastChanged): string | undefined {
  const way = pollingWay(table, lastChanged);
  if (lastChanged.column !== undefined) {
    return `${way}: the application must set ${lastChanged.column} on every insert and every update, or a change it makes is never noticed`;
  }
  return lastChanged.chosen === true
    ? `${way}, so a change is noticed within the hour; name in lastChanged a column holding a time, NOT NULL, that the application sets on every insert and every update, and FacetDB polls it every ${POLL_INTERVAL_MS / 1000} seconds`
    : undefined;
}

/**
 * Why the column the config's `lastChanged` names cannot be polled by, as a plan's refusal: the
 * table's catalog says so before any statement is planned.
 */
export function lastChangedRefused(found: PollingTable): PlanResult | undefined {
  const refusal = found.lastChangedRefusal;
  return refusal === undefined ? undefined : { ok: false, refusal };
}

/** Why the worker login stays after an uninstall, in the trigger engine's words for one login. */
const LOGIN_KEPT = "uninstall never drops it: every project on the server may share it";

/** Why the worker's use of the table's schema stays. */
const SCHEMA_KEPT = "another FacetDB table in the schema may still need it";

/**
 * The name of the marks' table under the `table` ownership (`Ownership`): what a dialect without
 * comments keeps them in.
 */
export const OWNERS_TABLE = "facetdb_table_owners";

/** A plan's statements: every one serves the source's own database. */
function sourceStatements(statements: readonly Statement[]): readonly PlanStatement[] {
  return statements.map((statement) => ({ database: "source", ...statement }));
}

/** Each name once, in first-seen order. */
function once(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/** What the worker may read and write: the key, the state and its own columns; its own columns. */
function workerColumns(
  target: EngineTarget,
  key: string,
  found: PollingTable,
): { readonly select: readonly string[]; readonly update: readonly string[] } {
  const owned = ownedColumnNames(target.questionSet);
  const changed = found.lastChanged.column;
  return {
    select: once([
      key,
      ...target.questionSet.read,
      ...owned,
      ...(changed === undefined ? [] : [changed]),
    ]),
    update: owned,
  };
}

/**
 * The install: the answer and status columns and the state hash, each marked; the table's project
 * mark; the worker login when it is missing; its grants. No trigger and no jobs table. Idempotent:
 * every statement changes nothing on an installed table.
 */
export function installPlan(
  dialect: SqlDialect,
  target: EngineTarget,
  found: PollingTable,
  key: string,
  login: { readonly rule: LoginRule; readonly exists: boolean } | undefined,
): EnginePlan {
  const { table } = found;
  const label = labelOf(table);
  const present = new Set(found.facts.columns.map((column) => column.name));
  const rights = workerColumns(target, key, found);
  const scan = hourlyScan(label, found.lastChanged);
  const kept = pollingNote(label, found.lastChanged);
  return {
    statements: sourceStatements(
      withHeader(dialect, table, [
        ...installStatements(dialect, table, target.questionSet, present, target.project.id),
        ...(login === undefined || login.exists ? [] : loginStatements(login.rule)),
        ...(login === undefined
          ? []
          : grantStatements(login.rule, table, rights.select, rights.update)),
      ]),
    ),
    transactional: dialect.transactionalDdl,
    removes: [],
    keeps: [],
    notes: [
      ...(found.installed && found.project === undefined
        ? [unmarkedNote(label, target.project.id, "marks")]
        : []),
      ...(kept === undefined ? [] : [kept]),
      ...(scan === undefined ? [] : [`${scan.detail}; ${scan.fix}`]),
      ...(login?.rule.grantsNote === undefined ? [] : [login.rule.grantsNote(label)]),
    ],
  };
}

/**
 * The uninstall: the worker's rights on the table, every column of FacetDB's and with them the mark
 * (the marks' rows too where the dialect keeps them in a table); the decision log is the store's.
 * The login stays, and the worker's use of the schema, each with why. The project's name is typed
 * back.
 */
export function uninstallPlan(
  dialect: SqlDialect,
  target: EngineTarget,
  found: PollingTable,
  login: { readonly rule: LoginRule; readonly exists: boolean } | undefined,
): EnginePlan {
  const { table } = found;
  const label = labelOf(table);
  const rights = login?.exists === true ? login.rule : undefined;
  const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
    kind,
    name,
    of: label,
    scope: "source",
  });
  return {
    statements: sourceStatements(
      withHeader(
        dialect,
        table,
        uninstallStatements(
          dialect,
          table,
          found.owned,
          rights === undefined ? undefined : { login: rights, policies: found.facts.policies },
        ),
      ),
    ),
    transactional: dialect.transactionalDdl,
    removes: [
      ...found.owned.map((name) => own("column", name)),
      ...(rights === undefined ? [] : found.facts.policies.map((name) => own("policy", name))),
      ...(rights === undefined ? [] : [own("grant", rights.name)]),
      ...(dialect.ownership.kind === "table" ? [own("marker", OWNERS_TABLE)] : []),
    ],
    keeps:
      rights === undefined
        ? []
        : [
            ...(rights.schemaUsage
              ? [
                  {
                    kind: "grant",
                    name: rights.name,
                    of: table.schema,
                    scope: "run",
                    reason: SCHEMA_KEPT,
                  } satisfies KeptObject,
                ]
              : []),
            { kind: "login", name: rights.name, scope: "run", reason: LOGIN_KEPT },
          ],
    notes:
      found.project === undefined ? [unmarkedNote(label, target.project.id, "uninstalls")] : [],
    confirm: { kind: "project", name: target.project.name },
  };
}

/**
 * `uninstall --purge` of a source whose table has no polling install left: nothing to run here, the
 * store door deletes the log, and the source's name is typed back (the trigger engine's log-only
 * purge).
 */
export function logOnlyPlan(dialect: SqlDialect, target: EngineTarget): EnginePlan {
  return {
    statements: [],
    transactional: dialect.transactionalDdl,
    removes: [],
    keeps: [],
    notes: [],
    confirm: { kind: "source", name: target.source },
  };
}

/**
 * `migrate --prune`: the columns of questions the set no longer has, each with why; the worker's
 * read of state fields `read` no longer lists; a choice's probabilities kept with why.
 */
export function prunePlan(
  dialect: SqlDialect,
  target: EngineTarget,
  found: PollingTable,
  key: string,
  login: { readonly rule: LoginRule; readonly exists: boolean } | undefined,
): EnginePlan {
  const { table } = found;
  const label = labelOf(table);
  const { questionSet } = target;
  const dropped = droppedColumns(found.owned, questionSet);
  const rights = login?.exists === true ? login.rule : undefined;
  // A dropped column's rights go with it: only the reads of columns that stay are taken back.
  const dropping = new Set(dropped.map((column) => column.column));
  const unread =
    rights === undefined
      ? []
      : revokedColumns(found.facts.workerSelect, {
          key,
          lastChanged: found.lastChanged.column,
          owned: found.owned,
          questionSet,
        }).filter((name) => !dropping.has(name));
  // A read is revoked only where the dialect can take one column back (column-level grants).
  const revoked =
    rights !== undefined && unread.length > 0 && rights.revokeSelect(table, unread).length > 0
      ? unread
      : [];
  return {
    statements: sourceStatements(
      withHeader(
        dialect,
        table,
        pruneStatements(
          dialect,
          table,
          dropped.map((column) => column.column),
          rights === undefined ? undefined : { login: rights, columns: revoked },
        ),
      ),
    ),
    transactional: dialect.transactionalDdl,
    removes: [
      ...dropped.map(
        ({ column, reason }): EngineObject => ({
          kind: "column",
          name: column,
          of: label,
          scope: "source",
          reason,
        }),
      ),
      ...(rights === undefined
        ? []
        : revoked.map(
            (column): EngineObject => ({
              kind: "grant",
              name: rights.name,
              of: column,
              scope: "source",
              reason: "read no longer lists it",
            }),
          )),
    ],
    keeps: keptColumns(found.owned, questionSet).map(
      (name): KeptObject => ({
        kind: "column",
        name,
        of: label,
        scope: "source",
        reason: KEPT_REASON,
      }),
    ),
    notes: [],
  };
}
