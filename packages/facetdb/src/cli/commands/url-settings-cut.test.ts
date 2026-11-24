import type { Clock } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  actionCall,
  type ConfigFiles,
  configFileSource,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  toProjectJson,
  webhook,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { action, BUILTIN_PLUGINS, createPluginHost, definePlugin, z } from "../../plugin/index.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import { hashPassword } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";
import { cutProjectJson, NOT_A_URL, restoreCut, shownText } from "./url-settings-cut.ts";

/**
 * `GET /v1/config` and `GET /v1/plugins` answer every address in a plugin's, a plugin source's or
 * an action's settings as its host, for a signed-in reviewer and the operator alike, and a draft
 * built from either answer applies with the file's addresses kept whole. The worker is `facetdb
 * worker`'s own wiring over an API source on PGlite; the config file and the community plugin are
 * the test's own.
 */

const PROJECT_DIR = "/work/helpdesk";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

/** Each token rides in an address the file writes; none may reach an answer. */
const TOKENS = {
  endpoint: "tok-endpoint-1111",
  privateEndpoint: "tok-private-2222",
  communityUrl: "tok-community-3333",
  mirror: "tok-mirror-4444",
  webhookAction: "tok-action-5555",
  webhookElse: "tok-else-6666",
  actionUrl: "tok-post-7777",
} as const;
const STATUS_KEY = "status-api-key-VALUE-8888";

const OPS = `https://hooks.example.com/in/ops?token=${TOKENS.endpoint}`;
const LAN = `https://10.0.0.5:9000/hook?token=${TOKENS.privateEndpoint}`;
const BASE_URL = `https://status.example.com/api/v2?key=${TOKENS.communityUrl}`;
// A username or password in an address is refused when the config loads, so none is written here.
const MIRROR = `https://mirror.example.com/feed#?access_token=${TOKENS.mirror}`;
const DECISIONS = `https://decisions.example.com/hook/${TOKENS.webhookAction}`;
const OTHERWISE = `https://fallback.example.com/hook?token=${TOKENS.webhookElse}`;
const TARGET = `https://post.example.com/p?token=${TOKENS.actionUrl}`;

/** A community plugin with a non-secret address setting, an editable one, a list and a secret. */
const status = definePlugin({
  name: "status",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({
    baseUrl: z.string(),
    region: z.editable(z.string()),
    mirrors: z.array(z.string()),
    apiKey: z.secret(),
  }),
  actions: {
    post: action({
      config: z.object({ target: z.string(), label: z.string() }),
      run: () => Promise.resolve(),
    }),
  },
});

function configWith(wording: string, region: string): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      webhook: {
        secret: env("FACETDB_WEBHOOK_SECRET"),
        endpoints: { ops: OPS, lan: { url: LAN, allowPrivate: true } },
      },
      status: { baseUrl: BASE_URL, region, mirrors: [MIRROR], apiKey: env("STATUS_KEY") },
    },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["subject"],
        questions: { urgent: noul(wording) },
        actions: [
          webhook({ url: DECISIONS, when: { urgent: true }, else: { url: OTHERWISE } }),
          actionCall("facetdb-plugin-status", "post", { target: TARGET, label: "urgent" }),
        ],
      },
    ],
  });
}

const INITIAL = configWith("Is this ticket urgent?", "eu");
/** The file once the Questions page's draft is applied: the wording alone changed. */
const REWORDED = configWith("Does this ticket need an answer today?", "eu");
/** And then the Plugins page's draft: `region` alone changed. */
const MOVED = configWith("Does this ticket need an answer today?", "us");

const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  FACETDB_WEBHOOK_SECRET: "whsec_signing-secret-9999",
  STATUS_KEY,
};

function carriesNoToken(text: string): void {
  for (const token of [...Object.values(TOKENS), STATUS_KEY, ENV.FACETDB_WEBHOOK_SECRET]) {
    expect(text).not.toContain(token);
  }
}

