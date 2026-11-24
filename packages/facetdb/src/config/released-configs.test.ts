import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./index.ts";

/**
 * A config a released version shipped as an example still loads, or is refused with words that say
 * how to fix it. `released/<version>/<example>/facetdb.config.ts` is that version's copy, written
 * by `release.sh freeze <version>` and never edited (released/README.md). Every one is copied into
 * a temporary project whose `node_modules` links `facetdb` and the first-party plugins it imports,
 * and loaded through `loadConfig` with every variable it names set: a source's connection string to
 * a placeholder of its database's scheme, so what only the string decides is judged too (the schema
 * never sees a variable's value, the loader does). It passes when it loads, or when its
 * `ConfigError` lists exactly the issues its entry in ACCEPTED_REFUSALS does. Any other outcome
 * fails with the version, the example and the words, and says what to do. A name the file imports
 * that facetdb or a plugin no longer exports fails too, used or not. The check reads whatever
 * version folders exist, so a freeze needs no change here.
 *
 * What it does not judge: a plugin's own settings (a source's, an action's, a channel's) are judged
 * by the plugin host when a worker starts, never by `loadConfig`, and plugin schemas drop keys they
 * do not know, so a changed plugin setting is not caught here; and a changed default (`stakes`,
 * `onOutage`, `onCapReached`) still loads, so it passes.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASED = join(packageDir, "released");
const EXAMPLES = join(packageDir, "examples");
const PLUGINS = join(packageDir, "..", "..", "plugins");
const THIS_FILE = "packages/facetdb/src/config/released-configs.test.ts";

/**
 * A key "<version>/<example>" and the issues the loader refuses that frozen config with, each as
 * `ConfigError` prints it ("path: message"), word for word. Add an entry only for a refusal that is
 * intended, and only when every line says how the user fixes their config: the reviewer reads the
 * words here. Empty: nothing was released yet.
 */
type AcceptedRefusals = Readonly<Record<string, readonly string[]>>;
const ACCEPTED_REFUSALS: AcceptedRefusals = {};

/**
 * A source's connection string for each database an example is named after (`listings-<engine>`):
 * the worker login's URL as init prints it, its blanks filled. The host is public, so no rule about
 * loopback or private addresses refuses it.
 */
const DATABASE_URLS: Readonly<Record<string, string>> = {
  postgres: "postgres://facetdb_worker:placeholder@db.example.com:5432/listings?sslmode=require",
  mysql:
    'mysql://facetdb_worker:placeholder@db.example.com:3306/listings?ssl={"rejectUnauthorized":true}',
  mariadb:
    'mariadb://facetdb_worker:placeholder@db.example.com:3306/listings?ssl={"rejectUnauthorized":true}',
  mssql: "mssql://facetdb_worker:placeholder@db.example.com:1433/listings",
  sqlite: "sqlite:./listings.db",
  libsql: "libsql://listings-example.turso.io",
  mongodb: "mongodb://facetdb_worker:placeholder@db.example.com:27017/listings?replicaSet=rs0",
  cockroachdb:
    "cockroachdb://facetdb_worker:placeholder@db.example.com:26257/listings?sslmode=verify-full",
  oracle: "oracle://facetdb_worker:placeholder@db.example.com:2484/listings?protocol=tcps",
};

/** Every variable the file names, `env("X")`, and those a source's `database` reads. */
function variablesOf(text: string): { all: string[]; databases: string[] } {
  const names = (pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1] ?? "");
  return {
    all: [...new Set(names(/\benv\(\s*["']([^"']+)["']\s*\)/g))],
    databases: [...new Set(names(/\bdatabase:\s*env\(\s*["']([^"']+)["']\s*\)/g))],
  };
}

/**
 * The environment the example is loaded with, or the words saying why none can be made. A source's
 * variable holds its engine's URL, the engine read from the example's name; DATABASE_URL in an
 * example named after no engine is the Postgres the store lives in. Any other variable (a plugin's
 * token, a webhook's secret) is only named at load, never read, and holds a placeholder.
 */
