import { isAbsolute, relative } from "node:path";
import { DATABASES_PAGE, isPostgresUrl, readsUrl, schemeOf } from "../engines.ts";
import {
  CliError,
  databaseLabel,
  defineCommand,
  type EngineEntry,
  EXIT_USAGE,
  type Workspace,
} from "../program.ts";
import { ownVariable, PGLITE_STORE, STORE_VARIABLE } from "../store-door.ts";

/**
 * `facetdb init`: writes `facetdb.config.ts` with one source and one example question, recommends
 * side-table mode when it finds a Prisma or Drizzle schema (and says why), and offers the agent
 * skills when it finds Claude Code. The connection string is asked for and checked, never written:
 * the file reads it from the environment, because a secret never lives in the config. A Postgres
 * source's is `DATABASE_URL`, the store's too; any other source's has a variable of its own, and
 * init asks for the store's Postgres, saying why. `--dry-run` prints the file and writes nothing.
 */

type InitOptions = {
  readonly config: string;
  readonly databaseUrl?: string;
  readonly storeUrl?: string;
  readonly table?: string;
  readonly skills?: string;
  readonly force: boolean;
};

/** Why a source that is not Postgres needs a Postgres too: the one sentence init says before asking. */
export const STORE_WHY =
  "FacetDB keeps the decision log, usage and alerts in a Postgres of yours; a free Supabase or Neon project is enough.";

/** The model a new project pins; an exact version, never an alias. */
const STARTER_MODEL = "jev-1.14.0";

/** The files that mean an ORM manages the schema; the first one found names the ORM. */
const ORM_MARKERS: readonly { readonly orm: "Prisma" | "Drizzle"; readonly path: string }[] = [
  { orm: "Prisma", path: "prisma/schema.prisma" },
  { orm: "Drizzle", path: "drizzle.config.ts" },
  { orm: "Drizzle", path: "drizzle.config.js" },
  { orm: "Drizzle", path: "drizzle.config.mjs" },
  { orm: "Drizzle", path: "drizzle.config.cjs" },
  { orm: "Drizzle", path: "drizzle.config.json" },
];

type OrmFinding = { readonly orm: "Prisma" | "Drizzle"; readonly path: string };

async function findOrm(workspace: Workspace): Promise<OrmFinding | undefined> {
  for (const marker of ORM_MARKERS) {
    if (await workspace.exists(marker.path)) {
      return marker;
    }
  }
  return undefined;
}

/**
 * TypeSafe asks for one install method per project, to avoid duplicate copies; so the commands come
 * in two methods and exactly one is chosen.
 */
export const SKILL_METHODS = {
  plugin: [
    "claude plugin marketplace add typesafe-ai/skills",
    "claude plugin install typesafe@typesafe-ai",
    "claude plugin marketplace add facetdb/facetdb",
    "claude plugin install facetdb@facetdb",
  ],
  npx: [
    "npx skills add typesafe-ai/skills --skill typesafe-ai",
    "npx skills add facetdb/facetdb --skill facetdb",
  ],
} as const;

type SkillMethod = keyof typeof SKILL_METHODS;

const METHOD_ANSWERS: readonly string[] = ["plugin", "npx", "none"];

function skillOffer(): string[] {
  return [
    "Claude Code found. Two skills teach it the Jev API and FacetDB's config, and TypeSafe asks for one install method per project:",
    "  plugin (Claude Code's plugin manager):",
    ...SKILL_METHODS.plugin.map((command) => `    ${command}`),
    "  npx (works with any coding agent):",
    ...SKILL_METHODS.npx.map((command) => `    ${command}`),
  ];
}

/** A table written by name, optionally with its schema: `support_messages` or `app.support_messages`. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function checkedTable(answer: string): string {
  const table = answer.trim();
  if (!TABLE_NAME.test(table)) {
    throw new CliError(
      "init-table",
      `"${table}" is not a table name`,
      "give the table as its name (support_messages) or schema.name (app.support_messages), letters, digits and underscores only",
      EXIT_USAGE,
    );
  }
  return table;
}

/**
 * The source's connection string: a Postgres one, or one a registered engine reads. Never echoed:
 * it may carry a password, so a refusal names its scheme alone.
 */