describe("the studio's one cut of an address", () => {
  it("answers an address as its host, whatever its scheme, and any other text as it is", () => {
    expect(shownText(OPS)).toBe("hooks.example.com");
    expect(shownText(MIRROR)).toBe("mirror.example.com");
    expect(shownText("wss://stream.example.com:8443/live?key=k")).toBe("stream.example.com:8443");
    expect(shownText("smtps://mail:pw@smtp.example.com")).toBe("smtp.example.com");
    // Text that holds an address the parser does not read is never answered as written.
    expect(shownText("https://exa mple.com/?token=t")).toBe(NOT_A_URL);
    expect(shownText("see https://example.com/?token=t")).toBe(NOT_A_URL);
    // No host, no address: a channel, an email, a repository, a word.
    for (const text of ["slack:#ops", "ops@example.com", "acme/web", "eu", ""]) {
      expect(shownText(text)).toBe(text);
    }
  });

  it("cuts every address of the project JSON's plugins and actions, lists each place, and keeps the rest", () => {
    const shown = cutProjectJson(toProjectJson(INITIAL));

    carriesNoToken(JSON.stringify(shown));
    expect(shown.plugins).toEqual({
      webhook: {
        secret: { env: "FACETDB_WEBHOOK_SECRET" },
        endpoints: { ops: "hooks.example.com", lan: { url: "10.0.0.5:9000", allowPrivate: true } },
      },
      status: {
        baseUrl: "status.example.com",
        region: "eu",
        mirrors: ["mirror.example.com"],
        apiKey: { env: "STATUS_KEY" },
      },
    });
    expect(shown.sources[0]?.actions).toEqual([
      {
        plugin: "@facetdb/webhook",
        action: "send",
        config: {
          url: "decisions.example.com",
          when: { urgent: true },
          else: { url: "fallback.example.com" },
        },
      },
      {
        plugin: "facetdb-plugin-status",
        action: "post",
        config: { target: "post.example.com", label: "urgent" },
      },
    ]);
    expect(shown.hostOnly).toEqual([
      "plugins.webhook.endpoints.ops",
      "plugins.webhook.endpoints.lan.url",
      "plugins.status.baseUrl",
      "plugins.status.mirrors[0]",
      "sources[0].actions[0].config.url",
      "sources[0].actions[0].config.else.url",
      "sources[0].actions[1].config.target",
    ]);
    // The export itself stays whole: drafts and Apply judge against the file.
    expect(JSON.stringify(toProjectJson(INITIAL))).toContain(TOKENS.endpoint);
  });

  it("puts the file's own value back only where a draft carries the very host the cut answered", () => {
    const shown = cutProjectJson(toProjectJson(INITIAL));
    const settings = { ...shown.plugins?.["status"], region: "us" };
    expect(restoreCut(INITIAL, { project: { plugins: { status: settings } } })).toEqual({
      project: {
        plugins: {
          status: {
            baseUrl: BASE_URL,
            region: "us",
            mirrors: [MIRROR],
            apiKey: { env: "STATUS_KEY" },
          },
        },
      },
    });
    // Another value, a list of another length, or a plugin the file does not have: as sent.
    const other = { baseUrl: "elsewhere.example.com", mirrors: ["mirror.example.com", "x"] };
    expect(restoreCut(INITIAL, { project: { plugins: { status: other, more: other } } })).toEqual({
      project: { plugins: { status: other, more: other } },
    });
    const [source] = shown.sources;
    if (source === undefined) {
      throw new Error("the test config has a source");
    }
    const restored = restoreCut(INITIAL, { source });
    expect("source" in restored ? restored.source["actions"] : undefined).toEqual(
      INITIAL.sources[0]?.actions,
    );
  });
});

const CLOCK: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };

let world: PgliteWorld;
let store: Store;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: CLOCK });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

type Answer = { readonly status: number; readonly text: string; readonly json: unknown };

