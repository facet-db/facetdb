import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExampleFile, ExampleShelf } from "./program.ts";

/**
 * The example projects `facetdb init --example listings --engine <name>` copies: the marketplace
 * listings with its two questions, one directory per engine under
 * `packages/facetdb/examples/listings-<engine>/`, each a config, a seed of 2,000 rows and a quick
 * seed of 100 in the engine's own language. `listings-market` is the Supabase example and stays as
 * it is. `facetdb init --example github-triage` copies the GitHub triage, which has no engine
 * variant: `examples/github-triage/`.
 */

/** An engine the listings example exists for, and the words init prints after copying it. */
export type ExampleEngine = {
  /** What `--engine` takes, and the directory's suffix: `listings-<name>`. */
  readonly name: string;
  readonly label: string;
  /** The variable the example's config reads the source's connection string from. */
  readonly variable: string;
  /** The worker's connection string, as the example's variable should hold it. */
  readonly workerUrl: string;
  /** How to run the seed against the database, with the admin login. */
  readonly seed: string;
  /** What else the engine needs before doctor, said as a step after the variables. */
  readonly step?: string;
};

/** The examples `--engine` picks from, in the order the words list them. */
export const EXAMPLE_ENGINES: readonly ExampleEngine[] = [
  {
    name: "postgres",
    label: "Postgres",
    variable: "DATABASE_URL",
    workerUrl:
      "postgres://facetdb_worker:<a long random password>@<host>:5432/<database>?sslmode=require",
    seed: 'psql "<the admin connection string>" -f seed.sql',
  },
  {
    name: "mysql",
    label: "MySQL",
    variable: "LISTINGS_URL",
    workerUrl:
      'mysql://facetdb_worker:<a long random password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}',
    seed: "mysql --host <host> --user <admin> --password <database> < seed.sql",
  },
  {
    name: "mariadb",
    label: "MariaDB",
    variable: "LISTINGS_URL",
    workerUrl:
      'mariadb://facetdb_worker:<a long random password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}',
    seed: "mariadb --host <host> --user <admin> --password <database> < seed.sql",
  },
  {
    name: "mssql",
    label: "SQL Server",
    variable: "LISTINGS_URL",
    workerUrl: "mssql://facetdb_worker:<a long random password>@<host>:1433/<database>",
    seed: "sqlcmd -S <host> -d <database> -U <admin> -i seed.sql",
  },
  {
    name: "sqlite",
    label: "SQLite",
    variable: "LISTINGS_URL",
    workerUrl: "sqlite:./listings.db",
    seed: "sqlite3 listings.db < seed.sql",
  },
  {
    name: "libsql",
    label: "libSQL (Turso)",
    variable: "LISTINGS_URL",
    workerUrl: "libsql://<database>-<organization>.turso.io",
    seed: "turso db shell <database> < seed.sql",
    step: "Set LISTINGS_URL_AUTH_TOKEN to the database's auth token (turso db tokens create <database>; LIBSQL_AUTH_TOKEN is read when it is unset, and a sqld on this machine may need none). FacetDB reads it from the environment only, never from the URL or the config.",
  },
  {
    name: "mongodb",
    label: "MongoDB",
    variable: "LISTINGS_URL",
    workerUrl:
      "mongodb://facetdb_worker:<a long random password>@<host>:27017/<database>?replicaSet=rs0",
    seed: 'mongosh "<the admin connection string>" seed.js',
    step: "The server must be a replica set, since FacetDB follows a change stream: Atlas is one; restart a self-hosted mongod with --replSet rs0, run rs.initiate() once in mongosh, and keep ?replicaSet=rs0 in LISTINGS_URL.",
  },
  {
    name: "cockroachdb",
    label: "CockroachDB",
    variable: "LISTINGS_URL",
    workerUrl:
      "cockroachdb://facetdb_worker:<a long random password>@<host>:26257/<database>?sslmode=verify-full",
    seed: 'cockroach sql --url "<the admin connection string>" < seed.sql',
  },
  {
    name: "oracle",
    label: "Oracle",
    variable: "LISTINGS_URL",
    workerUrl:
      "oracle://facetdb_worker:<a long random password>@<host>:2484/<service>?protocol=tcps",
    // The same listener as the worker's URL: TLS on 2484 (Easy Connect Plus, sqlplus 19c and later).
    seed: "sqlplus <admin>@tcps://<host>:2484/<service> @seed.sql",
  },
];

/** A plugin an example's config imports: the name `facetdb add` takes, and its package. */
export type ExamplePlugin = { readonly name: string; readonly package: string };

/**
 * An example with no engine variant: its records are a plugin source's, kept in the store, so there
 * is no database to pick; one directory, `examples/<name>/`, a config and the steps to run it. Its
 * config imports plugins the project must add.
 */
export type PluginExample = {
  /** What `--example` takes, and the directory's name. */
  readonly name: string;
  /**
   * The file of the steps, copied beside the config under this name: `facetdb-<name>.md`, never a
   * README.md, since the example is run inside a repository that has its own.
   */
  readonly steps: string;
  /** The plugins its config imports, in the order init names them. */
  readonly plugins: readonly ExamplePlugin[];
};

/** The examples with no engine variant: the GitHub triage. */
export const PLUGIN_EXAMPLES: readonly PluginExample[] = [
  {
    name: "github-triage",
    steps: "facetdb-github-triage.md",
    plugins: [
      { name: "github", package: "@facetdb/github" },
      { name: "slack", package: "@facetdb/slack" },
    ],
  },
];

/** The examples the package ships: what `--example` takes. */
export const EXAMPLES: readonly string[] = [
  "listings",
  ...PLUGIN_EXAMPLES.map((example) => example.name),
];

/** The package's own `examples/` directory, next to `src/`. */
const EXAMPLES_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));

/** The example projects on the real disk, read from the installed package; nothing is written. */
export const diskExamples: ExampleShelf = {
  async read(directory) {
    let names: string[];
    try {
      names = await readdir(`${EXAMPLES_DIR}${directory}`);
    } catch {
      return [];
    }
    const files: ExampleFile[] = [];
    for (const name of names.sort()) {
      files.push({
        path: name,
        text: await readFile(`${EXAMPLES_DIR}${directory}/${name}`, "utf8"),
      });
    }
    return files;
  },
};
