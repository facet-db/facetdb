import { type KnownDatabase, schemeOf } from "../engines.ts";
import { CliError, EXIT_USAGE } from "../program.ts";

/**
 * What `facetdb init` asks of each engine once it has read the connection string's scheme: one
 * question per thing the engine needs and the string does not already say, each saying what the
 * answer is for, and the words init prints after it: what the engine does differently, the worker's
 * connection string in that engine's shape, and the steps left. The store's Postgres is init's own
 * question, asked for every engine but Postgres. Nothing here connects.
 */

/** `--triggers`: whether the database's host lets FacetDB create a trigger on the table. */
export type TriggersAnswer = "allowed" | "forbidden";

export const TRIGGER_ANSWERS: readonly TriggersAnswer[] = ["allowed", "forbidden"];

/** What init learned of an engine's needs, from the string, the flags and the answers. */
export type EngineAnswers = {
  /** The table as the config names it: on Oracle, with its schema. */
  readonly table: string;
  /** Postgres on a host that forbids triggers: the polling connector. */
  readonly connector?: "polling";
  /** SQL Server on a host that forbids triggers: Change Tracking. */
  readonly capture?: "change-tracking";
  /** MongoDB: false when the server runs without a replica set, which change streams need. */
  readonly replicaSet?: boolean;
  /** libSQL: whether the server wants an auth token. */
  readonly token?: boolean;
  /** Azure SQL: the database the worker is a contained user of, when the string names none. */
  readonly database?: string;
  /** Oracle: the service, when the string names none. */
  readonly service?: string;
  /** What init decided for the user and must say: a default taken, a name's case changed. */
  readonly said?: readonly string[];
};

type Ask = (question: string) => Promise<string>;

/** A yes or no answer; Enter takes `fallback`, which the question names. */
function yesOrNo(answer: string, fallback: boolean): boolean {
  const said = answer.trim().toLowerCase();
  if (said === "") {
    return fallback;
  }
  if (said === "y" || said === "yes") {
    return true;
  }
  if (said === "n" || said === "no") {
    return false;
  }
  throw new CliError(
    "init-answer",
    `"${answer.trim()}" is not yes or no`,
    "run facetdb init again and type yes or no (or press Enter for the answer the question names)",
    EXIT_USAGE,
  );
}

/** The URL's host in lower case; empty for a string the URL parser cannot read (a file path). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The URL's path without its leading slash, decoded; empty when it names none. */
function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/**
 * An Azure SQL Database server: `<server>.database.windows.net`, one label before it. A Managed
 * Instance (`<instance>.<zone>.database.windows.net`) keeps server logins, as SQL Server does.
 */
function isAzureSql(url: string): boolean {
  return /^[^.]+\.database\.windows\.net$/.test(hostOf(url));
}

/** Whether a MongoDB string already says it reaches a replica set: Atlas, or `replicaSet=`. */
function saysReplicaSet(url: string): boolean {
  return (
    schemeOf(url) === "mongodb+srv" ||
    hostOf(url).endsWith(".mongodb.net") ||
    /[?&]replicaSet=[^&]/i.test(url)
  );
}

