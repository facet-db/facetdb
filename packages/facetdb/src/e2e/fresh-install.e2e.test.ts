import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// biome-ignore lint/style/noRestrictedImports: the engine list is the CLI's own table, and the test must follow it, not a copy (a tenth engine would otherwise escape it); cli/ has no barrel.
import { EXAMPLE_ENGINES } from "../cli/examples.ts";

/**
 * The packed tarballs in a fresh project outside the workspace. `scripts/pack-check.sh` builds and
 * packs every publishable package into a folder under $TMPDIR; a project in another folder there
 * depends on every one of them (`facetdb`, the `@facetdb/*` packages it needs and the five
 * first-party plugins), each overridden to its `file:` tarball, and installs with `pnpm install
 * --offline` from the local pnpm store and metadata cache, unhoisted (`hoist: false`), so a
 * tarball's undeclared runtime import fails here. Then the installed bin runs as a user runs it:
 * `--version`, `init`, the listings example of every engine with `types`, `doctor --dry-run` (which
 * loads every engine's module), `dev --dry-run` on the GitHub triage example and on a config naming
 * all five plugins (the plugin host imports each from the project, binds an action, three alert
 * channels and a pack: no network, no database), and `dev` on the embedded database with the
 * scripted fake provider until the seeded rows are answered, its studio fetched, then stopped with
 * SIGINT. No output of the bin names the workspace, warns, or trips Node's refusal to strip types
 * under node_modules; no file of a tarball names the workspace; the install prints no missing peer
 * (its [WARN] lines about the metadata cache's missing "time" field are the local cache's, not the
 * tarballs'); every package resolves to its tarball's copy inside the project.
 *
 * What it does not prove: another machine, another Node or another OS, and npm (no npm cache
 * offline). It needs no network: pnpm runs with --offline and corepack with
 * COREPACK_ENABLE_NETWORK=0, and a package missing from the store or the metadata cache fails with
 * `pnpm install` in the workspace as the fix. pnpm writes to its store outside the workspace, so
 * the run needs a shell that may write there. A failed run keeps both folders and prints where they
 * are; a passing one deletes them.
 */

const REPOSITORY = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** Node's refusal to load a `.ts` file from node_modules: a tarball whose JavaScript names a source. */
const TYPE_STRIPPING_REFUSAL = "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING";

/** The rows of the listings example's seed-quick.sql, which dev seeds and answers. */
const QUICK_ROWS = 100;

/** The variables a child keeps from this process; pnpm's own (INIT_CWD, npm_*) and PATH's workspace entries never pass. */
const KEPT = [
  "HOME",
  "TMPDIR",
  "LANG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
] as const;

/** Every secret the plugin configs name, set to a value that reaches nothing. */
const PLUGIN_SECRETS: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: "ghp_fresh0install0dummy0token0000000000000",
  GITHUB_WEBHOOK_SECRET: "fresh-install-dummy-hook-secret",
  SLACK_WEBHOOK_TRIAGE: "https://hooks.slack.com/services/T000/B000/fresh-install-dummy",
  SLACK_BOT_TOKEN: "xoxb-fresh-install-dummy-token",
  TELEGRAM_BOT_TOKEN: "123456789:fresh-install_dummy-token",
  EMAIL_PASSWORD: "fresh-install-dummy-password",
};

/**
 * The smallest project that names every first-party plugin: a GitHub source and a GitHub action,
 * Slack, email and Telegram as alert channels, and the packs plugin. Every secret is a variable's
 * name.
 */
const PLUGINS_CONFIG = `import { github } from "@facetdb/github";
import { env, facetdb, noul } from "facetdb";

export default facetdb({
  source: github.issues({ repo: "acme/shop", include: ["issues"] }),
  read: ["title", "body"],
  model: "jev-1.14.0",
  plugins: {
    github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") },
    slack: { token: env("SLACK_BOT_TOKEN") },
    email: {
      host: "smtp.example.com",
      port: 587,
      user: "alerts@example.com",
      password: env("EMAIL_PASSWORD"),
      from: "alerts@example.com",
    },
    telegram: { token: env("TELEGRAM_BOT_TOKEN") },
    packs: {},
  },
  alerts: { channels: ["slack:#ops", "email:ops@example.com", "telegram:-1001234567890"] },
  questions: { urgent: noul("Is this issue urgent?") },
  actions: [github.label({ repo: "acme/shop", when: { urgent: true }, add: ["urgent"] })],
});
`;

