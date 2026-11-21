import { describe, expect, it } from "vitest";
import { VERSION } from "../../index.ts";
import { action, definePlugin, type Plugin, z } from "../../plugin/index.ts";
import type { Workspace } from "../program.ts";
import { runInProcess } from "../program.ts";
import { DEFAULT_REGISTRY } from "../registry/index.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb add` through the in-process runner: the registry's index is a fake `fetch` or a file of
 * a fake workspace, the package manager a recording runner that makes the plugin importable the way
 * an install would, and no test reaches the network or starts a program.
 */

const PROJECT_DIR = "/work/shop";
const noop = async () => undefined;

const github = definePlugin({
  name: "github",
  version: "1.2.0",
  facetdb: "*",
  config: z.object({ repo: z.string(), token: z.secret() }),
  actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
});

/** Secrets at every depth the manifest's paths can name: nested, in a list, and under a record. */
const relay = definePlugin({
  name: "relay",
  version: "0.3.1",
  facetdb: "*",
  config: z.object({
    auth: z.object({ password: z.secret() }),
    hooks: z.array(z.object({ secret: z.secret() })),
    headers: z.record(z.string(), z.secret()),
  }),
  actions: { send: action({ config: z.object({}), run: noop }) },
});

/** A plugin that no longer supports the running FacetDB, as its own package says. */
const outdated = definePlugin({
  name: "github",
  version: "0.9.0",
  facetdb: ">=99.0.0",
  config: z.object({ token: z.secret() }),
  actions: { label: action({ config: z.object({}), run: noop }) },
});

type Listing = {
  name: string;
  package: string;
  description: string;
  kinds: string[];
  facetdb: string;
  verified: boolean;
  downloads: number;
  [field: string]: unknown;
};

function listing(over: Partial<Listing> = {}): Listing {
  return {
    name: "github",
    package: "@facetdb/github",
    description: "Labels GitHub issues from decisions",
    kinds: ["action"],
    facetdb: "*",
    verified: true,
    downloads: 12034,
    ...over,
  };
}

function indexText(...plugins: Listing[]): string {
  return JSON.stringify({ format: 1, generatedAt: "2026-11-13T09:00:00.000Z", plugins });
}

const GITHUB = listing();
const RELAY = listing({
  name: "relay",
  package: "facetdb-plugin-relay",
  description: "Sends decisions to any HTTP endpoint",
  verified: false,
  downloads: 40,
});
const GITLAB = listing({
  name: "gitlab",
  package: "@facetdb/gitlab",
  description: "Labels GitLab issues from decisions",
  facetdb: ">=99.0.0",
  downloads: 7,
});
const INDEX = indexText(GITHUB, GITLAB, RELAY);

type Options = {
  /** What the project's directory holds, by name. */
  readonly files?: readonly string[];
  /** Web addresses and what they answer; an address not listed cannot be reached. */
  readonly web?: Readonly<Record<string, string>>;
  /** Files that are read (a registry, a package.json), by path from the project's directory. */
  readonly disk?: Readonly<Record<string, string>>;
  /** The project's directory; a workspace member sits below its root. */
  readonly projectDir?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** What installing makes importable, by package name. */
  readonly installs?: Readonly<Record<string, Plugin>>;
  readonly exitCode?: number;
  readonly cannotStart?: boolean;
};

