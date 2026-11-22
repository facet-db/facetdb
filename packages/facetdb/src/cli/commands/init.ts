import { isAbsolute, relative } from "node:path";
import {
  DATABASES_PAGE,
  databaseOf,
  isPostgresUrl,
  type KnownDatabase,
  readsUrl,
  schemeOf,
} from "../engines.ts";
import { EXAMPLE_ENGINES, EXAMPLES, PLUGIN_EXAMPLES, type PluginExample } from "../examples.ts";
import {
  type CliDeps,
  CliError,
  databaseLabel,
  defineCommand,
  type EngineEntry,
  EXIT_USAGE,
  type Workspace,
} from "../program.ts";
import { ownVariable, PGLITE_STORE, STORE_VARIABLE } from "../store-door.ts";
import {
  askEngineNeeds,
  type EngineAnswers,
  engineWords,
  TRIGGER_ANSWERS,
  type TriggersAnswer,
} from "./init-engines.ts";

/**
 * `facetdb init`: writes `facetdb.config.ts` with one source and one example question, recommends
 * side-table mode when it finds a Prisma or Drizzle schema (and says why), and offers the agent
 * skills when it finds Claude Code. The connection string is asked for and checked, never written:
 * the file reads it from the environment, because a secret never lives in the config. A Postgres
 * source's is `DATABASE_URL`, the store's too; any other source's has a variable of its own, and
 * init asks for the store's Postgres, saying why. Its scheme names the engine, which init says, and
 * then it asks what that engine needs, one question each (`init-engines.ts`). `--example listings
 * --engine <name>` copies the listings example for that engine instead; `--example github-triage`,
 * the GitHub triage, which has no engine to pick, and names the plugins its config imports.
 * `--dry-run` prints the file and writes nothing.
 */