/** One finished command: its exit code and what it printed, both streams in the order they came. */
type Ran = { readonly code: number | null; readonly output: string };

/** The run's folders and facts, set by beforeAll. */
type World = {
  readonly pack: string;
  readonly project: string;
  readonly bin: string;
  readonly install: string;
  /** Every package packed, by name: what the project depends on. */
  readonly packages: readonly string[];
  /** The checkouts this run must not reach: this one, and the main one a worktree belongs to. */
  readonly workspaces: readonly string[];
  /** checkoutState() before the run. */
  readonly before: string;
};

let world: World | undefined;
/** Set when beforeAll or a test fails: the folders are kept for a look. */
let failed = false;
const children = new Set<ChildProcess>();

function the(): World {
  if (world === undefined) {
    throw new Error("the fresh project was not set up (beforeAll failed above)");
  }
  return world;
}

/** The environment of every child: a shell's own, never this test's pnpm run. */
function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEPT) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  // `pnpm run` puts the workspace's node_modules/.bin first; a user's PATH has none of it.
  const workspaces = world?.workspaces ?? [REPOSITORY];
  env["PATH"] = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter(
      (entry) =>
        entry !== "" && !workspaces.some((workspace) => isInside(workspace, resolve(entry))),
    )
    .join(delimiter);
  return { ...env, ...extra };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * What git sees in the checkout's packages, plugins, apps and scripts, ignored files included (a
 * .facetdb/ or a database file left by a command would show here), and any .facetdb/ or tarball
 * elsewhere; less the build output pack-check makes (every publishable package's dist/ and tsc's
 * build info, rebuilt as `pnpm build` does) and node_modules/, where pnpm keeps the state of each
 * script it runs. The rest of the root is not this test's to judge: an editor or a tool can write
 * there beside any run.
 */
async function checkoutState(): Promise<string> {
  const status = await run(
    "git",
    ["-C", REPOSITORY, "status", "--porcelain", "--ignored", "--untracked-files=all"],
    REPOSITORY,
    process.env,
  );
  if (status.code !== 0) {
    throw new Error(shown("git status", status));
  }
  return status.output
    .split("\n")
    .filter((line) => {
      const path = line.slice(3);
      return (
        (/^(packages|plugins|apps|scripts)\//.test(path) ||
          /(^|\/)\.facetdb\/|\.tgz$/.test(path)) &&
        !/(^|\/)(dist|node_modules)\/|\.tsbuildinfo$/.test(path)
      );
    })
    .join("\n");
}