function rig(options: Options = {}) {
  const files = new Set(options.files ?? ["package.json", "pnpm-lock.yaml"]);
  const web: Readonly<Record<string, string>> = { [DEFAULT_REGISTRY]: INDEX, ...options.web };
  const disk = options.disk ?? {};
  const installs = options.installs ?? { "@facetdb/github": github, "facetdb-plugin-relay": relay };
  const fetched: string[] = [];
  const runs: { command: string; args: readonly string[]; cwd: string }[] = [];
  const written: string[] = [];
  const installed = new Map<string, Plugin>();

  const refused = () => Promise.reject(new Error("this test gave the command no workspace"));
  const workspace: Workspace = {
    exists: (path) => Promise.resolve(files.has(path) || path in disk),
    write: (path) => {
      written.push(path);
      return refused();
    },
    writeParts: (path) => {
      written.push(path);
      return refused();
    },
    peek: (path) =>
      Promise.resolve(
        path in disk ? { kind: "file", firstLine: "{" } : ({ kind: "none" } as const),
      ),
    lines: async function* (path) {
      yield* (disk[path] ?? "").split("\n");
    },
    hasClaudeCommand: () => false,
  };

  function run(argv: readonly string[]) {
    return runInProcess(
      argv,
      {
        projectDir: options.projectDir ?? PROJECT_DIR,
        env: options.env ?? {},
        // `facetdb add` reads no config and opens no database.
        loadConfig: () => Promise.reject(new Error("this test gave the command no config")),
        connect: () => {
          throw new Error("this test gave the command no database");
        },
        workspace,
        fetch: (url) => {
          fetched.push(url);
          const text = web[url];
          return text === undefined
            ? Promise.reject(new Error(`getaddrinfo ENOTFOUND ${url}`))
            : Promise.resolve(new Response(text));
        },
        abortAfter: () => new AbortController().signal,
        runCommand: (command, args, { cwd }) => {
          runs.push({ command, args: [...args], cwd });
          if (options.cannotStart === true) {
            return Promise.reject(new Error(`spawn ${command} ENOENT`));
          }
          const code = options.exitCode ?? 0;
          if (code === 0) {
            for (const [name, plugin] of Object.entries(installs)) {
              if (args.includes(name)) {
                installed.set(name, plugin);
              }
            }
          }
          return Promise.resolve(code);
        },
        importPlugin: (specifier) => {
          const plugin = installed.get(specifier);
          return plugin === undefined
            ? Promise.reject(
                Object.assign(new Error(`Cannot find package '${specifier}'`), {
                  code: "ERR_MODULE_NOT_FOUND",
                }),
              )
            : Promise.resolve({ default: plugin });
        },
      },
      COMMANDS,
    );
  }
  return { run, fetched, runs, written };
}