function checkedDatabaseUrl(
  answer: string,
  engines: readonly EngineEntry[],
): { readonly url: string; readonly postgres: boolean } {
  const url = answer.trim();
  if (isPostgresUrl(url)) {
    return { url, postgres: true };
  }
  // Which engine reads it is the scheme table's to say: nothing is loaded to answer it.
  if (readsUrl(engines, url)) {
    return { url, postgres: false };
  }
  const scheme = schemeOf(url);
  throw new CliError(
    "init-database-url",
    `that is not a Postgres connection string, and no engine registered here reads ${scheme === undefined ? "it" : `${scheme}: strings`}`,
    `write it as postgres://user:password@host:5432/database, or as the connection string of a database FacetDB connects to (${DATABASES_PAGE})`,
    EXIT_USAGE,
  );
}

/** The store's connection string: always a Postgres, never a PGlite store. */
function checkedStoreUrl(answer: string): string {
  const url = answer.trim();
  if (isPostgresUrl(url)) {
    return url;
  }
  throw new CliError(
    "init-store-url",
    schemeOf(url) === "pglite"
      ? PGLITE_STORE
      : "the store's connection string is not a Postgres connection string",
    "write it as postgres://user:password@host:5432/database: FacetDB keeps its store in a Postgres, and a free Supabase or Neon project is enough",
    EXIT_USAGE,
  );
}

/** The source's name: the table's own name as an identifier the config accepts. */
function sourceName(table: string): string {
  const base = (table.split(".").pop() ?? table).toLowerCase();
  return /^[a-z]/.test(base) ? base : `t_${base}`;
}

/** The file as a developer would write it: one source, one example question, comments that teach. */
export function configTemplate(
  table: string,
  storage: "inline" | "side-table",
  variable: string = STORE_VARIABLE,
): string {
  return [
    "// facetdb.config.ts: one project, one source per table, one question set per source.",
    "// What each setting means: https://docs.facetdb.dev/config",
    'import { facetdb, noul } from "facetdb";',
    "",
    "export default facetdb({",
    `  model: "${STARTER_MODEL}", // pinned, never an alias such as jev-latest`,
    "  sources: [",
    "    {",
    `      name: "${sourceName(table)}",`,
    `      database: process.env.${variable}, // read from the environment: this file never holds a password`,
    `      table: "${table}",`,
    '      read: ["subject", "body"], // the columns the questions need to see: edit this list',
    `      storage: "${storage}", // "inline" adds the answer columns to your table; "side-table" leaves it alone`,
    "      questions: {",
    '        is_urgent: noul("Does this need a reply from a person today?"),',
    "      },",
    "    },",
    "  ],",
    "});",
    "",
  ].join("\n");
}

function insideProject(path: string): boolean {
  const from = relative(".", path);
  return !isAbsolute(path) && !from.startsWith("..");
}