type InitOptions = {
  readonly config: string;
  readonly databaseUrl?: string;
  readonly storeUrl?: string;
  readonly table?: string;
  readonly skills?: string;
  readonly triggers?: string;
  readonly example?: string;
  readonly engine?: string;
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

/** On Oracle a part may be quoted to keep its case: `"listings"`, `APP."listings"`. */
const ORACLE_TABLE_NAME =
  /^(?:[A-Za-z_][A-Za-z0-9_$#]*|"[^".]+")(\.(?:[A-Za-z_][A-Za-z0-9_$#]*|"[^".]+"))?$/;

function checkedTable(answer: string, oracle: boolean): string {
  const table = answer.trim();
  if (!(oracle ? ORACLE_TABLE_NAME : TABLE_NAME).test(table)) {
    throw new CliError(
      "init-table",
      `"${table}" is not a table name`,
      oracle
        ? 'give the table as Oracle stores it (LISTINGS) or schema.name (APP.LISTINGS), a part in quotes ("listings") to keep its case'
        : "give the table as its name (support_messages) or schema.name (app.support_messages), letters, digits and underscores only",
      EXIT_USAGE,
    );
  }
  return table;
}

/** The table question; on Oracle it says how a name is stored. */
function tableQuestion(database: KnownDatabase): string {
  return database.key === "oracle"
    ? "Which table should get answers? Type it as Oracle stores it, usually in capitals unless the table was created with quotes (LISTINGS), or in quotes to keep its case: "
    : "Which table should get answers? (for example support_messages): ";
}

/**
 * The source's connection string and the database its scheme names: a Postgres one, or one a
 * registered engine reads. Never echoed: it may carry a password, so a refusal names its scheme
 * alone.
 */
function checkedDatabaseUrl(
  answer: string,
  engines: readonly EngineEntry[],
): { readonly url: string; readonly database: KnownDatabase } {
  const url = answer.trim();
  // Which engine reads it is the scheme table's to say: nothing is loaded to answer it.
  const database = databaseOf(url);
  if (database !== undefined && (database.key === "postgres" || readsUrl(engines, url))) {
    return { url, database };
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

/**
 * The source's name, from which its variable is made too (`<NAME>_URL`): the table's own name as
 * an identifier the config accepts (`/^[a-z][a-z0-9_]*$/`, config/schema.ts) and a variable name
 * the file can write. Lower case; every character but a-z, 0-9 and _ becomes _, runs of _ become
 * one, and leading digits and underscores go: `APP."order-items"` is order_items, `LIST#ING` is
 * list_ing. A name with no letter left is refused. The `table:` field keeps the name as written.
 */
export function sourceName(table: string): string {
  const base = (table.split(".").pop() ?? table).replaceAll('"', "");
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[0-9_]+/, "")
    .replace(/_$/, "");
  if (name === "") {
    throw new CliError(
      "init-table",
      `the table ${base} gives no source name: a source's name, and its variable, are made of the table's letters, digits and underscores, starting with a letter`,
      "run facetdb init for a table whose name has a letter in it, or write the source by hand in facetdb.config.ts with a name of your choosing",
      EXIT_USAGE,
    );
  }
  return name;
}

/** A scheme as the string writes it: `mysql:`, `https:`. */
const SCHEME_WRITTEN = /^[a-z][a-z0-9+.-]*:/i;

/** The connection string as init names it once read: its database, never the string itself. */
function recognised(database: KnownDatabase, url: string): string {
  const written = SCHEME_WRITTEN.exec(url.trim())?.[0]?.toLowerCase() ?? "a file path";
  return `That is a ${database.name} connection string (${written}): FacetDB reads it with its ${database.key} engine.`;
}

/** What a source's config says beyond the template's own fields, from the engine's answers. */
export type TemplateExtras = {
  readonly connector?: "polling";
  readonly capture?: "change-tracking";
  /** MongoDB: the table is a collection, and the comment says so. */
  readonly collection?: boolean;
  /** Oracle: names are used as stored, in capitals for those created without quotes. */
  readonly storedInCapitals?: boolean;
};

/** The file as a developer would write it: one source, one example question, comments that teach. */
export function configTemplate(
  table: string,
  storage: "inline" | "side-table",
  variable: string = STORE_VARIABLE,
  extras: TemplateExtras = {},
): string {
  return [
    "// facetdb.config.ts: one project, one source per table, one question set per source.",
    "// What each setting means: https://docs.facetdb.dev/config",
    'import { env, facetdb, noul } from "facetdb";',
    "",
    "export default facetdb({",
    `  model: "${STARTER_MODEL}", // pinned, never an alias such as jev-latest`,
    "  sources: [",
    "    {",
    `      name: "${sourceName(table)}",`,
    `      database: env("${variable}"), // the variable's name, read from the environment: this file never holds a password`,
    // As written, as a string literal: an Oracle name in quotes may hold a space or a backslash.
    extras.collection === true
      ? `      table: ${JSON.stringify(table)}, // the collection whose documents get answers`
      : `      table: ${JSON.stringify(table)},`,
    ...(extras.connector === undefined
      ? []
      : [
          `      connector: "${extras.connector}", // the host forbids triggers: FacetDB polls the table instead`,
        ]),
    ...(extras.capture === undefined
      ? []
      : [
          `      capture: "${extras.capture}", // the host forbids triggers: FacetDB reads SQL Server's Change Tracking instead`,
        ]),
    extras.storedInCapitals === true
      ? '      read: ["SUBJECT", "BODY"], // the columns the questions need to see, as Oracle stores them: edit this list'
      : '      read: ["subject", "body"], // the columns the questions need to see: edit this list',
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

/** `--triggers`, judged before anything is asked. */
function checkedTriggers(given: string | undefined): TriggersAnswer | undefined {
  if (given === undefined) {
    return undefined;
  }
  const answer = given.trim().toLowerCase();
  if (!(TRIGGER_ANSWERS as readonly string[]).includes(answer)) {
    throw new CliError(
      "init-triggers",
      `"${given}" is not an answer to whether the host allows triggers`,
      "pass --triggers allowed, or --triggers forbidden for a host that forbids them (FacetDB then polls the table, or reads SQL Server's Change Tracking)",
      EXIT_USAGE,
    );
  }
  return answer as TriggersAnswer;
}

/** Where the answers live, and why when an ORM is found: side-table mode where the engine has it. */
function storageFor(
  found: OrmFinding | undefined,
  database: KnownDatabase,
  answers: EngineAnswers,
): { readonly storage: "inline" | "side-table"; readonly reason?: string } {
  if (found === undefined) {
    return { storage: "inline" };
  }
  const name = answers.table.split(".").pop();
  if (database.sideTable && answers.connector === undefined) {
    return {
      storage: "side-table",
      reason: `Found ${found.orm} (${found.path}): your ORM manages the schema, so init chose side-table mode. It leaves ${answers.table} alone and keeps the answers in a table FacetDB owns, joined by the view ${name}_with_answers. Set storage: "inline" in the config to add the answer columns to your table instead.`,
    };
  }
  const why =
    answers.connector === "polling"
      ? "the polling connector has no side-table mode"
      : `${database.name} has no side-table mode`;
  return {
    storage: "inline",
    reason: `Found ${found.orm} (${found.path}): your ORM manages the schema, and ${why}, so the answers go in columns FacetDB adds to ${answers.table}, each named facetdb_… (on MongoDB, a facetdb field); leave them out of your ORM's schema so its migrations keep them.`,
  };
}

type ExampleOptions = InitOptions & { readonly dryRun: boolean };

/** The flags a finished project would ignore: refused, as each would change nothing. */
function refuseTableFlags(options: ExampleOptions, rerun: string): void {
  const asked = [
    options.databaseUrl === undefined ? undefined : "--database-url",
    options.storeUrl === undefined ? undefined : "--store-url",
    options.table === undefined ? undefined : "--table",
    options.triggers === undefined ? undefined : "--triggers",
  ].filter((flag) => flag !== undefined);
  if (asked.length > 0) {
    throw new CliError(
      "init-example",
      `--example copies a finished project, so ${asked.join(", ")} would change nothing`,
      `run ${rerun} alone, or leave out --example to write a config for your own table`,
      EXIT_USAGE,
    );
  }
}

/** Paths as a sentence names them: "a", "a and b", "a, b and c". */
function spoken(paths: readonly string[]): string {
  return paths.length <= 1
    ? (paths[0] ?? "")
    : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1) as string}`;
}

/**
 * The files of the example in `directory` as they land in the project: the config where --config
 * says and first, every other file beside it under its own name. When any is there already and
 * --force is not given, refused naming every one of them, so --force never replaces a file the
 * refusal did not name; with --force, the run says which it replaced. With `--dry-run` printed
 * under `heading`, else written.
 */
async function placeExample(
  directory: string,
  heading: string,
  rerun: string,
  options: ExampleOptions,
  deps: CliDeps,
  print: (text: string) => void,
): Promise<readonly string[]> {
  const files = await deps.examples.read(directory);
  const config = files.find((file) => file.path === "facetdb.config.ts");
  if (config === undefined) {
    throw new CliError(
      "init-example",
      `the facetdb package has no ${directory} example here`,
      "reinstall facetdb with its examples (npm install facetdb), then run facetdb init --example again",
    );
  }
  const copies = [config, ...files.filter((file) => file !== config)].map((file) => ({
    path: file === config ? options.config : file.path,
    text: file.text,
  }));
  const there: string[] = [];
  for (const copy of copies) {
    if (await deps.workspace.exists(copy.path)) {
      there.push(copy.path);
    }
  }
  const replaced = spoken(there);
  if (there.length > 0 && !options.force) {
    throw new CliError(
      "init-config-exists",
      `${replaced} already ${there.length === 1 ? "exists" : "exist"}, and init does not replace a file you may have edited`,
      `move ${there.length === 1 ? "it" : "them"} away, or run ${rerun} --force to replace ${replaced} with the example's`,
    );
  }
  const listed = copies.map((copy) => copy.path).join(", ");
  if (options.dryRun) {
    const replacing = there.length === 0 ? "" : `; --force would replace ${replaced}`;
    print(`-- ${heading} (dry run: nothing is written${replacing}): ${listed}`);
    print(config.text);
  } else {
    for (const copy of copies) {
      await deps.workspace.write(copy.path, copy.text, { overwrite: options.force });
    }
    print(`Copied ${heading}: ${listed}.`);
    if (there.length > 0) {
      print(`Replaced ${replaced} with the example's (--force).`);
    }
  }
  return copies.map((copy) => copy.path);
}

/**
 * `--example github-triage`: an example with no engine variant, whose records are a plugin source's
 * in the store; copied whole, then the plugins its config imports are named, since the file loads
 * only once they are added.
 */
async function copyPluginExample(
  example: PluginExample,
  options: ExampleOptions,
  deps: CliDeps,
  print: (text: string) => void,
): Promise<unknown> {
  const rerun = `facetdb init --example ${example.name}`;
  if (options.engine !== undefined) {
    throw new CliError(
      "init-engine",
      `the ${example.name} example has no database to pick: its records are read by a plugin and kept in the FacetDB store`,
      `run ${rerun} without --engine`,
      EXIT_USAGE,
    );
  }
  refuseTableFlags(options, rerun);
  const files = await placeExample(
    example.name,
    `the ${example.name} example`,
    rerun,
    options,
    deps,
    print,
  );
  const packages = example.plugins.map((plugin) => plugin.package);
  if (!options.dryRun) {
    const add = example.plugins.map((plugin) => `facetdb add ${plugin.name}`);
    print(
      [
        "Next:",
        `  1. Add the plugins its config imports: ${add.join(" and ")} (the packages ${packages.join(" and ")}).`,
        `  2. Follow ${example.steps} from its step 2: your repository in the config, the variables it names, then the worker and its webhook.`,
      ].join("\n"),
    );
  }
  return {
    ok: true,
    dryRun: options.dryRun,
    example: example.name,
    created: !options.dryRun,
    files,
    packages,
  };
}

/** `--example listings --engine <name>`, or an example with no engine: its files, copied into the project. */
async function copyExample(
  options: ExampleOptions,
  deps: CliDeps,
  print: (text: string) => void,
): Promise<unknown> {
  const example = (options.example ?? "listings").trim().toLowerCase();
  if (!EXAMPLES.includes(example)) {
    throw new CliError(
      "init-example",
      `there is no example named "${options.example ?? ""}"`,
      `pass --example ${EXAMPLES.join(" or --example ")}`,
      EXIT_USAGE,
    );
  }
  const plugged = PLUGIN_EXAMPLES.find((one) => one.name === example);
  if (plugged !== undefined) {
    return copyPluginExample(plugged, options, deps, print);
  }
  const wanted = (options.engine ?? "postgres").trim().toLowerCase();
  const engine = EXAMPLE_ENGINES.find((one) => one.name === wanted);
  const names = EXAMPLE_ENGINES.map((one) => one.name).join(", ");
  if (engine === undefined) {
    throw new CliError(
      "init-engine",
      `there is no ${example} example for "${options.engine ?? ""}"`,
      `pass --engine with one of ${names}`,
      EXIT_USAGE,
    );
  }
  const rerun = `facetdb init --example ${example} --engine ${engine.name}`;
  refuseTableFlags(options, rerun);
  // The config goes where --config says; the seeds beside it, under their own names.
  const files = await placeExample(
    `${example}-${engine.name}`,
    `the ${example} example for ${engine.label}`,
    rerun,
    options,
    deps,
    print,
  );
  if (!options.dryRun) {
    const seed = files.find((path) => path.startsWith("seed.")) ?? "seed.sql";
    print(
      [
        "Next:",
        `  1. Make the table and its 2,000 sample rows (seed-quick has 100) with the admin login: ${engine.seed.replace("seed.sql", seed)}`,
        engine.variable === STORE_VARIABLE
          ? `  2. Set DATABASE_URL to ${engine.workerUrl}; facetdb migrate creates that login with that password.`
          : `  2. Set ${engine.variable} to ${engine.workerUrl}, and DATABASE_URL to the store's Postgres: ${STORE_WHY}`,
        ...(engine.step === undefined ? [] : [`  3. ${engine.step}`]),
        `  ${engine.step === undefined ? 3 : 4}. facetdb doctor checks the setup, facetdb preview answers 20 rows without changing anything, facetdb migrate shows the SQL before it runs.`,
      ].join("\n"),
    );
  }
  return {
    ok: true,
    dryRun: options.dryRun,
    example,
    engine: engine.name,
    created: !options.dryRun,
    files,
    variable: engine.variable,
  };
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
        "the database's connection string; checked, never written to the file (the config reads it from the environment)",
    },
    {
      flags: "--store-url <url>",
      description:
        "the store's Postgres, when the source is another database; checked, never written (the store is DATABASE_URL)",
    },
    { flags: "--table <name>", description: "the table whose rows get answers" },
    {
      flags: "--triggers <answer>",
      description:
        "whether the host lets FacetDB add a trigger: allowed or forbidden (Postgres then polls, SQL Server reads Change Tracking); asked when left out (read from standard input with no terminal), taken as allowed with a note when no answer can come",
    },
    {
      flags: "--skills <method>",
      description: "the one install method for the agent skills: plugin, npx or none",
    },
    {
      flags: "--example <name>",
      description: `copy an example project instead of writing a config: ${EXAMPLES.join(" or ")}`,
    },
    {
      flags: "--engine <name>",
      description: `with --example listings, the database the example is for: ${EXAMPLE_ENGINES.map((one) => one.name).join(", ")}`,
    },
    {
      flags: "--force",
      description:
        "replace the config file when it already exists; with --example, every file the example writes that is already there (without --force, init refuses and names each one)",
    },
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
    if (options.example !== undefined) {
      return copyExample(options, deps, print);
    }
    // The engine of your own source is read from its connection string; --engine names an example's.
    if (options.engine !== undefined) {
      throw new CliError(
        "init-engine",
        "--engine picks the database of an example, and goes with --example",
        `run facetdb init --example listings --engine ${options.engine.trim()} to copy that example, or leave out --engine: init reads your database's engine from its connection string`,
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
    const triggers = checkedTriggers(options.triggers);
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
            "Database connection string (checked, never written to the file; the config reads it from the environment): ",
            { secret: true },
          ));
    const { url, database } = checkedDatabaseUrl(urlInput, deps.engines);
    const postgres = database.key === "postgres";
    print(recognised(database, url));
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
    const oracle = database.key === "oracle";
    const asked = checkedTable(
      options.table ?? (await deps.io.prompt(tableQuestion(database))),
      oracle,
    );
    // What this engine needs that the string does not say: one question each.
    const answers = await askEngineNeeds(database, url, asked, triggers, {
      ask: (question) => deps.io.prompt(question),
      answerable: () => deps.io.answerable(),
    });
    const { table } = answers;
    // `<SOURCE>_URL`, never DATABASE_URL, the store's: a table named database reads
    // DATABASE_SOURCE_URL. A polling Postgres source never shares the store's login.
    const variable =
      postgres && answers.connector === undefined ? STORE_VARIABLE : ownVariable(sourceName(table));
    const words = engineWords(database, url, answers, variable);
    for (const note of words.notes) {
      print(note);
    }

    const found = await findOrm(deps.workspace);
    const { storage, reason } = storageFor(found, database, answers);
    const file = configTemplate(table, storage, variable, {
      ...(answers.connector === undefined ? {} : { connector: answers.connector }),
      ...(answers.capture === undefined ? {} : { capture: answers.capture }),
      collection: database.key === "mongodb",
      storedInCapitals: oracle,
    });

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
      const steps = [
        `Edit ${options.config}: the columns to read and your own question.`,
        variable === STORE_VARIABLE
          ? "Set DATABASE_URL to the connection string. The worker logs in as facetdb_worker, so use postgres://facetdb_worker:<a long random password>@host/database; facetdb migrate creates that login with that password. A connection pooler's suffixed user is fine (the Supabase session pooler wants facetdb_worker.<project ref>). Use a direct connection or a session pooler (Supabase: port 5432), not a transaction pooler (6543): the worker queues records with named prepared statements."
          : postgres
            ? `Set ${variable} to the worker login's connection string and DATABASE_URL to the store owner's (the same database is fine): the polling connector adds the table's columns and none of the store's tables, so the source and the store need two logins. ${words.login}`
            : `Set ${variable} to the source's connection string, and DATABASE_URL to the store's Postgres: ${STORE_WHY} ${words.login}`,
        ...words.steps,
        "facetdb doctor checks the setup, facetdb preview answers 20 rows without changing anything, facetdb migrate shows the SQL before it runs.",
      ];
      print(["Next:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n"));
    }
    return {
      ok: true,
      dryRun: options.dryRun,
      config: options.config,
      created: !options.dryRun,
      engine: database.key,
      table,
      storage,
      variable,
      ...(answers.connector === undefined ? {} : { connector: answers.connector }),
      ...(answers.capture === undefined ? {} : { capture: answers.capture }),
      ...(storeUrl === undefined ? {} : { store: databaseLabel(storeUrl) }),
      ...(found === undefined ? {} : { orm: found.orm, reason }),
      claudeCode,
      ...(method === undefined ? {} : { skills: method }),
      file,
    };
  },
});