function environmentOf(
  name: string,
  example: string,
  text: string,
): { env: Record<string, string> } | { failure: string } {
  const { all, databases } = variablesOf(text);
  const engine = DATABASE_URLS[example.slice(example.lastIndexOf("-") + 1)];
  const env: Record<string, string> = {};
  for (const variable of all) {
    env[variable] = `placeholder-${variable.toLowerCase()}`;
  }
  for (const variable of databases) {
    const url = engine ?? (variable === "DATABASE_URL" ? DATABASE_URLS["postgres"] : undefined);
    if (url === undefined) {
      return {
        failure: `${name}: its source reads ${variable}, and the test cannot tell which database that is, since the example's name ends in no engine of DATABASE_URLS; add the engine's placeholder URL to DATABASE_URLS in ${THIS_FILE}`,
      };
    }
    env[variable] = url;
  }
  return { env };
}

/** The first-party plugins under plugins/, by package name: what a config may import besides facetdb. */
async function firstPartyPlugins(): Promise<ReadonlyMap<string, string>> {
  const plugins = new Map<string, string>();
  for (const entry of await readdir(PLUGINS, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest: unknown = JSON.parse(
      await readFile(join(PLUGINS, entry.name, "package.json"), "utf8"),
    );
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      typeof manifest.name === "string"
    ) {
      plugins.set(manifest.name, join(PLUGINS, entry.name));
    }
  }
  return plugins;
}