export const initCommand = defineCommand<InitOptions>("init", {
  description: "Creates the config file and asks for the database connection",
  options: [
    {
      flags: "--config <path>",
      description: "where to write the config file",
      defaultValue: "facetdb.config.ts",
    },
    {
      flags: "--database-url <url>",
      description:
        "the Postgres connection string; checked, never written to the file (the config reads DATABASE_URL)",
    },
    {
      flags: "--store-url <url>",
      description:
        "the store's Postgres, when the source is another database; checked, never written (the store is DATABASE_URL)",
    },
    { flags: "--table <name>", description: "the table whose rows get answers" },
    {
      flags: "--skills <method>",
      description: "the one install method for the agent skills: plugin, npx or none",
    },
    { flags: "--force", description: "replace the config file when it already exists" },
  ],
  run: async ({ options, deps, print }) => {
    if (!insideProject(options.config)) {
      throw new CliError(
        "init-config-path",
        `${options.config} is outside the project directory`,
        "pass a path inside the project, such as --config facetdb.config.ts",
        EXIT_USAGE,
      );
    }
    if (
      options.skills !== undefined &&
      !METHOD_ANSWERS.includes(options.skills.trim().toLowerCase())
    ) {
      throw new CliError(
        "init-skills",
        `"${options.skills}" is not an install method`,
        "pass --skills plugin, --skills npx or --skills none",
        EXIT_USAGE,
      );
    }
    if (!options.force && (await deps.workspace.exists(options.config))) {
      throw new CliError(
        "init-config-exists",
        `${options.config} already exists, and init does not replace a config you may have edited`,
        `edit ${options.config} by hand, or run facetdb init --force to start again from the template`,
      );
    }

    // The connection string: a flag, else the environment's DATABASE_URL, else asked for.
    const fromEnv = deps.env[STORE_VARIABLE];
    const urlInput =
      options.databaseUrl ??
      (fromEnv !== undefined && fromEnv !== ""
        ? fromEnv
        : await deps.io.prompt(
            "Database connection string (checked, never written to the file; the config reads DATABASE_URL): ",
            { secret: true },
          ));
    const { url, postgres } = checkedDatabaseUrl(urlInput, deps.engines);
    // A source that is not Postgres keeps its own connection string, and the store needs a Postgres
    // of its own: DATABASE_URL. A Postgres source's database holds the store too.
    let storeUrl: string | undefined;
    if (!postgres) {
      print(STORE_WHY);
      storeUrl = checkedStoreUrl(
        options.storeUrl ??
          (fromEnv !== undefined && fromEnv !== "" && fromEnv !== url && isPostgresUrl(fromEnv)
            ? fromEnv
            : await deps.io.prompt(
                "Store connection string, a Postgres (checked, never written to the file; the store is DATABASE_URL): ",
                { secret: true },
              )),
      );
    }
    const table = checkedTable(
      options.table ??
        (await deps.io.prompt("Which table should get answers? (for example support_messages): ")),
    );
    // `<SOURCE>_URL`, never DATABASE_URL, the store's: a table named database reads DATABASE_SOURCE_URL.
    const variable = postgres ? STORE_VARIABLE : ownVariable(sourceName(table));

    const found = await findOrm(deps.workspace);
    const storage = found === undefined ? "inline" : "side-table";
    const reason =
      found === undefined
        ? undefined
        : `Found ${found.orm} (${found.path}): your ORM manages the schema, so init chose side-table mode. It leaves ${table} alone and keeps the answers in a table FacetDB owns, joined by the view ${table.split(".").pop()}_with_answers. Set storage: "inline" in the config to add the answer columns to your table instead.`;
    const file = configTemplate(table, storage, variable);

    const claudeCode =
      (await deps.workspace.exists(".claude")) || deps.workspace.hasClaudeCommand();
    let method: SkillMethod | "none" | undefined;
    if (claudeCode) {
      if (options.skills !== undefined) {
        method = options.skills.trim().toLowerCase() as SkillMethod | "none";
      } else if (!options.dryRun) {
        print(skillOffer().join("\n"));
        const answer = (
          await deps.io.prompt("Which one install method? Type plugin, npx or none: ")
        )
          .trim()
          .toLowerCase();
        if (!METHOD_ANSWERS.includes(answer)) {
          throw new CliError(
            "init-skills",
            `"${answer}" is not an install method`,
            "run facetdb init again and type plugin, npx or none",
            EXIT_USAGE,
          );
        }
        method = answer as SkillMethod | "none";
      }
    }

    if (reason !== undefined) {
      print(reason);
    }
    if (options.dryRun) {
      print(`-- ${options.config} (dry run: nothing is written)`);
      print(file);
      if (claudeCode && method === undefined) {
        print(skillOffer().join("\n"));
      }
    } else {
      await deps.workspace.write(options.config, file, { overwrite: options.force });
      print(
        storeUrl === undefined
          ? `Created ${options.config} for ${table} on ${databaseLabel(url)}.`
          : `Created ${options.config} for ${table} on ${databaseLabel(url)}, with the store on ${databaseLabel(storeUrl)}.`,
      );
    }
    if (method === "plugin" || method === "npx") {
      print(
        `Install the skills with the ${method} method, and only that one, so there are no duplicate copies (FacetDB prints these commands and runs none of them):\n${SKILL_METHODS[method].map((command) => `  ${command}`).join("\n")}`,
      );
    }
    if (!options.dryRun) {
      print(
        [
          "Next:",
          `  1. Edit ${options.config}: the columns to read and your own question.`,
          storeUrl === undefined
            ? "  2. Set DATABASE_URL to the connection string. The worker logs in as facetdb_worker, so use postgres://facetdb_worker:<a long random password>@host/database; facetdb migrate creates that login with that password. A connection pooler's suffixed user is fine (the Supabase session pooler wants facetdb_worker.<project ref>). Use a direct connection or a session pooler (Supabase: port 5432), not a transaction pooler (6543): the worker queues records with named prepared statements."
            : `  2. Set ${variable} to the source's connection string, and DATABASE_URL to the store's Postgres: ${STORE_WHY}`,
          "  3. facetdb doctor checks the setup, facetdb preview answers 20 rows without changing anything, facetdb migrate shows the SQL before it runs.",
        ].join("\n"),
      );
    }
    return {
      ok: true,
      dryRun: options.dryRun,
      config: options.config,
      created: !options.dryRun,
      table,
      storage,
      variable,
      ...(storeUrl === undefined ? {} : { store: databaseLabel(storeUrl) }),
      ...(found === undefined ? {} : { orm: found.orm, reason }),
      claudeCode,
      ...(method === undefined ? {} : { skills: method }),
      file,
    };
  },
});