/** Every file under a folder, by its path. */
async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Starts a command; `run` waits for it, `dev` reads it as it goes. */
function start(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const ended = new Promise<Ran>((done, refused) => {
    child.on("error", refused);
    child.on("close", (code) => {
      children.delete(child);
      done({ code, output });
    });
  });
  return { child, output: () => output, ended };
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Ran> {
  return start(command, args, cwd, env).ended;
}

/** The installed bin, as `npx facetdb` or `pnpm facetdb` runs it in the user's project. */
function facetdb(
  args: readonly string[],
  cwd: string,
  extra?: Readonly<Record<string, string>>,
): Promise<Ran> {
  return run(the().bin, args, cwd, childEnv(extra));
}

/** What a failed expectation shows: the command's whole output. */
function shown(what: string, ran: Ran): string {
  return `${what} exited ${String(ran.code)}:\n${ran.output}`;
}

/** Every output line of the installed bin: no type-stripping refusal, no warning, no workspace path. */
function expectClean(what: string, ran: Ran): void {
  const lines = ran.output.split("\n");
  expect(
    lines.filter((line) => line.includes(TYPE_STRIPPING_REFUSAL)),
    shown(what, ran),
  ).toEqual([]);
  expect(
    lines.filter((line) => /warning/i.test(line)),
    shown(what, ran),
  ).toEqual([]);
  for (const workspace of the().workspaces) {
    expect(
      lines.filter((line) => line.includes(workspace)),
      shown(what, ran),
    ).toEqual([]);
  }
}

/** Resolves once `ready` holds for the output, or fails with the output after `ms`. */
async function waitFor(
  what: string,
  output: () => string,
  ready: (text: string) => boolean,
  exited: Promise<Ran>,
  ms: number,
): Promise<void> {
  let gone: Ran | undefined;
  void exited.then((ran) => {
    gone = ran;
  });
  const until = Date.now() + ms;
  while (!ready(output())) {
    if (gone !== undefined) {
      throw new Error(`${what}: the command ended first\n${shown("facetdb dev", gone)}`);
    }
    if (Date.now() > until) {
      throw new Error(`${what}: not within ${ms} ms\n${output()}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The words of an offline install that lacked a package, and what to do about it. */
const NOT_OFFLINE =
  /ERR_PNPM_NO_OFFLINE_META|ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_NO_MATCHING_VERSION|Network access disabled|COREPACK_ENABLE_NETWORK/;

/** The words of a store pnpm may not write to (a read-only mount, for one). */
const STORE_UNWRITABLE = /EROFS|EACCES|EPERM/;

/** dev's ready line, with the studio served or without it. */
const SERVING =
  /Serving (the studio, its endpoints and the check API|the check API and the studio's endpoints) on (http:\/\/\S+)\./;

beforeAll(async () => {
  try {
    await setUp();
  } catch (error) {
    failed = true;
    throw error;
  }
}, 600_000);

async function setUp(): Promise<void> {
  const root = await realpath(tmpdir());
  if (isInside(REPOSITORY, root)) {
    throw new Error(
      `$TMPDIR (${root}) is inside the workspace; the fresh project must be outside it: set TMPDIR to a folder elsewhere`,
    );
  }
  // The main checkout a worktree belongs to: `git rev-parse --git-common-dir` is its .git.
  const common = await run(
    "git",
    ["-C", REPOSITORY, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    REPOSITORY,
    process.env,
  );
  if (common.code !== 0) {
    throw new Error(shown("git rev-parse --git-common-dir", common));
  }
  const workspaces = [REPOSITORY, dirname(common.output.trim())];
  const before = await checkoutState();

  const pack = await mkdtemp(join(root, "facetdb-pack-"));
  const project = await mkdtemp(join(root, "facetdb-fresh-"));
  world = { pack, project, bin: "", install: "", packages: [], workspaces, before };

  // The tarballs, built clean and checked by scripts/pack-check.sh, kept in `pack`. Built as a
  // release shell builds them: vitest sets NODE_ENV=test, under which Vite bundles the studio with
  // React's development JSX, each element naming its source file's absolute path in the checkout.
  const buildEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_ENV" && !/^VITEST/.test(name)),
  );
  const packed = await run(
    join(REPOSITORY, "scripts", "pack-check.sh"),
    [pack],
    REPOSITORY,
    buildEnv,
  );
  if (packed.code !== 0) {
    throw new Error(shown("scripts/pack-check.sh", packed));
  }
  const tarballs = (await readdir(pack)).filter((file) => file.endsWith(".tgz"));
  const overrides: [string, string][] = [];
  const dependencies: Record<string, string> = {};
  for (const tarball of tarballs) {
    const manifest: unknown = JSON.parse(
      await readFile(
        join(pack, "unpacked", tarball.replace(/\.tgz$/, ""), "package", "package.json"),
        "utf8",
      ),
    );
    const { name, version } = manifest as { readonly name?: unknown; readonly version?: unknown };
    if (typeof name !== "string" || typeof version !== "string") {
      throw new Error(`${tarball}: its package.json has no name or version`);
    }
    overrides.push([name, `file:${join(pack, tarball)}`]);
    dependencies[name] = version;
  }
  if (dependencies["facetdb"] === undefined) {
    throw new Error(`no facetdb tarball in ${pack}`);
  }

  // The same pnpm the workspace pins, so corepack picks the copy it already has.
  const workspaceManifest: unknown = JSON.parse(
    await readFile(join(REPOSITORY, "package.json"), "utf8"),
  );
  const packageManager = (workspaceManifest as { readonly packageManager?: unknown })
    .packageManager;
  if (typeof packageManager !== "string") {
    throw new Error("the workspace's package.json names no packageManager");
  }
  // Every publishable package as a dependency: the five plugins are none of facetdb's, and a user
  // adds them to the project (`facetdb add`), where the plugin host looks for them.
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: "fresh-project", private: true, type: "module", packageManager, dependencies },
      null,
      2,
    )}\n`,
  );
  // pnpm 10 and later read overrides and build approvals from pnpm-workspace.yaml (the package.json
  // "pnpm" field is ignored from pnpm 11). Unhoisted, a package sees only what it declares, so an
  // undeclared runtime import of a tarball fails here instead of resolving from .pnpm/node_modules.
  // oracledb's install script only checks the Node version and FacetDB runs it in thin mode, so its
  // build is denied, as in the workspace.
  await writeFile(
    join(project, "pnpm-workspace.yaml"),
    [
      "hoist: false",
      "overrides:",
      ...overrides.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
      "allowBuilds:",
      "  oracledb: false",
      "",
    ].join("\n"),
  );

  // The workspace's store: $TMPDIR is often another filesystem, where pnpm would pick an empty
  // store of its own instead (no hard links across filesystems); named, pnpm copies from it.
  const store = await run("pnpm", ["store", "path"], REPOSITORY, {
    ...process.env,
    COREPACK_ENABLE_NETWORK: "0",
  });
  if (store.code !== 0) {
    throw new Error(shown("pnpm store path", store));
  }
  const storeDir = store.output.trim();
  const install = await run(
    "pnpm",
    ["install", "--offline", "--store-dir", storeDir],
    project,
    childEnv({ COREPACK_ENABLE_NETWORK: "0" }),
  );
  if (install.code !== 0) {
    if (NOT_OFFLINE.test(install.output)) {
      throw new Error(
        `the offline install lacks a package: the local pnpm store or its metadata cache does not hold every dependency of the tarballs (or corepack lacks ${packageManager}). Run pnpm install in the workspace with the network, then run this test again.\n${shown("pnpm install --offline", install)}`,
      );
    }
    if (STORE_UNWRITABLE.test(install.output)) {
      throw new Error(
        `pnpm cannot write to its store at ${storeDir}: run this test from a shell that may write there.\n${shown("pnpm install --offline", install)}`,
      );
    }
    throw new Error(shown("pnpm install --offline", install));
  }
  world = {
    pack,
    project,
    bin: join(project, "node_modules", ".bin", "facetdb"),
    install: install.output,
    packages: Object.keys(dependencies),
    workspaces,
    before,
  };
}

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    failed = true;
  });
});