/** The packages the file imports other than facetdb itself and Node's own. */
function importsOf(text: string): string[] {
  const names = [...text.matchAll(/\bfrom\s+["']([^"'.][^"']*)["']/g)].map((match) => match[1]);
  return [
    ...new Set(
      names.filter(
        (name): name is string =>
          name !== undefined &&
          name !== "facetdb" &&
          !name.startsWith("facetdb/") &&
          !name.startsWith("node:"),
      ),
    ),
  ];
}

/**
 * The runtime names each import statement takes, by the module it names: `{ a, b as c }` takes a
 * and b, a default import takes "default"; `import type`, `type` names and `* as` take none.
 */
function namedImportsOf(text: string): ReadonlyMap<string, readonly string[]> {
  const taken = new Map<string, string[]>();
  // At a line's start only: a comment may quote an import (listings-market's does).
  for (const match of text.matchAll(/^import\s+([^;"']*?)\s+from\s+["']([^"']+)["']/gm)) {
    const clause = (match[1] ?? "").trim();
    const specifier = match[2] ?? "";
    if (clause.startsWith("type ")) {
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = (braces?.[1] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "" && !item.startsWith("type "))
      .map((item) => item.split(/\s+as\s+/)[0] ?? item);
    const before = (braces === null ? clause : clause.slice(0, braces.index))
      .replace(/,\s*$/, "")
      .trim();
    if (before !== "" && !before.startsWith("*")) {
      names.push("default");
    }
    taken.set(specifier, [...(taken.get(specifier) ?? []), ...names]);
  }
  return taken;
}

/**
 * The names the file imports that the module it names no longer exports, as the project resolves
 * each module (facetdb and the linked plugins). Under vitest a missing named import is undefined;
 * in a user's Node it is a SyntaxError before the file runs, so it is judged here, by the name.
 */
async function missingImports(project: string, text: string): Promise<string[]> {
  const resolve = createRequire(join(project, "facetdb.config.ts")).resolve;
  const missing: string[] = [];
  for (const [specifier, names] of namedImportsOf(text)) {
    if (specifier.startsWith(".") || specifier.startsWith("node:")) {
      continue;
    }
    const exported: Record<string, unknown> = await import(
      /* @vite-ignore */ pathToFileURL(resolve(specifier)).href
    );
    for (const name of names) {
      if (!(name in exported)) {
        missing.push(`${name} from ${specifier}`);
      }
    }
  }
  return missing;
}

/** Loads one frozen config in a project of its own: undefined when it passes, else the failure. */
async function checkOne(
  name: string,
  file: string,
  accepted: AcceptedRefusals,
  plugins: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const text = await readFile(file, "utf8");
  const environment = environmentOf(name, name.slice(name.indexOf("/") + 1), text);
  if ("failure" in environment) {
    return environment.failure;
  }
  const project = await mkdtemp(join(tmpdir(), "facetdb-released-"));
  try {
    await mkdir(join(project, "node_modules"));
    await symlink(packageDir, join(project, "node_modules", "facetdb"));
    for (const imported of importsOf(text)) {
      const plugin = plugins.get(imported);
      if (plugin === undefined) {
        return `${name}: imports ${imported}, which is no first-party plugin under plugins/; a released example imports only facetdb and the first-party plugins, so fix the regression that took that plugin away`;
      }
      await mkdir(dirname(join(project, "node_modules", imported)), { recursive: true });
      await symlink(plugin, join(project, "node_modules", imported));
    }
    await writeFile(join(project, "facetdb.config.ts"), text);
    const missing = await missingImports(project, text);
    if (missing.length > 0) {
      return `${name}: imports ${missing.join(", ")}, which is no longer exported; in a user's Node the file stops at its import (SyntaxError) before FacetDB can say how to fix it, so fix the regression: export the name again`;
    }
    let refusal: readonly string[] = [];
    try {
      await loadConfig("facetdb.config.ts", {
        projectDir: project,
        env: environment.env,
        stderr: { write: () => true },
        quiet: true,
      });
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        return `${name}: does not load, and a config a released version shipped either loads or is refused through ConfigError with the fix in its words; fix the regression:\n  ${String(error)}`;
      }
      refusal = error.issues.map((issue) =>
        issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
      );
    }
    return judged(name, refusal, accepted[name]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

/** The outcome against its entry in the table: loaded and unlisted, or refused exactly as listed. */
function judged(
  name: string,
  refusal: readonly string[],
  entry: readonly string[] | undefined,
): string | undefined {
  const lines = (issues: readonly string[]) => issues.map((issue) => `\n    ${issue}`).join("");
  if (entry === undefined) {
    return refusal.length === 0
      ? undefined
      : `${name}: the loader refuses this config, which that version shipped as an example, and ACCEPTED_REFUSALS has no entry for it:${lines(refusal)}\n  A user who started from this example has this file. If the refusal is a regression, fix the loader so the config loads again. If it is intended, make sure each line says how to fix the config, then add "${name}": [those lines, word for word] to ACCEPTED_REFUSALS in ${THIS_FILE}.`;
  }
  if (refusal.length === 0) {
    return `${name}: loads, and ACCEPTED_REFUSALS still lists a refusal for it; remove its entry from ${THIS_FILE}`;
  }
  if (refusal.length === entry.length && refusal.every((issue, index) => issue === entry[index])) {
    return undefined;
  }
  return `${name}: the loader refuses this config with other words than its entry in ACCEPTED_REFUSALS. It now says:${lines(refusal)}\n  The entry says:${lines(entry)}\n  If the new words are intended and each says how to fix the config, write them in the entry in ${THIS_FILE}; otherwise fix the regression.`;
}

async function directoriesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A version as `release.sh` writes it: `0.1.0`, `0.1.0-rc.1`; never `v0.1.0`. */
const BARE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * Every frozen config under `root` (`<version>/<example>/facetdb.config.ts`) judged against
 * `accepted`: the failures, each naming the version and the example; none when all pass. A folder
 * not named by a bare version fails, as do a version with no example and an entry of the table that
 * names no frozen config.
 */
async function checkReleased(root: string, accepted: AcceptedRefusals): Promise<string[]> {
  const plugins = await firstPartyPlugins();
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const version of await directoriesIn(root)) {
    if (!BARE_VERSION.test(version)) {
      failures.push(
        `${version}: is not a bare version such as 0.1.0 or 0.1.0-rc.1; release.sh freeze and tag name a version's folder by the version alone, so rename the folder to it`,
      );
      continue;
    }
    const examples = await directoriesIn(join(root, version));
    if (examples.length === 0) {
      failures.push(
        `${version}: holds no example; release.sh freeze ${version} writes one folder per example, so freeze it again`,
      );
    }
    for (const example of examples) {
      const name = `${version}/${example}`;
      seen.add(name);
      const file = join(root, version, example, "facetdb.config.ts");
      const present = await readFile(file, "utf8").then(
        () => true,
        () => false,
      );
      const failure = present
        ? await checkOne(name, file, accepted, plugins)
        : `${name}: has no facetdb.config.ts; release.sh freeze ${version} writes one into every example's folder, so freeze it again`;
      if (failure !== undefined) {
        failures.push(failure);
      }
    }
  }
  for (const name of Object.keys(accepted)) {
    if (!seen.has(name)) {
      failures.push(
        `${name}: ACCEPTED_REFUSALS lists it, and no such frozen config exists; remove its entry from ${THIS_FILE}`,
      );
    }
  }
  return failures;
}

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A fixture set built in a temporary directory: `{ "<version>/<example>": config text }`; an
 * example whose text is undefined is a folder with no config.
 */
async function releasedSet(configs: Readonly<Record<string, string | undefined>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "facetdb-released-set-"));
  scratch.push(root);
  for (const [name, text] of Object.entries(configs)) {
    await mkdir(join(root, name), { recursive: true });
    if (text !== undefined) {
      await writeFile(join(root, name, "facetdb.config.ts"), text);
    }
  }
  return root;
}

/** A listings config whose source carries `fields`; lastChanged on Postgres is refused. */
const listings = (fields: string) => `import { env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: env("DATABASE_URL"),
      table: "listings",
      ${fields}
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});
`;

const LAST_CHANGED_REFUSAL =
  'sources[0].lastChanged: only a polled table reads lastChanged, and FacetDB watches this postgres: database by its trigger; remove lastChanged, or set connector: "polling" if the host forbids triggers';

/** The version the examples as they stand are checked under: a pre-release no freeze writes. */
const NEXT = "0.0.0-examples";

describe("every example config of a released version", () => {
  it("loads, or is refused exactly as ACCEPTED_REFUSALS lists it with its fix", async () => {
    const failures = await checkReleased(RELEASED, ACCEPTED_REFUSALS);
    expect(failures, failures.join("\n\n")).toEqual([]);
  });

  it("the examples as they stand load, as the next freeze will copy them", async () => {
    // Every folder under examples/ is one, as the freeze sees them; one with no config is a
    // folder alone, which the check reports.
    const examples = await directoriesIn(EXAMPLES);
    expect(
      examples,
      "no folder under packages/facetdb/examples: nothing would be checked",
    ).not.toEqual([]);
    const configs: Record<string, string | undefined> = {};
    for (const example of examples) {
      configs[`${NEXT}/${example}`] = await readFile(
        join(EXAMPLES, example, "facetdb.config.ts"),
        "utf8",
      ).catch(() => undefined);
    }
    const failures = await checkReleased(await releasedSet(configs), {});
    expect(
      failures,
      `an example as it stands must load, since release.sh freeze copies it as it is:\n\n${failures.join("\n\n")}`,
    ).toEqual([]);
  });
});

describe("the check itself, on a fixture set built in a temporary directory", () => {
  it("passes a config that loads and a refusal listed with its fix; fails one not listed, naming the version, the example and the refusal", async () => {
    const root = await releasedSet({
      "0.0.1/loads": listings(""),
      "0.0.1/refused-listed": listings('lastChanged: "changed_on",'),
      "0.0.1/refused-unlisted": listings('lastChanged: "changed_on",'),
    });
    const failures = await checkReleased(root, {
      "0.0.1/refused-listed": [LAST_CHANGED_REFUSAL],
    });
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure).toContain(
      "0.0.1/refused-unlisted: the loader refuses this config, which that version shipped as an example, and ACCEPTED_REFUSALS has no entry for it:",
    );
    expect(failure).toContain(`\n    ${LAST_CHANGED_REFUSAL}\n`);
    expect(failure).toContain(
      `add "0.0.1/refused-unlisted": [those lines, word for word] to ACCEPTED_REFUSALS in ${THIS_FILE}`,
    );
  });

  it("fails a refusal whose words differ from its entry, a stale entry and a version with no example", async () => {
    const root = await releasedSet({
      "0.0.1/refused": listings('lastChanged: "changed_on",'),
      "0.0.1/loads": listings(""),
    });
    await mkdir(join(root, "0.0.2"));
    const failures = await checkReleased(root, {
      "0.0.1/refused": ["sources[0].lastChanged: remove lastChanged"],
      "0.0.1/loads": [LAST_CHANGED_REFUSAL],
      "0.0.1/gone": [LAST_CHANGED_REFUSAL],
    });
    expect(failures.map((failure) => failure.slice(0, failure.indexOf(":")))).toEqual([
      "0.0.1/loads",
      "0.0.1/refused",
      "0.0.2",
      "0.0.1/gone",
    ]);
    const [stale, differs, empty, gone] = failures;
    expect(stale).toBe(
      `0.0.1/loads: loads, and ACCEPTED_REFUSALS still lists a refusal for it; remove its entry from ${THIS_FILE}`,
    );
    expect(differs).toContain(`It now says:\n    ${LAST_CHANGED_REFUSAL}\n`);
    expect(differs).toContain("The entry says:\n    sources[0].lastChanged: remove lastChanged\n");
    expect(empty).toBe(
      "0.0.2: holds no example; release.sh freeze 0.0.2 writes one folder per example, so freeze it again",
    );
    expect(gone).toBe(
      `0.0.1/gone: ACCEPTED_REFUSALS lists it, and no such frozen config exists; remove its entry from ${THIS_FILE}`,
    );
  });

  it("fails a config that does not load at all, such as one importing a file of its own, which is never frozen", async () => {
    const root = await releasedSet({
      "0.0.1/own-file": listings("")
        .replace(
          'import { env, facetdb, noul } from "facetdb";',
          'import { env, facetdb, noul } from "facetdb";\nimport { question } from "./questions.ts";',
        )
        .replace('"Is this listing a scam?"', "question"),
    });
    const failures = await checkReleased(root, {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      "0.0.1/own-file: does not load, and a config a released version shipped either loads or is refused through ConfigError with the fix in its words; fix the regression:",
    );
    expect(failures[0]).toContain("questions.ts");
  });

  it("fails a config importing a name facetdb or a plugin no longer exports, even one it never calls", async () => {
    const root = await releasedSet({
      "0.0.1/import-gone": listings("").replace(
        'import { env, facetdb, noul } from "facetdb";',
        'import { github } from "@facetdb/github";\nimport { env, facetdb, noul, retired, type ProjectConfig } from "facetdb";\nimport { gone as alias } from "@facetdb/slack";',
      ),
    });
    expect(await checkReleased(root, {})).toEqual([
      "0.0.1/import-gone: imports retired from facetdb, gone from @facetdb/slack, which is no longer exported; in a user's Node the file stops at its import (SyntaxError) before FacetDB can say how to fix it, so fix the regression: export the name again",
    ]);
  });

  it("fails a version folder whose name is not the bare version", async () => {
    const root = await releasedSet({
      "v0.1.0/loads": listings(""),
      "0.1.0-rc.1/loads": listings(""),
    });
    expect(await checkReleased(root, {})).toEqual([
      "v0.1.0: is not a bare version such as 0.1.0 or 0.1.0-rc.1; release.sh freeze and tag name a version's folder by the version alone, so rename the folder to it",
    ]);
  });
});
