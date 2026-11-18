import type { EngineObject, KeptObject, ObjectKind } from "@facetdb/core";

/**
 * The words `facetdb uninstall` prints about what goes and what stays, each built from an object of
 * the engine's plan (its removes and keeps; the old field to new place table is the header of the
 * Postgres engine's engine.ts), never guessed here. A table's own words (its columns, trigger,
 * grants, its source's log) come from its plan's `source`-scoped objects; the run's words (the
 * project entry, the queue, the shared tables, the schema) from the `run`-scoped objects of the
 * run's last plan, which counts the run's other tables as gone (`alsoUninstalling`). An object's
 * reason is printed as the engine wrote it, after the separator its form takes: a log kept for a
 * later purge ": ", the "which … may share" and "another source of …" forms ", ", log tables "(…)"
 * or ", which …", an unresolved name "the decision log: …". Each mapping is a switch over every
 * `ObjectKind`, so a kind added to the contract does not compile until it has words here; an object
 * the phrases do not cover is said plainly by its kind and name, never left out. Every engine's
 * names are the plan's own: the queue and the marks as the engine spells them (`facetdb.jobs` on
 * Postgres, `facetdb_jobs` on SQLite), a login by the database's word for it where the plan gives
 * one (MongoDB's role and user), and SQL Server's Change Tracking where the plan turns it off. No
 * name of a FacetDB object is written here but the store's own tables, which are always the
 * Postgres store's.
 */

