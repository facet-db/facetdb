import { isAbsolute, relative } from "node:path";
import { CliError, defineCommand, EXIT_USAGE, type Workspace } from "../program.ts";
import { databaseLabel } from "./database.ts";

/**
 * `facetdb init`: writes `facetdb.config.ts` with one source and one example question, recommends
 * side-table mode when it finds a Prisma or Drizzle schema (and says why), and offers the agent
 * skills when it finds Claude Code. The connection string is asked for and checked, never written:
 * the file reads `process.env.DATABASE_URL`, because a secret never lives in the config.
 * `--dry-run` prints the file and writes nothing.
 */

type InitOptions = {
  readonly config: string;
  readonly databaseUrl?: string;
  readonly table?: string;
  readonly skills?: string;
  readonly force: boolean;
};

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

function checkedDatabaseUrl(answer: string): string {
  const url = answer.trim();
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new CliError(
      "init-database-url",
      "that is not a Postgres connection string",
      "write it as postgres://user:password@host:5432/database",
      EXIT_USAGE,
    );
  }
  return url;
}

/** The source's name: the table's own name as an identifier the config accepts. */
function sourceName(table: string): string {
  const base = (table.split(".").pop() ?? table).toLowerCase();
  return /^[a-z]/.test(base) ? base : `t_${base}`;
}

/** The file as a developer would write it: one source, one example question, comments that teach. */
export function configTemplate(table: string, storage: "inline" | "side-table"): string {
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
    "      database: process.env.DATABASE_URL, // read from the environment: this file never holds a password",
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
    const fromEnv = deps.env["DATABASE_URL"];
    const urlInput =
      options.databaseUrl ??
      (fromEnv !== undefined && fromEnv !== ""
        ? fromEnv
        : await deps.io.prompt(
            "Database connection string (checked, never written to the file; the config reads DATABASE_URL): ",
            { secret: true },
          ));
    const url = checkedDatabaseUrl(urlInput);
    const table = checkedTable(
      options.table ??
        (await deps.io.prompt("Which table should get answers? (for example support_messages): ")),
    );

    const found = await findOrm(deps.workspace);
    const storage = found === undefined ? "inline" : "side-table";
    const reason =
      found === undefined
        ? undefined
        : `Found ${found.orm} (${found.path}): your ORM manages the schema, so init chose side-table mode. It leaves ${table} alone and keeps the answers in a table FacetDB owns, joined by the view ${table.split(".").pop()}_with_answers. Set storage: "inline" in the config to add the answer columns to your table instead.`;
    const file = configTemplate(table, storage);

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
      print(`Created ${options.config} for ${table} on ${databaseLabel(url)}.`);
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
          "  2. Set DATABASE_URL to the connection string. The worker logs in as facetdb_worker, so use postgres://facetdb_worker:<a long random password>@host/database; facetdb migrate creates that login with that password. A connection pooler's suffixed user is fine (the Supabase session pooler wants facetdb_worker.<project ref>).",
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
      ...(found === undefined ? {} : { orm: found.orm, reason }),
      claudeCode,
      ...(method === undefined ? {} : { skills: method }),
      file,
    };
  },
});