/** One `facetdb worker` run over the test's file, `body` called with its served handler. */
async function serving(
  file: { text: string; writes: number },
  body: (handler: HttpHandler) => Promise<void>,
): Promise<{ readonly code: number; readonly stderr: string }> {
  const stop = new AbortController();
  const files: ConfigFiles = {
    read: () => Promise.resolve({ kind: "file", text: file.text }),
    replace: (_path, text) => {
      file.text = text;
      file.writes += 1;
      return Promise.resolve();
    },
    gitState: () => Promise.resolve({ kind: "clean" }),
  };
  // Only a file that is one of the test's configs loads: a host written for an address would not.
  const loadConfig = () => {
    const found = [INITIAL, REWORDED, MOVED].find(
      (config) => configFileSource(config) === file.text,
    );
    return found === undefined
      ? Promise.reject(new Error("the file holds none of the test's configs"))
      : Promise.resolve(found);
  };
  let failure: unknown;
  const result = await runInProcess(
    ["worker"],
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      osUser: () => "alex",
      setEnv: () => undefined,
      loadConfig,
      configFiles: files,
      connect: (url, options) => world.connect(url, options),
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock: CLOCK,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is sent in these tests")),
      stopSignal: () => stop.signal,
      serve: async (handler, port) => {
        try {
          await body(handler);
        } catch (error) {
          failure = error;
        }
        stop.abort();
        return { port, close: () => Promise.resolve() };
      },
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: ENV,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: (specifier) =>
            specifier === "facetdb-plugin-status"
              ? Promise.resolve({ default: status })
              : Promise.reject(
                  Object.assign(new Error(`Cannot find package '${specifier}'`), {
                    code: "ERR_MODULE_NOT_FOUND",
                  }),
                ),
          builtins: BUILTIN_PLUGINS,
        }),
    },
    COMMANDS,
  );
  if (failure !== undefined) {
    throw failure;
  }
  return result;
}