/** `1,240 decisions`, `1 decision`. */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** `a`, `a and b`, `a, b and c`. */
function inWords(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

const DECISIONS = "facetdb.decisions";
const VERSIONS = "facetdb.question_set_versions";
/**
 * The store's project register; with `of`, one project's entry in it. Every other marker is a
 * database's table-ownership marks, by whatever name its engine gives them.
 */
const PROJECTS = "facetdb.projects";

/** A log's size in words: `2 decisions, 1 question-set version`. */
export function logSize(decisions: number, versions: number): string {
  return `${counted(decisions, "decision", "decisions")}, ${counted(versions, "question-set version", "question-set versions")}`;
}

/** The phrase of a source's whole log, as a purge removes it or a plain uninstall keeps it. */
export function sourceLog(source: string, decisions: number, versions: number): string {
  return `the decision log of source ${source} (${logSize(decisions, versions)})`;
}

/** What each kind is called where the phrases do not word it. */
const NOUNS: Readonly<Record<ObjectKind, string>> = {
  column: "column",
  field: "field",
  "side-table": "side table",
  view: "view",
  trigger: "trigger",
  function: "function",
  "jobs-table": "jobs table",
  marker: "marker table",
  schema: "schema",
  login: "login",
  grant: "rights of the login",
  policy: "policy",
  index: "index",
  collection: "collection",
  log: "decision log table",
  "store-table": "FacetDB store table",
  "change-tracking": "Change Tracking",
};

/** What an object is called: the database's word where the plan gives one, else the kind's. */
const nounOf = (object: EngineObject) => object.noun ?? NOUNS[object.kind];

/**
 * An object no phrase covers, by its kind and name (`the index facetdb_jobs_due`), with what it is
 * on unless that is the table the words are already about. Change Tracking has no name of its own:
 * it is said by the table it is on.
 */
function plainly(object: EngineObject, within?: string): string {
  if (object.kind === "change-tracking") {
    return `Change Tracking on ${object.of ?? object.name}`;
  }
  const on = object.of === undefined || object.of === within ? "" : ` on ${object.of}`;
  return `the ${nounOf(object)} ${object.name}${on}`;
}

const ofKind = <T extends EngineObject>(objects: readonly T[], kind: EngineObject["kind"]) =>
  objects.filter((object) => object.kind === kind);

/** ` (why)`, or nothing when the plan gives no reason for what goes. */
const inParentheses = (reason: string | undefined) => (reason === undefined ? "" : ` (${reason})`);

/** `, why`, or nothing when the plan gives no reason for what goes. */
const afterComma = (reason: string | undefined) => (reason === undefined ? "" : `, ${reason}`);

/** Each source's entries in the log, in order: its decisions and, when given, its versions. */
function logEntries<T extends EngineObject>(
  objects: readonly T[],
): readonly { readonly source: string; readonly decisions: T; readonly versions?: T }[] {
  const entries: { source: string; decisions: T; versions?: T }[] = [];
  for (const object of ofKind(objects, "log")) {
    if (object.of === undefined) {
      continue;
    }
    const entry = entries.find((one) => one.source === object.of);
    if (object.name === DECISIONS) {
      if (entry === undefined) {
        entries.push({ source: object.of, decisions: object });
      } else {
        entry.decisions = object;
      }
    } else if (object.name === VERSIONS && entry !== undefined) {
      entry.versions = object;
    }
  }
  return entries;
}

/** The size of a source's log entries: decisions, and versions when the plan counts them. */
function entrySize(entry: {
  readonly decisions: EngineObject;
  readonly versions?: EngineObject;
}): string {
  const decisions = entry.decisions.count ?? 0;
  return entry.versions === undefined
    ? counted(decisions, "decision", "decisions")
    : logSize(decisions, entry.versions.count ?? 0);
}

/**
 * What a table's plan removes from the table, and from its source's log: the plan's own
 * (`source`-scoped) objects, in the order the phrases word them.
 */
export function tableRemoved(removes: readonly EngineObject[]): readonly string[] {
  const own = removes.filter((object) => object.scope === "source");
  const table = own.find((object) => object.kind !== "log")?.of;
  const columns: string[] = [];
  const fields: string[] = [];
  const sideTables: string[] = [];
  const views: string[] = [];
  const triggers: string[] = [];
  const policies: string[] = [];
  const others: string[] = [];
  const grants: string[] = [];
  let jobs = false;
  let mark = false;
  for (const object of own) {
    const { kind } = object;
    switch (kind) {
      case "column":
        columns.push(object.name);
        break;
      case "field":
        fields.push(object.name);
        break;
      case "side-table":
        sideTables.push(`the side table ${object.name}`);
        break;
      case "view":
        views.push(`the view ${object.name}`);
        break;
      case "trigger":
        triggers.push(`the trigger ${object.name}`);
        break;
      case "change-tracking":
        // SQL Server's capture where no trigger is: turned off, as FacetDB's install turned it on.
        triggers.push(
          `its Change Tracking (turned off${object.reason === undefined ? "" : `: ${object.reason}`})`,
        );
        break;
      case "policy":
        policies.push(object.name);
        break;
      case "jobs-table":
        // Its queued jobs: the table's part of the shared queue.
        jobs = true;
        break;
      case "marker":
        // Its mark: the table's part of the marks; the marks themselves are the run's.
        mark = true;
        break;
      case "grant":
        grants.push(`the ${object.name} login's rights on it`);
        break;
      case "function":
      case "schema":
      case "login":
      case "index":
      case "collection":
      case "store-table":
        others.push(plainly(object, table));
        break;
      case "log":
        // A source's entries in the log: their own phrase, after the table's.
        break;
      default:
        throw new Error(`no words for a removed ${kind satisfies never}`);
    }
  }
  const parts = [
    ...(columns.length === 0
      ? []
      : [
          `${counted(columns.length, "FacetDB column", "FacetDB columns")} (${columns.join(", ")})`,
        ]),
    ...(fields.length === 0
      ? []
      : [`${counted(fields.length, "FacetDB field", "FacetDB fields")} (${fields.join(", ")})`]),
    ...sideTables,
    ...views,
    ...triggers,
    ...(policies.length === 0
      ? []
      : [`${policies.length === 1 ? "the policy" : "the policies"} ${inWords(policies)}`]),
    ...others,
    ...(jobs ? ["its queued jobs"] : []),
    ...(mark ? ["its table-ownership mark"] : []),
    ...grants,
  ];
  return [
    ...(parts.length === 0
      ? []
      : [table === undefined ? inWords(parts) : `from ${table}: ${inWords(parts)}`]),
    ...logEntries(own).map(
      (entry) => `the decision log of source ${entry.source} (${entrySize(entry)})`,
    ),
  ];
}

/**
 * What the run removes besides its tables: the worker's use of a schema, the project's entry, the
 * enqueue functions, the queue and the marks, the shared tables, the emptied log tables and schema.
 * With the store in another database the project register (`facetdb.projects`, a marker with no
 * `of`) stands where the store's shared tables would be.
 */
export function runRemoved(removes: readonly EngineObject[]): readonly string[] {
  const grants: EngineObject[] = [];
  let entry: EngineObject | undefined;
  let register: EngineObject | undefined;
  // Every queue and marks table the plan drops, each name once.
  const marks = new Set<string>();
  let functions: EngineObject | undefined;
  const jobs = new Set<string>();
  let shared: EngineObject | undefined;
  let logTables: EngineObject | undefined;
  const schemas: string[] = [];
  const others: string[] = [];
  for (const object of removes.filter((one) => one.scope === "run")) {
    const { kind } = object;
    switch (kind) {
      case "grant":
        grants.push(object);
        break;
      case "marker":
        if (object.name === PROJECTS && object.of !== undefined) {
          entry ??= object;
        } else if (object.name === PROJECTS) {
          register ??= object;
        } else {
          marks.add(object.name);
        }
        break;
      case "function":
        functions ??= object;
        break;
      case "jobs-table":
        jobs.add(object.name);
        break;
      case "store-table":
        shared ??= object;
        break;
      case "log":
        logTables ??= object;
        break;
      case "schema":
        schemas.push(`the ${object.name} schema${afterComma(object.reason)}`);
        break;
      case "column":
      case "field":
      case "side-table":
      case "view":
      case "trigger":
      case "login":
      case "policy":
      case "index":
      case "collection":
      case "change-tracking":
        others.push(plainly(object));
        break;
      default:
        throw new Error(`no words for a removed ${kind satisfies never}`);
    }
  }
  const usage = grants
    .map((object) => object.of)
    .filter((schema): schema is string => schema !== undefined);
  return [
    // The last script in a schema takes the worker's usage of it, so it is the run's, not a table's.
    ...(grants[0] === undefined
      ? []
      : [
          `the ${grants[0].name} login's usage of ${usage.length === 1 ? "schema" : "schemas"} ${inWords(usage)}`,
        ]),
    ...(entry === undefined
      ? []
      : [`project ${entry.of}'s entry in the FacetDB store${inParentheses(entry.reason)}`]),
    ...(functions === undefined
      ? []
      : [`the enqueue trigger functions${inParentheses(functions.reason)}`]),
    // Each by the name the plan gives it, and only what the plan drops.
    ...(jobs.size === 0
      ? marks.size === 0
        ? []
        : [`the table-ownership marks (${[...marks].join(", ")})`]
      : marks.size === 0
        ? [`${jobs.size === 1 ? "the jobs table" : "the jobs tables"} (${[...jobs].join(", ")})`]
        : [
            `${jobs.size === 1 ? "the jobs table" : "the jobs tables"} and the table-ownership marks (${[...jobs, ...marks].join(", ")})`,
          ]),
    ...(shared === undefined
      ? []
      : [`the shared FacetDB tables and the alert history in them${inParentheses(shared.reason)}`]),
    ...(register === undefined
      ? []
      : [`the project register facetdb.projects${inParentheses(register.reason)}`]),
    ...others,
    ...(logTables === undefined ? [] : [`the decision log tables${afterComma(logTables.reason)}`]),
    ...schemas,
  ];
}

/** How a log entry kept reads before its reason: a later purge after ": ", the rest after ", ". */
const separatorOf = (reason: string) => (reason.startsWith("run ") ? ": " : ", ");

/** What stays of one table: its source's log and why, and what the script leaves in place on purpose. */
export function tableKept(keeps: readonly KeptObject[]): readonly string[] {
  const own = keeps.filter((object) => object.scope === "source");
  const kept: string[] = [];
  for (const entry of logEntries(own)) {
    const { reason } = entry.decisions;
    kept.push(
      reason.startsWith("no source named")
        ? `the decision log: ${reason}`
        : `the decision log of source ${entry.source} (${entrySize(entry)})${separatorOf(reason)}${reason}`,
    );
  }
  const tables = ofKind(own, "log").filter((object) => object.of === undefined);
  const tablesReason = tables[0]?.reason;
  if (tablesReason !== undefined) {
    kept.push(
      tablesReason.startsWith("which ")
        ? `the decision log tables, ${tablesReason}`
        : `the decision log tables (${tablesReason})`,
    );
  }
  for (const object of own) {
    const { kind } = object;
    switch (kind) {
      case "log":
        // Said above: a source's entries, or the log's tables.
        break;
      case "side-table":
        kept.push(`${object.name}, left in place (${object.reason})`);
        break;
      case "change-tracking":
        kept.push(`${plainly(object)}, left on (${object.reason})`);
        break;
      case "column":
      case "field":
      case "view":
      case "trigger":
      case "function":
      case "jobs-table":
      case "marker":
      case "schema":
      case "login":
      case "grant":
      case "policy":
      case "index":
      case "collection":
      case "store-table":
        kept.push(`${plainly(object)}, left in place (${object.reason})`);
        break;
      default:
        throw new Error(`no words for a kept ${kind satisfies never}`);
    }
  }
  return kept;
}

/** What the run leaves of FacetDB's shared objects, each with why; the logins always, last. */
export function runKept(keeps: readonly KeptObject[]): readonly string[] {
  let shared: KeptObject | undefined;
  let register: KeptObject | undefined;
  const jobs: KeptObject[] = [];
  const functions: KeptObject[] = [];
  const logins: KeptObject[] = [];
  const others: string[] = [];
  for (const object of keeps.filter((one) => one.scope === "run")) {
    const { kind } = object;
    switch (kind) {
      case "store-table":
        shared ??= object;
        break;
      case "marker":
        if (object.name === PROJECTS) {
          register ??= object;
        } else {
          others.push(`the table-ownership marks (${object.name}), because ${object.reason}`);
        }
        break;
      case "jobs-table":
        jobs.push(object);
        break;
      case "function":
        functions.push(object);
        break;
      case "login":
        logins.push(object);
        break;
      case "column":
      case "field":
      case "side-table":
      case "view":
      case "trigger":
      case "schema":
      case "grant":
      case "policy":
      case "index":
      case "collection":
      case "log":
      case "change-tracking":
        others.push(`${plainly(object)}, because ${object.reason}`);
        break;
      default:
        throw new Error(`no words for a kept ${kind satisfies never}`);
    }
  }
  // The database's word for its logins where every one gives the same (MongoDB's user).
  const nouns = new Set(logins.map(nounOf));
  const noun = nouns.size === 1 ? (logins[0]?.noun ?? NOUNS.login) : NOUNS.login;
  return [
    ...(shared === undefined ? [] : [`the shared FacetDB tables, because ${shared.reason}`]),
    ...(register === undefined
      ? []
      : [`the project register facetdb.projects, because ${register.reason}`]),
    ...jobs.map((object) =>
      functions.length > 0
        ? `the jobs table and the enqueue functions (${object.reason})`
        : `the jobs table (${object.reason})`,
    ),
    // Functions kept with no queue kept are said on their own.
    ...(jobs.length > 0 || functions[0] === undefined
      ? []
      : [`the enqueue functions (${functions[0].reason})`]),
    ...others,
    ...(logins.length === 0
      ? []
      : [
          `the ${logins.map((object) => object.name).join(" and ")} ${noun}${logins.length === 1 ? "" : "s"} (${logins[0]?.reason})`,
        ]),
  ];
}

/**
 * The account printed before the name is typed back: what the run removes, and what it keeps when
 * it keeps anything (a SQLite file keeps nothing of FacetDB's: no line).
 */
export function accountLines(words: {
  readonly removes: readonly string[];
  readonly keeps: readonly string[];
}): readonly string[] {
  return [
    words.removes.length === 0
      ? "This removes nothing of FacetDB's from the database."
      : `This removes: ${words.removes.join("; ")}.`,
    ...(words.keeps.length === 0 ? [] : [`This keeps: ${words.keeps.join("; ")}.`]),
  ];
}

/** Each phrase once, in first-seen order: the tables of a run share the run's words. */
export function once(phrases: readonly string[]): readonly string[] {
  return [...new Set(phrases)];
}