describe("facetdb add with no name lists the registry", () => {
  it("prints each plugin's name, verified mark, downloads and description", async () => {
    const { run, fetched, runs } = rig();
    const result = await run(["add"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fetched).toEqual([DEFAULT_REGISTRY]);
    expect(runs).toEqual([]);
    expect(result.stdout).toContain(`Plugins in the registry at ${DEFAULT_REGISTRY}:`);
    expect(result.stdout).toMatch(/name\s+verified\s+downloads\s+description/);
    expect(result.stdout).toMatch(/github\s+verified\s+12034\s+Labels GitHub issues/);
    expect(result.stdout).toMatch(/relay\s+40\s+Sends decisions/);
    expect(result.stdout).not.toMatch(/relay\s+verified/);
    expect(result.stdout).toContain("Install one with: facetdb add <name>");
  });

  it("--search narrows by name, description and kind, and says when nothing matches", async () => {
    const { run } = rig();
    const byDescription = await run(["add", "--search", "gitlab"]);
    expect(byDescription.stdout).toContain("Matching plugins");
    expect(byDescription.stdout).toContain("gitlab");
    expect(byDescription.stdout).not.toContain("relay");
    const byWords = await run(["add", "--search", "HTTP endpoint"]);
    expect(byWords.stdout).toContain("relay");
    expect(byWords.stdout).not.toMatch(/\bgithub\b/);
    const none = await run(["add", "--search", "zendesk"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("No plugin in the registry");
    expect(none.stdout).toContain('"zendesk"');
  });

  it("--json prints the same list as data", async () => {
    const { run } = rig();
    const result = await run(["add", "--json", "--search", "relay"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      registry: DEFAULT_REGISTRY,
      plugins: [RELAY],
    });
  });

  it("refuses --search together with a name, as a bad invocation", async () => {
    const { run, fetched } = rig();
    const result = await run(["add", "github", "--search", "x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not both");
    expect(fetched).toEqual([]);
  });
});

describe("where the registry is read from", () => {
  const OTHER = "https://plugins.example.com/index.json";
  const LOCAL = "http://127.0.0.1:8080/index.json";
  const other = indexText(listing({ name: "other", package: "facetdb-plugin-other" }));

  it("takes --registry first, then FACETDB_REGISTRY, then the default address", async () => {
    const web = { [OTHER]: other, [LOCAL]: other };
    const flag = rig({ web, env: { FACETDB_REGISTRY: LOCAL } });
    expect((await flag.run(["add", "--registry", OTHER])).stdout).toContain(OTHER);
    expect(flag.fetched).toEqual([OTHER]);
    const variable = rig({ web, env: { FACETDB_REGISTRY: LOCAL } });
    expect((await variable.run(["add"])).stdout).toContain("other");
    expect(variable.fetched).toEqual([LOCAL]);
    const fallback = rig({ web, env: { FACETDB_REGISTRY: "" } });
    await fallback.run(["add"]);
    expect(fallback.fetched).toEqual([DEFAULT_REGISTRY]);
  });

  it("reads a file as the index, relative to the project's directory, and fetches nothing", async () => {
    const { run, fetched } = rig({ disk: { "registry/index.json": other } });
    const result = await run(["add", "--registry", "registry/index.json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("other");
    expect(fetched).toEqual([]);
  });

  it("says the address and names --registry when the index cannot be fetched or found", async () => {
    const { run } = rig();
    const web = await run(["add", "--registry", "https://nowhere.example.com/index.json"]);
    expect(web.code).toBe(1);
    expect(web.stderr).toContain("https://nowhere.example.com/index.json");
    expect(web.stderr).toContain("--registry");
    const file = await run(["add", "--registry", "missing.json"]);
    expect(file.code).toBe(1);
    expect(file.stderr).toContain("missing.json");
    expect(file.stderr).toContain("the registry file does not exist");
    expect(file.stderr).toContain("--registry");
  });

  it("reads plain http only on this machine, and asks nothing of any other scheme", async () => {
    const { run, fetched } = rig({ web: { "http://registry.example.com/index.json": other } });
    for (const address of [
      "http://registry.example.com/index.json",
      "ftp://registry.example.com/index.json",
      "file:///etc/passwd",
    ]) {
      const result = await run(["add", "--registry", address]);
      expect(result.code, address).toBe(1);
      expect(result.stderr, address).toContain("--registry");
    }
    expect(fetched).toEqual([]);
    const local = rig({ web: { [LOCAL]: other } });
    expect((await local.run(["add", "--registry", LOCAL])).code).toBe(0);
  });

  it("refuses an index in a newer format with a request to upgrade, and names the address", async () => {
    const newer = JSON.stringify({
      format: 2,
      generatedAt: "2027-01-01T00:00:00.000Z",
      plugins: [],
    });
    const { run } = rig({ web: { [OTHER]: newer } });
    const result = await run(["add", "--registry", OTHER]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(OTHER);
    expect(result.stderr).toContain("upgrade facetdb");
  });

  /** Values that carry a secret and are not a usable address: credentials, a scheme slip, a share. */
  const SECRET_BEARING = [
    "https://alice:hunter2@registry.example.com/index.json",
    "ftp://registry.example.com/index.json?token=abc123",
    "javascript:alert('hunter2')",
    // Mistyped web addresses, which a file path must not be taken for.
    "https//ops:hunter2@registry.example.com/index.json",
    "//ops:hunter2@registry.example.com/x",
    "registry.example.com/index.json?token=hunter2",
    "https:/ops:hunter2@registry.example.com/index.json",
    "registry.example.com/index.json#hunter2",
    // A network share.
    "\\\\ops:hunter2@registry.example.com\\share\\index.json",
  ];

  it("refuses an address with credentials, a mistyped scheme or no meaning before fetching it, never echoing it, naming where it was set", async () => {
    const { run, fetched } = rig();
    for (const address of SECRET_BEARING) {
      for (const argv of [
        ["add", "--registry", address],
        ["add", "github", "--registry", address],
      ]) {
        const result = await run(argv);
        expect(result.code, address).toBe(1);
        expect(result.stderr, address).toContain(
          "the --registry of facetdb add is not an address FacetDB can read",
        );
        expect(result.stderr, address).not.toContain("FACETDB_REGISTRY is not");
        expect(result.stderr, address).not.toMatch(/hunter2|alice|abc123|registry\.example\.com/);
      }
      // The same value from the variable: it is the variable the words name.
      const named = rig({ env: { FACETDB_REGISTRY: address } });
      const result = await named.run(["add"]);
      expect(result.code, address).toBe(1);
      expect(result.stderr, address).toContain(
        "FACETDB_REGISTRY is not an address FacetDB can read",
      );
      expect(result.stderr, address).not.toMatch(/hunter2|alice|abc123|registry\.example\.com/);
      expect(result.stdout, address).not.toContain("hunter2");
      expect(named.fetched).toEqual([]);
    }
    expect(fetched).toEqual([]);
  });

  it("shows the address without its query, fragment or credentials, and says nothing a failure quotes", async () => {
    const address = "https://registry.example.com/index.json?token=abc123#frag";
    const { run } = rig({ web: { [address]: indexText(listing({ [`${address}`]: 1 })) } });
    const quoted = await run(["add", "--registry", address]);
    expect(quoted.code).toBe(1);
    expect(quoted.stderr).toContain("https://registry.example.com/index.json");
    expect(quoted.stderr).not.toMatch(/abc123|frag/);
    // The fetch itself fails, quoting the whole address as an HTTP library may.
    const down = await run([
      "add",
      "--registry",
      "https://registry.example.com/other.json?token=abc123",
    ]);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("the registry could not be reached");
    expect(down.stderr).not.toMatch(/abc123|ENOTFOUND/);
  });

  it("lists a registry named by FACETDB_REGISTRY as a file, and trims it", async () => {
    const { run, fetched } = rig({
      env: { FACETDB_REGISTRY: "  registry/index.json " },
      disk: { "registry/index.json": other },
    });
    const result = await run(["add"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("registry at registry/index.json:");
    expect(fetched).toEqual([]);
  });

  it("treats the index's text as data: a field that is not what it says is refused, and no control character reaches the terminal", async () => {
    const clearScreen = "\u001b[2J";
    for (const hostile of [
      listing({ description: `Labels${clearScreen} issues` }),
      listing({ [`${clearScreen}extra`]: "x" }),
    ]) {
      const { run, runs } = rig({ web: { [DEFAULT_REGISTRY]: indexText(hostile) } });
      for (const argv of [["add"], ["add", "github"]]) {
        const result = await run(argv);
        expect(result.code).toBe(1);
        expect(result.stderr).not.toContain("\u001b");
        expect(result.stdout).not.toContain("\u001b");
      }
      expect(runs).toEqual([]);
    }
  });
});

describe("facetdb add <name> refuses before it runs anything", () => {
  it("lists the nearest names for an unknown one and stops", async () => {
    const { run, runs } = rig();
    const result = await run(["add", "githb"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lists no plugin named "githb"');
    expect(result.stderr).toContain("the nearest names are github, gitlab");
    expect(result.stderr).toContain("fix: run facetdb add github");
    expect(runs).toEqual([]);
    const far = await run(["add", "zendesk"]);
    expect(far.code).toBe(1);
    expect(far.stderr).not.toContain("nearest");
    expect(far.stderr).toContain("run facetdb add to list every plugin");
  });

  it("refuses a core range this FacetDB does not satisfy, naming both", async () => {
    const { run, runs } = rig();
    const result = await run(["add", "gitlab"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `the plugin "gitlab" supports FacetDB >=99.0.0, but this is FacetDB ${VERSION}`,
    );
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/plugin-core-version");
    expect(runs).toEqual([]);
  });

  it("takes a name only as the loader names a plugin, before the network is asked", async () => {
    const { run, fetched } = rig();
    for (const name of ["GitHub", "git hub", "../x", "-rf"]) {
      const result = await run(["add", name]);
      expect(result.code, name).toBe(2);
    }
    expect(fetched).toEqual([]);
  });

  it("accepts the package name the registry lists, and refuses another package for the name", async () => {
    const { run, runs } = rig();
    expect((await run(["add", "@facetdb/github", "--dry-run"])).code).toBe(0);
    const wrong = await run(["add", "facetdb-plugin-github"]);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('lists "github" as the package @facetdb/github');
    expect(runs).toEqual([]);
  });

  it("never hands the package manager a package name the loader's rule does not allow", async () => {
    const bad = indexText(listing({ package: "@facetdb/github; rm -rf ~" }));
    const { run, runs } = rig({ web: { [DEFAULT_REGISTRY]: bad } });
    const result = await run(["add", "github"]);
    expect(result.code).toBe(1);
    expect(runs).toEqual([]);
  });

  it("needs a package.json in the project's directory", async () => {
    const { run, runs } = rig({ files: ["pnpm-lock.yaml"] });
    const result = await run(["add", "github"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`there is no package.json in ${PROJECT_DIR}`);
    expect(runs).toEqual([]);
  });
});

describe("facetdb add <name> shows the command, then runs it", () => {
  it.each([
    [["pnpm-lock.yaml"], "pnpm", ["add"]],
    [["yarn.lock"], "yarn", ["add"]],
    [["bun.lock"], "bun", ["add"]],
    [["bun.lockb"], "bun", ["add"]],
    [["package-lock.json"], "npm", ["install"]],
    [["npm-shrinkwrap.json"], "npm", ["install"]],
    [[], "npm", ["install"]],
  ] as const)("with the lockfiles %j it runs %s", async (lockfiles, program, verb) => {
    const { run, runs } = rig({ files: ["package.json", ...lockfiles] });
    const result = await run(["add", "github"]);
    expect(result.code, result.stderr).toBe(0);
    const line = `${program} ${verb.join(" ")} @facetdb/github`;
    expect(result.stdout).toContain(`Running, in ${PROJECT_DIR}: ${line}`);
    expect(runs).toEqual([
      { command: program, args: [...verb, "@facetdb/github"], cwd: PROJECT_DIR },
    ]);
    if (lockfiles.length === 0) {
      expect(result.stdout).toContain(
        `no lockfile and no packageManager from ${PROJECT_DIR} up to`,
      );
    }
  });

  describe("in a workspace member, below the root that holds the lockfile", () => {
    const MEMBER = "/work/shop/packages/app";

    it("finds the root's lockfile above the member, and says which file decided", async () => {
      const { run, runs } = rig({
        projectDir: MEMBER,
        files: ["package.json", "../../pnpm-lock.yaml"],
      });
      const result = await run(["add", "github"]);
      expect(result.code, result.stderr).toBe(0);
      expect(runs).toEqual([{ command: "pnpm", args: ["add", "@facetdb/github"], cwd: MEMBER }]);
      expect(result.stdout).toContain("found /work/shop/pnpm-lock.yaml, so pnpm");
    });

    it("honours the packageManager of the nearest package.json that declares one, before a lockfile", async () => {
      const { run, runs } = rig({
        projectDir: MEMBER,
        files: ["package.json", "../../package-lock.json"],
        disk: {
          "package.json": JSON.stringify({ name: "app" }),
          "../../package.json": JSON.stringify({ packageManager: "yarn@4.1.0+sha512.abc" }),
        },
      });
      const result = await run(["add", "github"]);
      expect(result.code, result.stderr).toBe(0);
      expect(runs[0]?.command).toBe("yarn");
      expect(result.stdout).toContain(
        "/work/shop/package.json declares yarn as its packageManager, so yarn",
      );
      // The text of the field is data: only the name of one of the four is taken from it.
      expect(result.stdout).not.toContain("sha512");
    });

    it("ignores a packageManager that names no known program, and a package.json that is not JSON", async () => {
      const { run, runs } = rig({
        projectDir: MEMBER,
        files: ["package.json", "../../yarn.lock"],
        disk: {
          "package.json": "{ not json",
          "../../package.json": JSON.stringify({ packageManager: "rm -rf /@1" }),
        },
      });
      await run(["add", "github"]);
      expect(runs[0]?.command).toBe("yarn");
    });

    it("stops at the nearest .git: a lockfile beyond it is not the project's", async () => {
      const { run, runs } = rig({
        projectDir: MEMBER,
        files: ["package.json", "../.git", "../../../pnpm-lock.yaml"],
      });
      const result = await run(["add", "github"]);
      expect(runs[0]?.command).toBe("npm");
      expect(result.stdout).toContain(
        `no lockfile and no packageManager from ${MEMBER} up to /work/shop/packages`,
      );
    });

    it("takes the nearest lockfile when the member has its own", async () => {
      const { run, runs } = rig({
        projectDir: MEMBER,
        files: ["package.json", "yarn.lock", "../../pnpm-lock.yaml"],
      });
      await run(["add", "github"]);
      expect(runs[0]?.command).toBe("yarn");
    });
  });

  it("uses the first lockfile when a project holds several, and says so", async () => {
    const { run, runs } = rig({ files: ["package.json", "yarn.lock", "package-lock.json"] });
    const result = await run(["add", "github"]);
    expect(runs[0]?.command).toBe("yarn");
    expect(result.stdout).toContain("package-lock.json is there too");
  });

  it("prints the command line before the program runs, and again to the end when it fails", async () => {
    const { run, runs } = rig({ cannotStart: true });
    const result = await run(["add", "github"]);
    expect(runs).toHaveLength(1);
    // The runner rejected, and the line was already on the screen.
    expect(result.stdout).toContain(`Running, in ${PROJECT_DIR}: pnpm add @facetdb/github`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pnpm could not be started");
    expect(result.stderr).toContain("run the command above yourself");
  });

  it("prints the command first and the installed plugin's lines after", async () => {
    const { run } = rig();
    const result = await run(["add", "github"]);
    const shown = result.stdout.indexOf("Running, in");
    const loaded = result.stdout.indexOf("Installed @facetdb/github");
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(shown);
  });

  it("--dry-run prints the command and runs nothing", async () => {
    const { run, runs, written } = rig();
    const result = await run(["add", "github", "--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Would run, in ${PROJECT_DIR}: pnpm add @facetdb/github`);
    expect(result.stdout).toContain("Dry run: nothing was installed.");
    expect(runs).toEqual([]);
    expect(written).toEqual([]);
    const json = await run(["add", "github", "--dry-run", "--json"]);
    const data = JSON.parse(json.stdout) as {
      dryRun: boolean;
      install: { command: string; ran: boolean };
    };
    expect(data.dryRun).toBe(true);
    expect(data.install).toEqual({
      packageManager: "pnpm",
      command: "pnpm add @facetdb/github",
      ran: false,
    });
    expect(runs).toEqual([]);
  });

  it("says when the plugin is not verified, and when it is", async () => {
    const { run } = rig({ files: ["package.json"] });
    const unverified = await run(["add", "relay", "--dry-run"]);
    expect(unverified.stdout).toContain("It is not verified");
    expect(unverified.stdout).toContain("install only plugins you trust");
    const verified = await run(["add", "github", "--dry-run"]);
    expect(verified.stdout).toContain("It is verified");
  });

  it("lets only the default registry speak for the FacetDB team", async () => {
    const OTHER = "https://plugins.example.com/index.json";
    const { run } = rig({ web: { [OTHER]: INDEX } });
    const other = await run(["add", "github", "--dry-run", "--registry", OTHER]);
    expect(other.code, other.stderr).toBe(0);
    expect(other.stdout).toContain(
      `The registry at ${OTHER} marks it verified; that is the registry's word, not the FacetDB team's.`,
    );
    expect(other.stdout).not.toContain("the FacetDB team has reviewed it");
    const file = rig({ disk: { "registry/index.json": INDEX } });
    const local = await file.run([
      "add",
      "github",
      "--dry-run",
      "--registry",
      "registry/index.json",
    ]);
    expect(local.stdout).toContain("The registry at registry/index.json marks it verified");
    const official = await run(["add", "github", "--dry-run"]);
    expect(official.stdout).toContain("It is verified: the FacetDB team has reviewed it.");
  });

  it("says, before it runs, that installing runs install scripts and loading the plugin runs its code", async () => {
    const { run } = rig();
    const dry = await run(["add", "github", "--dry-run"]);
    expect(dry.stdout).toContain(
      "would download @facetdb/github from npm and run its install scripts",
    );
    expect(dry.stdout).toContain("which runs its code");
    const result = await run(["add", "github"]);
    const said = result.stdout.indexOf(
      "downloads @facetdb/github from npm and runs its install scripts",
    );
    expect(said).toBeGreaterThanOrEqual(0);
    expect(result.stdout.indexOf("which runs its code")).toBeGreaterThan(said);
    expect(result.stdout.indexOf("Running, in")).toBeGreaterThan(said);
  });

  it("stops with the fix when the program ends with a failure, and prints no lines to paste", async () => {
    const { run } = rig({ exitCode: 1 });
    const result = await run(["add", "github"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pnpm add @facetdb/github ended with exit code 1");
    expect(result.stderr).toContain("run facetdb add github again");
    expect(result.stdout).not.toContain("Installed");
  });
});

describe("after the install, facetdb add prints the lines to paste and writes no file", () => {
  it("prints the import, the plugins entry with each secret as env(), and what the plugin provides", async () => {
    const { run, written } = rig();
    const result = await run(["add", "github"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed @facetdb/github 1.2.0. It provides actions: label.");
    expect(result.stdout).toContain('  import { env } from "facetdb";');
    expect(result.stdout).toContain(
      ["  plugins: {", "    github: {", '      token: env("GITHUB_TOKEN"),', "    },", "  },"].join(
        "\n",
      ),
    );
    expect(result.stdout).toContain(
      "Set GITHUB_TOKEN where the worker runs, then run facetdb doctor.",
    );
    expect(written).toEqual([]);
  });

  it("names a secret at every depth the manifest lists", async () => {
    const { run } = rig();
    const result = await run(["add", "relay"]);
    expect(result.code, result.stderr).toBe(0);
    for (const text of [
      "relay: {",
      "auth: {",
      '        password: env("RELAY_PASSWORD"),',
      "hooks: [",
      '          secret: env("RELAY_SECRET"),',
      "headers: {",
      '"<name>": env("RELAY_HEADERS"),',
    ]) {
      expect(result.stdout, text).toContain(text);
    }
  });

  it("--json carries the lines as data", async () => {
    const { run } = rig();
    const result = await run(["add", "github", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout) as {
      install: { ran: boolean };
      installed: { package: string; version: string; provides: unknown };
      config: { import: string; variables: string[] };
    };
    expect(data.install.ran).toBe(true);
    expect(data.installed).toEqual({
      package: "@facetdb/github",
      version: "1.2.0",
      provides: { actions: ["label"] },
    });
    expect(data.config.import).toBe('import { env } from "facetdb";');
    expect(data.config.variables).toEqual(["GITHUB_TOKEN"]);
    // The package manager's output and the shown command never share stdout with the JSON.
    expect(result.stderr).toContain("Running, in");
  });

  it("refuses an installed package whose own range does not hold, and one that cannot be found", async () => {
    const old = rig({ installs: { "@facetdb/github": outdated } });
    const refused = await old.run(["add", "github"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`supports FacetDB >=99.0.0, but this is FacetDB ${VERSION}`);
    // The install took the latest version; the way to take it out is the project's own manager's.
    expect(refused.stderr).toContain(
      `to take it out again, run in ${PROJECT_DIR}: pnpm remove @facetdb/github`,
    );
    for (const [lockfile, removal] of [
      ["yarn.lock", "yarn remove"],
      ["bun.lock", "bun remove"],
      ["package-lock.json", "npm uninstall"],
    ] as const) {
      const other = rig({
        files: ["package.json", lockfile],
        installs: { "@facetdb/github": outdated },
      });
      expect((await other.run(["add", "github"])).stderr).toContain(`${removal} @facetdb/github`);
    }
    const lost = rig({ installs: {} });
    const missing = await lost.run(["add", "github"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      `@facetdb/github was installed, but it cannot be found from ${PROJECT_DIR}`,
    );
  });
});