afterAll(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  if (world === undefined) {
    return;
  }
  if (failed) {
    console.error(
      `fresh-install: kept for a look, delete both when done:\n  tarballs: ${world.pack} (the build and pack log: ${join(world.pack, "unpacked", "pack.log")})\n  project:  ${world.project}`,
    );
    return;
  }
  await rm(world.pack, { recursive: true, force: true });
  await rm(world.project, { recursive: true, force: true });
});

describe("the packed tarballs in a fresh project outside the workspace", () => {
  it("installs every publishable package from its tarball, offline, with no missing peer", async () => {
    const { project, install, packages, workspaces } = the();
    expect(install, install).not.toMatch(/missing peer|unmet peer|ERR_PNPM_PEER/i);
    for (const workspace of workspaces) {
      expect(install.includes(workspace), install).toBe(false);
    }
    // Each package as Node resolves it from the project, and each facetdb package facetdb needs
    // as Node resolves it from facetdb.
    const installed = await realpath(join(project, "node_modules", "facetdb"));
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const needed = Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith("@facetdb/"),
    );
    expect(needed.length).toBeGreaterThan(0);
    const paths = [
      ...packages.map((name) => join(project, "node_modules", name)),
      ...needed.map((name) => join(installed, "..", name)),
    ];
    for (const path of paths) {
      const real = await realpath(path);
      expect(isInside(project, real), `${path} resolves to ${real}`).toBe(true);
      expect(real, path).toContain("@file+");
    }
    // Nothing in the virtual store named facetdb came from anywhere but a tarball.
    const store = await readdir(join(project, "node_modules", ".pnpm"));
    const facetdbEntries = store.filter(
      (entry) => entry.startsWith("facetdb@") || entry.startsWith("@facetdb+"),
    );
    expect(facetdbEntries.length).toBeGreaterThanOrEqual(packages.length);
    expect(facetdbEntries.filter((entry) => !entry.includes("@file+"))).toEqual([]);
  });

  it("ships no file that names the workspace", async () => {
    const { pack, workspaces } = the();
    const named: string[] = [];
    for (const file of await filesUnder(join(pack, "unpacked"))) {
      if (file.endsWith(".files") || file.endsWith("pack.log")) {
        continue;
      }
      const bytes = await readFile(file);
      for (const workspace of workspaces) {
        if (bytes.includes(workspace)) {
          named.push(`${relative(pack, file)} names ${workspace}`);
        }
      }
    }
    expect(named).toEqual([]);
  });

  it("prints the installed package's version", async () => {
    const { project } = the();
    const ran = await facetdb(["--version"], project);
    expect(ran.code, shown("facetdb --version", ran)).toBe(0);
    expectClean("facetdb --version", ran);
    const manifest = JSON.parse(
      await readFile(join(project, "node_modules", "facetdb", "package.json"), "utf8"),
    ) as { readonly version: string };
    expect(ran.output.trim()).toBe(manifest.version);
  });

  it("init writes facetdb.config.ts in the project", async () => {
    const { project } = the();
    const ran = await facetdb(
      [
        "init",
        "--database-url",
        "postgres://app:app-password@localhost:5432/app",
        "--table",
        "listings",
        "--triggers",
        "allowed",
        "--skills",
        "none",
      ],
      project,
    );
    expect(ran.code, shown("facetdb init", ran)).toBe(0);
    expectClean("facetdb init", ran);
    const written = await readFile(join(project, "facetdb.config.ts"), "utf8");
    expect(written).toContain('from "facetdb"');
    expect(written).toContain("listings");
  });

  it("copies the listings example of every engine, and types loads each config", async () => {
    const { project } = the();
    for (const engine of EXAMPLE_ENGINES) {
      const folder = join(project, `listings-${engine.name}`);
      await mkdir(folder);
      const init = await facetdb(
        ["init", "--example", "listings", "--engine", engine.name],
        folder,
      );
      expect(
        init.code,
        shown(`facetdb init --example listings --engine ${engine.name}`, init),
      ).toBe(0);
      expectClean(`init --engine ${engine.name}`, init);
      // Every committed file of the example, as the tarball must carry it.
      const shipped = await readdir(
        join(project, "node_modules", "facetdb", "examples", `listings-${engine.name}`),
      );
      expect((await readdir(folder)).sort(), engine.name).toEqual(shipped.sort());
      // The config reads the source's connection string from the environment; the example's own
      // form, with its placeholders filled. Nothing connects: types reads no database.
      const url = engine.workerUrl.replaceAll(/<[^>]*>/g, "x");
      const types = await facetdb(["types"], folder, { [engine.variable]: url });
      expect(types.code, shown(`facetdb types (${engine.name})`, types)).toBe(0);
      expectClean(`types (${engine.name})`, types);
      expect(existsSync(join(folder, "facetdb.types.d.ts")), engine.name).toBe(true);
    }
  }, 180_000);

  it("doctor --dry-run loads every registered engine's module from the tarballs", async () => {
    const { project } = the();
    const ran = await facetdb(["doctor", "--dry-run"], project);
    expect(ran.code, shown("facetdb doctor --dry-run", ran)).toBe(0);
    expectClean("doctor --dry-run", ran);
    // `planned` lists each check name once, the first engine's: these are the names one engine
    // alone has (SQL Server, MongoDB, SQLite, libSQL, CockroachDB).
    const names = [...ran.output.matchAll(/^\d+\. ([^:]+):/gm)].map((match) => match[1]);
    for (const only of ["containment", "replica-set", "wal", "token", "dialect"]) {
      expect(names, ran.output).toContain(only);
    }
  });

  it("dev --dry-run loads the five plugins from the project through the plugin host", async () => {
    const { project } = the();
    // The GitHub triage example as init copies it: the github and slack plugins.
    const triage = join(project, "github-triage");
    await mkdir(triage);
    const init = await facetdb(["init", "--example", "github-triage"], triage);
    expect(init.code, shown("facetdb init --example github-triage", init)).toBe(0);
    expectClean("init --example github-triage", init);
    const shipped = await readdir(
      join(project, "node_modules", "facetdb", "examples", "github-triage"),
    );
    for (const file of shipped) {
      expect(existsSync(join(triage, file)), file).toBe(true);
    }
    // A config naming all five: the host imports each from the project's node_modules
    // (importFromProject), checks its settings, binds the action and the three channels; a plugin
    // that cannot be installed or imported stops the command with exit 1. The dry run opens no
    // database and starts nothing.
    const all = join(project, "plugins");
    await mkdir(all);
    await writeFile(join(all, "facetdb.config.ts"), PLUGINS_CONFIG);
    for (const [what, folder] of [
      ["the GitHub triage example", triage],
      ["the five plugins' config", all],
    ] as const) {
      const ran = await facetdb(["dev", "--dry-run"], folder, PLUGIN_SECRETS);
      expect(ran.code, shown(`facetdb dev --dry-run (${what})`, ran)).toBe(0);
      expectClean(`dev --dry-run (${what})`, ran);
      expect(ran.output, what).toContain("Dry run: nothing was started.");
    }
  }, 120_000);

  it("dev answers the listings example's seeded rows on the embedded database, serves the studio and stops on SIGINT", async () => {
    const { project } = the();
    const folder = join(project, "dev");
    await mkdir(folder);
    const init = await facetdb(["init", "--example", "listings", "--engine", "postgres"], folder);
    expect(init.code, shown("facetdb init --example listings", init)).toBe(0);
    // Port 0: the system picks a free one, and the ready line names it.
    const dev = start(
      the().bin,
      ["dev", "--seed", "seed-quick.sql", "--port", "0"],
      folder,
      childEnv(),
    );
    try {
      await waitFor("the ready line", dev.output, (text) => SERVING.test(text), dev.ended, 180_000);
      const [, served, address] = SERVING.exec(dev.output()) ?? [];
      if (served !== "the studio, its endpoints and the check API" || address === undefined) {
        throw new Error(
          `dev served no studio: the installed @facetdb/studio bundle was not found from the facetdb tarball\n${dev.output()}`,
        );
      }
      // The studio's bundle, from the @facetdb/studio tarball: the page and the script it loads.
      const page = await fetch(`${address}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("<title>FacetDB studio</title>");
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      if (script === undefined) {
        throw new Error(`the studio page loads no script from /assets/:\n${html}`);
      }
      const bundle = await fetch(`${address}${script}`);
      expect(bundle.status).toBe(200);
      expect((await bundle.text()).length).toBeGreaterThan(1000);

      // Every seeded row answered by the scripted fake provider, as the worker reports them.
      expect(dev.output()).toContain(`Queued the ${QUICK_ROWS} rows of public.listings`);
      const answered = (text: string) =>
        [...text.matchAll(/^listings: answered (\d[\d, ]*)$/gm)].reduce(
          (sum, match) => sum + (match[1] ?? "").split(", ").length,
          0,
        );
      await waitFor(
        `all ${QUICK_ROWS} rows answered`,
        dev.output,
        (text) => answered(text) >= QUICK_ROWS,
        dev.ended,
        90_000,
      );
    } finally {
      dev.child.kill("SIGINT");
    }
    const ended = await dev.ended;
    expect(ended.code, shown("facetdb dev", ended)).toBe(0);
    expectClean("facetdb dev", ended);
    expect(ended.output).toContain("Stopped: every claim was settled.");
    expect(ended.output).toContain(
      `listings: answered ${QUICK_ROWS}, already answered 0, failed 0`,
    );
    // The embedded database lives in the project, where dev ran.
    expect(existsSync(join(folder, ".facetdb", "dev"))).toBe(true);
  }, 300_000);

  it("leaves the checkout as it found it, build output aside", async () => {
    expect(await checkoutState()).toBe(the().before);
  });
});