function caller(handler: HttpHandler) {
  return async (
    method: string,
    path: string,
    options: {
      readonly body?: unknown;
      readonly cookie?: string;
      readonly peer?: { readonly remoteAddress: string };
    } = {},
  ): Promise<Answer & { readonly cookie: string | null }> => {
    const response = await handler(
      new Request(`http://127.0.0.1:4040${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      options.peer ?? THIS_MACHINE,
    );
    const text = await response.text();
    const set = response.headers.get("set-cookie");
    return {
      status: response.status,
      text,
      json: JSON.parse(text) as unknown,
      cookie: set === null ? null : (set.split(";")[0] ?? null),
    };
  };
}

/** Signs the reviewer maya in from another machine, and returns her session cookie. */
async function signIn(call: ReturnType<typeof caller>): Promise<string> {
  const signedIn = await call("POST", "/v1/session", {
    body: { name: "maya", password: "a long enough password" },
    peer: ELSEWHERE,
  });
  if (signedIn.status !== 200 || signedIn.cookie === null) {
    throw new Error(`maya could not sign in: ${signedIn.text}`);
  }
  return signedIn.cookie;
}

describe("GET /v1/config and GET /v1/plugins on facetdb worker", () => {
  it("answers no address's path, query or login to a signed-in reviewer or the operator, the same cut to both", async () => {
    await store.users.add("maya", await hashPassword("a long enough password"));
    const file = { text: configFileSource(INITIAL), writes: 0 };
    const answers: Record<string, Answer> = {};
    const result = await serving(file, async (handler) => {
      const call = caller(handler);
      const cookie = await signIn(call);
      for (const path of ["/v1/config", "/v1/plugins"]) {
        answers[`operator ${path}`] = await call("GET", path);
        answers[`reviewer ${path}`] = await call("GET", path, { cookie, peer: ELSEWHERE });
      }
    });
    expect(result.code, result.stderr).toBe(0);

    for (const answer of Object.values(answers)) {
      expect(answer.status, answer.text).toBe(200);
      carriesNoToken(answer.text);
    }
    expect(answers["reviewer /v1/config"]?.text).toBe(answers["operator /v1/config"]?.text);
    expect(answers["reviewer /v1/plugins"]?.text).toBe(answers["operator /v1/plugins"]?.text);

    expect(answers["operator /v1/config"]?.json).toMatchObject({
      plugins: {
        webhook: { endpoints: { ops: "hooks.example.com", lan: { url: "10.0.0.5:9000" } } },
        status: { baseUrl: "status.example.com", region: "eu", mirrors: ["mirror.example.com"] },
      },
      sources: [{ name: "tickets", actions: [{ config: { url: "decisions.example.com" } }, {}] }],
      hostOnly: expect.arrayContaining(["sources[0].actions[0].config.else.url"]),
    });
    expect(answers["operator /v1/plugins"]?.json).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: "webhook",
          settings: expect.objectContaining({
            values: expect.objectContaining({
              endpoints: {
                ops: "hooks.example.com",
                lan: { url: "10.0.0.5:9000", allowPrivate: true },
              },
            }),
            hostOnly: ["endpoints.ops", "endpoints.lan.url"],
          }),
        }),
        expect.objectContaining({
          name: "status",
          settings: expect.objectContaining({
            values: {
              baseUrl: "status.example.com",
              region: "eu",
              mirrors: ["mirror.example.com"],
              apiKey: { env: "STATUS_KEY" },
            },
            hostOnly: ["baseUrl", "mirrors[0]"],
          }),
        }),
      ]),
    });
  });

  it("applies a source draft and a plugin draft built from the answers with every address in the file kept whole", async () => {
    await store.users.add("maya", await hashPassword("a long enough password"));
    const file = { text: configFileSource(INITIAL), writes: 0 };
    const answers: Record<string, Answer> = {};
    const result = await serving(file, async (handler) => {
      const call = caller(handler);
      const as = { cookie: await signIn(call), peer: ELSEWHERE };

      // The Questions page's draft: the source as the answer gives it, cut actions and all, with
      // the wording changed.
      const config = (await call("GET", "/v1/config", as)).json as {
        readonly sources: readonly Record<string, unknown>[];
      };
      const source = {
        ...config.sources[0],
        questions: {
          urgent: {
            type: "noul",
            instructions: "Does this ticket need an answer today?",
            stakes: "low",
          },
        },
      };
      const sourceDiff = await call("POST", "/v1/apply", { ...as, body: { source } });
      answers["source diff"] = sourceDiff;
      const plan = (sourceDiff.json as { readonly plan?: string }).plan;
      answers["source write"] = await call("POST", "/v1/apply", {
        ...as,
        body: { source, confirm: plan },
      });

      // The Plugins page's draft: the plugin's values as answered, its editable region changed.
      const plugins = (await call("GET", "/v1/plugins", as)).json as {
        readonly plugins: readonly {
          readonly name: string;
          readonly key: string;
          readonly settings: { readonly values: Record<string, unknown> };
        }[];
      };
      const shown = plugins.plugins.find((plugin) => plugin.name === "status");
      const project = {
        plugins: { [shown?.key ?? "status"]: { ...shown?.settings.values, region: "us" } },
      };
      const pluginDiff = await call("POST", "/v1/apply", { ...as, body: { project } });
      answers["plugin diff"] = pluginDiff;
      answers["plugin write"] = await call("POST", "/v1/apply", {
        ...as,
        body: { project, confirm: (pluginDiff.json as { readonly plan?: string }).plan },
      });
    });
    expect(result.code, result.stderr).toBe(0);

    expect(answers["source diff"]).toMatchObject({ status: 200, json: { changed: true } });
    expect(answers["source write"]).toMatchObject({ status: 200, json: { written: true } });
    expect(answers["plugin diff"]).toMatchObject({ status: 200, json: { changed: true } });
    expect(answers["plugin write"]).toMatchObject({ status: 200, json: { written: true } });
    // Two writes, each the file with only the draft's change: every address as the file wrote it.
    expect(file.writes).toBe(2);
    expect(file.text).toBe(configFileSource(MOVED));
    for (const address of [OPS, LAN, BASE_URL, MIRROR, DECISIONS, OTHERWISE, TARGET]) {
      expect(file.text).toContain(JSON.stringify(address));
    }
  });
});