/** An Azure SQL database name as it goes after the port: letters, digits, `-` and `_`. */
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** An Oracle service name as the Oracle dialect reads it: no `?`, `(` or `/`, and no space. */
const SERVICE = /^[A-Za-z0-9_.$#-]+$/;

function named(answer: string, rule: RegExp, code: string, what: string, fix: string): string {
  const name = answer.trim();
  if (!rule.test(name)) {
    throw new CliError(code, `"${name}" is not ${what}`, fix, EXIT_USAGE);
  }
  return name;
}

const TRIGGER_WHY =
  "FacetDB notices a changed row with a trigger it adds to the table; most hosts allow one";

/** Who answers: the prompt, and whether a question asked now gets an answer (`CliIo.answerable`). */
export type Asker = {
  readonly ask: Ask;
  readonly answerable: () => Promise<boolean>;
};

/**
 * What init says when it answers the triggers question itself: no terminal to ask at and nothing
 * left on the pipe (a script, CI, a coding agent), and no `--triggers`.
 */
export const TRIGGERS_ASSUMED =
  "No answer came to whether the host forbids triggers (no terminal, and nothing left on standard input), so init takes them as allowed; on a host that forbids them, run facetdb init again with --triggers forbidden.";

/**
 * Whether the host forbids triggers: `--triggers`, else asked at the terminal or read from the
 * pipe (Enter, or an empty line, is "no, they are allowed"), else, when no answer can come,
 * allowed, said in a note.
 */
async function triggersForbidden(
  question: string,
  given: TriggersAnswer | undefined,
  asker: Asker,
): Promise<{ readonly forbidden: boolean; readonly said: readonly string[] }> {
  if (given !== undefined) {
    return { forbidden: given === "forbidden", said: [] };
  }
  if (!(await asker.answerable())) {
    return { forbidden: false, said: [TRIGGERS_ASSUMED] };
  }
  return { forbidden: yesOrNo(await asker.ask(question), false), said: [] };
}

/** An Oracle name as typed: quoted (`"listings"`, kept as written) or not (stored in capitals). */
const ORACLE_NAME = /^(?:[A-Za-z_][A-Za-z0-9_$#]*|"[^".]+")$/;

/**
 * An Oracle name as the database stores it: a quoted one as written, without its quotes; an
 * unquoted one in capitals, as Oracle stores a name created without quotes.
 */
function oracleName(typed: string): string {
  return typed.startsWith('"') ? typed.slice(1, -1) : typed.toUpperCase();
}

/** The table (and its schema) as Oracle stores them, and the note when init changed the case. */
function oracleTable(typed: string): { readonly table: string; readonly said: readonly string[] } {
  const table = typed
    .split(".")
    .map((part) => oracleName(part))
    .join(".");
  const unquoted = typed.replaceAll('"', "");
  return {
    table,
    said:
      table === unquoted
        ? []
        : [
            `init wrote the table as ${table}: Oracle stores a name created without quotes in capitals. If the table was created with quotes in lower case, write it as created in facetdb.config.ts, or run facetdb init again and type the name in quotes.`,
          ],
  };
}

/**
 * Asks what the engine needs that the connection string and the flags leave open, one question
 * each, in order; a source of an engine that needs nothing more is asked nothing.
 */
export async function askEngineNeeds(
  database: KnownDatabase,
  url: string,
  table: string,
  triggers: TriggersAnswer | undefined,
  asker: Asker,
): Promise<EngineAnswers> {
  const { ask } = asker;
  switch (database.key) {
    case "postgres": {
      const { forbidden, said } = await triggersForbidden(
        `Does your database host forbid triggers? ${TRIGGER_WHY}, and where none is allowed it polls the table instead. Type yes or no (Enter for no): `,
        triggers,
        asker,
      );
      return forbidden ? { table, connector: "polling", said } : { table, said };
    }
    case "mssql": {
      const { forbidden, said } = await triggersForbidden(
        `Does your database host forbid triggers? ${TRIGGER_WHY}, and where none is allowed it reads SQL Server's Change Tracking instead. Type yes or no (Enter for no): `,
        triggers,
        asker,
      );
      const capture = forbidden ? { capture: "change-tracking" as const } : {};
      if (isAzureSql(url) && pathOf(url) === "") {
        const name = named(
          await ask(
            "Which database on this Azure SQL server holds the table? FacetDB's worker is a contained user of that one database, so its connection string names it: ",
          ),
          DATABASE_NAME,
          "init-azure-database",
          "a database name",
          "run facetdb init again and type the database's name (letters, digits, hyphens and underscores), or put it in the connection string after the port: mssql://user:password@server.database.windows.net:1433/<database>",
        );
        return { table, ...capture, database: name, said };
      }
      return { table, ...capture, said };
    }
    case "mongodb": {
      if (saysReplicaSet(url)) {
        return { table };
      }
      const replicaSet = yesOrNo(
        await ask(
          "Does this MongoDB run as a replica set? FacetDB watches changes with change streams, which need one: Atlas has one; a self-hosted server needs --replSet. Type yes or no (Enter for yes): ",
        ),
        true,
      );
      return { table, replicaSet };
    }
    case "libsql": {
      if (hostOf(url).endsWith("turso.io")) {
        return { table, token: true };
      }
      const token = yesOrNo(
        await ask(
          "Does this libSQL server need an auth token? Turso does; a sqld on this machine may need none, and FacetDB reads the token from the environment, never from the URL. Type yes or no (Enter for yes): ",
        ),
        true,
      );
      return { table, token };
    }
    case "oracle": {
      const service =
        pathOf(url) === ""
          ? named(
              await ask(
                "Which Oracle service holds the table? The worker's connection string names it after the port (oracle://user:password@host:1521/<service>), such as FREEPDB1 or ORCLPDB1: ",
              ),
              SERVICE,
              "init-oracle-service",
              "an Oracle service name",
              "run facetdb init again and type the service name as the listener knows it (lsnrctl status lists them), without ?, ( or /",
            )
          : undefined;
      const typed = table.includes(".")
        ? table
        : `${named(
            await ask(
              `Which schema (the user) owns ${table}? FacetDB's worker owns no schema, so the source names it. Type it as Oracle stores it, usually in capitals unless it was created with quotes (APP), or in quotes to keep its case: `,
            ),
            ORACLE_NAME,
            "init-oracle-schema",
            "a schema name",
            'run facetdb init again and type the owner of the table as Oracle stores it (APP), or in quotes ("app") for one created with quotes, or pass --table APP.LISTINGS',
          )}.${table}`;
      const { table: stored, said } = oracleTable(typed);
      return { table: stored, said, ...(service === undefined ? {} : { service }) };
    }
    default:
      return { table };
  }
}

/** What init prints for an engine: notes after the questions, then the steps left. */
export type EngineWords = {
  /** Printed once the questions are answered: what this engine does that the user should know. */
  readonly notes: readonly string[];
  /** How the worker's connection string looks, said after the variable to set. */
  readonly login: string;
  /** The steps this engine adds to init's "Next:" list, before doctor. */
  readonly steps: readonly string[];
};

/** The worker's connection string with what the answers filled in, in the scheme the user wrote. */
function workerUrl(database: KnownDatabase, url: string, answers: EngineAnswers): string {
  let shape = database.workerUrl;
  const scheme = schemeOf(url);
  if (scheme === "mariadb") {
    shape = shape.replace("mysql://", "mariadb://");
  }
  if (scheme === "mongodb+srv") {
    shape =
      "mongodb+srv://facetdb_worker:<a long random password>@<your cluster's host>/<database>?authSource=admin";
  }
  if (answers.database !== undefined) {
    shape = shape.replace("<database>", answers.database);
  }
  if (answers.service !== undefined) {
    shape = shape.replace("<service>", answers.service);
  }
  return shape;
}

/** The words for an engine, given what was answered and the variable the source reads. */
export function engineWords(
  database: KnownDatabase,
  url: string,
  answers: EngineAnswers,
  variable: string,
): EngineWords {
  const words = wordsOf(database, url, answers, variable);
  // What init decided for the user comes first: a default taken, a name's case changed.
  return { ...words, notes: [...(answers.said ?? []), ...words.notes] };
}

function wordsOf(
  database: KnownDatabase,
  url: string,
  answers: EngineAnswers,
  variable: string,
): EngineWords {
  const shape = workerUrl(database, url, answers);
  const login = `The worker logs in as facetdb_worker, so use ${shape}; facetdb migrate creates that login with that password.`;
  switch (database.key) {
    case "postgres":
      return answers.connector === "polling"
        ? {
            notes: [
              `No trigger, then: the config says connector: "polling", and the worker reads ${answers.table} every 10 seconds by a column such as updated_at, which must be NOT NULL and set on every insert and update; without one it reads the whole table every hour.`,
            ],
            login,
            steps: [],
          }
        : { notes: [], login, steps: [] };
    case "mssql": {
      const notes = [
        ...(answers.capture === "change-tracking"
          ? [
              `No trigger, then: the config says capture: "change-tracking", and facetdb migrate turns on SQL Server's Change Tracking for ${answers.table}; the database's owner turns it on for the database first if it is off, with the statement migrate prints.`,
            ]
          : []),
        ...(isAzureSql(url)
          ? [
              "Azure SQL keeps its users in each database: facetdb migrate creates facetdb_worker as a contained user of the database the connection string names, and the worker's connection string must name that same database.",
            ]
          : []),
      ];
      return { notes, login, steps: [] };
    }
    case "mysql":
      return {
        notes: [],
        login,
        steps: [
          "If binary logging is on (as on RDS and Cloud SQL with backups), set log_bin_trust_function_creators to 1 in the server's parameters, or run migrate as an admin with SUPER: migrate creates triggers, and MySQL refuses them to anyone else then.",
        ],
      };
    case "sqlite":
      return {
        notes: [
          `SQLite: the worker opens the file itself, so it runs on the machine that holds the file, one worker per file, and a relative path is read from the directory it runs in. facetdb migrate puts the file in WAL mode, which stays, so your app and the worker read and write without blocking each other.`,
        ],
        login: `SQLite has no logins: the file's path is the connection string, such as ${shape}.`,
        steps: [],
      };
    case "libsql":
      return {
        notes: [],
        login: `libSQL has no logins: the server's URL is the connection string, such as ${shape}.`,
        steps:
          answers.token === false
            ? []
            : [
                `Set ${variable}_AUTH_TOKEN to the database's auth token (turso db tokens create <database>; LIBSQL_AUTH_TOKEN is read when that is unset). FacetDB reads it from the environment only, never from the URL or the config.`,
              ],
      };
    case "mongodb":
      return {
        notes: [
          `MongoDB: the source's table is the collection; the answers go in a facetdb field of each document, and the worker follows a change stream, keeping its place in the store.`,
        ],
        login:
          schemeOf(url) === "mongodb+srv"
            ? `The worker logs in as facetdb_worker, so use ${shape}; on Atlas you create that user in Database Access, and facetdb migrate prints the steps.`
            : login,
        steps:
          answers.replicaSet === false
            ? [
                `Restart mongod as a one-node replica set (mongod --replSet rs0, or replication.replSetName: rs0 in mongod.conf), run rs.initiate() once in mongosh, and add ?replicaSet=rs0 to ${variable}: change streams need a replica set.`,
              ]
            : [],
      };
    case "cockroachdb":
      return {
        notes: [
          `CockroachDB: the worker reads ${answers.table} every 10 seconds by a column such as updated_at, which must be NOT NULL and set on every insert and update (an ON UPDATE now() default does it); without one it reads the whole table every hour.`,
        ],
        login,
        steps: [],
      };
    case "oracle":
      return {
        notes: [
          `Oracle: FacetDB uses every name exactly as written, so the read columns in facetdb.config.ts must be as Oracle stores them too: in capitals for columns created without quotes (SUBJECT, BODY). The worker reads the table every 10 seconds by a column such as UPDATED_AT, which must be NOT NULL and set on every insert and update; without one it reads the whole table every hour.`,
        ],
        login,
        steps: [],
      };
    default:
      return { notes: [], login, steps: [] };
  }
}
