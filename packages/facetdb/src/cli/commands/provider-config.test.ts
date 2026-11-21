import { stateHash } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  configFileSource,
  env,
  facetdb,
  fromProjectJson,
  judgeDraftProject,
  noul,
  type ProjectConfig,
  parseProjectConfig,
  toProjectJson,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  checkPluginProvider,
  createPluginHost,
  definePlugin,
  type Plugin,
  provider,
  z,
} from "../../plugin/index.ts";
import { runInProcess } from "../program.ts";
import { modelProviderOf } from "../provider-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * The config's `provider`: the key in the schema, the JSON export and the exporter; a draft cannot
 * change it; the worker and doctor name the provider and the variable they read, and a preset the
 * FacetDB team has not run says so; a fixture plugin's provider answers a preview. No request
 * leaves the test: a recording fetch stands in for every vendor, and no key reaches a line of
 * output.
 */

const PROJECT_DIR = "/work/listings-app";
const TYPESAFE_KEY = "tsk-s3cret-typesafe-key";
const OPENROUTER_KEY = "or-s3cret-openrouter-key";
const ACME_TOKEN = "acme-s3cret-token";
const SECRETS = [TYPESAFE_KEY, OPENROUTER_KEY, ACME_TOKEN];
const clock = new FakeClock(0);

const QUESTIONS = { urgent: noul("Is this urgent?") };

function projectWith(
  extra: { readonly provider?: string; readonly modelUrl?: string } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...extra,
    sources: [{ name: "tickets", api: true, read: ["body"], questions: QUESTIONS }],
  });
}

function acmeProject(provider: string): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    provider,
    plugins: { acme: { token: env("ACME_TOKEN") } },
    sources: [{ name: "tickets", api: true, read: ["body"], questions: QUESTIONS }],
  });
}

describe("the config's provider key", () => {
  it.each(["openrouter", "vercel-ai-gateway", "ollama"])(
    "accepts the preset %s, which has an address of its own",
    (name) => {
      expect(parseProjectConfig(projectWith({ provider: name })).ok).toBe(true);
    },
  );

  it.each(["cloudflare-ai-gateway", "strands-decider", "solar-decide"])(
    "%s has no address of its own, so it requires modelUrl",
    (name) => {
      const bare = parseProjectConfig(projectWith({ provider: name }));
      expect(bare.ok).toBe(false);
      expect(!bare.ok && bare.issues).toEqual([
        {
          path: "modelUrl",
          message: `the ${name} provider has no address of its own in this build: set modelUrl to its base URL`,
        },
      ]);
      const given = projectWith({ provider: name, modelUrl: "https://gateway.example" });
      expect(parseProjectConfig(given).ok).toBe(true);
    },
  );

  it("lets modelUrl beside a preset replace the preset's address", () => {
    const result = parseProjectConfig(
      projectWith({ provider: "openrouter", modelUrl: "https://proxy.internal/openrouter" }),
    );
    expect(result.ok && result.config.modelUrl).toBe("https://proxy.internal/openrouter");
  });

  it.each(["acme/solar", "@facetdb/acme/solar", "facetdb-plugin-acme/solar-2"])(
    "accepts %s, a provider an installed plugin supplies",
    (name) => {
      expect(parseProjectConfig(projectWith({ provider: name })).ok).toBe(true);
    },
  );

  it("refuses modelUrl beside a plugin's provider, which names its own address", () => {
    const result = parseProjectConfig(
      projectWith({ provider: "acme/solar", modelUrl: "https://x.example" }),
    );
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(["modelUrl"]);
  });

  it.each(["openai", "OpenRouter", "acme/", "/solar", "acme/Solar", ""])(
    "refuses %j, listing the presets and the plugin form",
    (name) => {
      const result = parseProjectConfig(projectWith({ provider: name }));
      expect(result.ok).toBe(false);
      const [issue] = result.ok ? [] : result.issues;
      expect(issue?.path).toBe("provider");
      expect(issue?.message).toContain("openrouter, vercel-ai-gateway");
      expect(issue?.message).toContain('"<plugin>/<entry>"');
    },
  );

  it("refuses a provider that is not text", () => {
    const result = parseProjectConfig({ ...projectWith(), provider: 7 });
    expect(!result.ok && result.issues[0]?.path).toBe("provider");
  });
});

describe("the export and the exporter carry the provider", () => {
  const withProvider = projectWith({ provider: "openrouter" });
  const without = projectWith();

  it("writes provider into the JSON and reads it back", () => {
    const json = toProjectJson(withProvider);
    expect(json.provider).toBe("openrouter");
    const back = fromProjectJson(JSON.parse(JSON.stringify(json)) as unknown);
    expect(back.provider).toBe("openrouter");
  });

  it("writes provider into the config file, after modelUrl", () => {
    const source = configFileSource(
      projectWith({ provider: "cloudflare-ai-gateway", modelUrl: "https://gw.example" }),
    );
    expect(source).toContain(
      '  model: "jev-1.14.0",\n  modelUrl: "https://gw.example",\n  provider: "cloudflare-ai-gateway",\n',
    );
  });

  it("a config with no provider exports exactly as before: no key in the JSON, none in the file", () => {
    expect(Object.keys(toProjectJson(without))).toEqual(["model", "onCapReached", "sources"]);
    const source = configFileSource(without);
    expect(source).not.toContain("provider");
    expect(source).toContain('export default facetdb({\n  model: "jev-1.14.0",\n  sources: [');
  });
});

describe("a draft cannot change the provider", () => {
  it("refuses it in a project draft, like modelUrl", () => {
    const result = judgeDraftProject(
      projectWith({ provider: "openrouter" }),
      { provider: "ollama" },
      {},
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      {
        path: "provider",
        message:
          "a draft cannot change provider: it decides where every record's state is sent and which key goes with it; edit provider in facetdb.config.ts by hand",
      },
    ]);
  });

  it("keeps the file's provider when a draft changes the spending cap", () => {
    const result = judgeDraftProject(
      projectWith({ provider: "openrouter" }),
      { spendingCap: 5000 },
      {},
    );
    expect(result.ok && result.config.provider).toBe("openrouter");
  });
});

/** The plugin an `acme/solar` provider comes from: a token it declares secret, one provider. */
const asked: { token: string | undefined; model: string }[] = [];
const acme = definePlugin({
  name: "acme",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  providers: {
    solar: provider({
      config: z.object({}),
      ask: (ctx, request) => {
        asked.push({ token: ctx.secrets["token"], model: request.model });
        return Promise.resolve({
          model: request.model,
          answers: Object.fromEntries(
            request.questions.map((question) => [
              question.name,
              { type: "noul" as const, probability: 0.02 },
            ]),
          ),
          usage: { inputTokens: 12, outputTokens: 0 },
        });
      },
    }),
  },
});
const INSTALLED: Record<string, Plugin> = { "@facetdb/acme": acme };

function pluginsOf(environment: Record<string, string | undefined>) {
  return (config: ProjectConfig) =>
    createPluginHost({
      config,
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

type Call = { readonly url: string; readonly headers: Record<string, string> };

/** A fetch that records each call and answers whatever the doctor's tiny question asks. */
function vendorFetch() {
  const calls: Call[] = [];
  const answering = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: { doctor_ping: { noul: 0.9 } },
          usage: { input_tokens: 9, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return { answering, calls };
}

/** The in-process runner with the composition root's own provider door over a recording fetch. */
function run(
  argv: readonly string[],
  config: ProjectConfig,
  environment: Record<string, string | undefined>,
  fetchFake: typeof fetch = vendorFetch().answering,
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: environment,
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url) => {
        throw new Error(`a connection was opened to ${url}`);
      },
      pluginHost: pluginsOf(environment),
      provider: (loaded, plugins) =>
        modelProviderOf({
          config: loaded,
          env: environment,
          fetch: fetchFake,
          clock,
          stopSignal: () => new AbortController().signal,
          plugins,
        }),
      clock,
    },
    COMMANDS,
  );
}

function noKeyIn(result: { readonly stdout: string; readonly stderr: string }) {
  for (const secret of SECRETS) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
}

function lineFor(stdout: string, label: string): string {
  const found = stdout.split("\n").find((text) => text.slice(6).startsWith(`${label}:`));
  if (found === undefined) {
    throw new Error(`no line for ${label} in:\n${stdout}`);
  }
  return found;
}

const ENV = {
  FACETDB_SECRET: "a-long-random-secret-for-provider-tests",
  TYPESAFE_API_KEY: TYPESAFE_KEY,
};

describe("the worker names the provider and the variable it reads", () => {
  const config = projectWith({ provider: "openrouter" });

  it("refuses to start without the preset's key, though the TypeSafe key is set", async () => {
    const result = await run(["worker", "--dry-run"], config, ENV);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "error: OPENROUTER_API_KEY is not set, so the worker has no key for the openrouter provider",
    );
    expect(result.stderr).toContain("fix: set OPENROUTER_API_KEY to your openrouter key");
    noKeyIn(result);
  });

  it("starts with the preset's key and no TypeSafe key at all", async () => {
    const result = await run(["worker", "--dry-run"], config, {
      FACETDB_SECRET: ENV.FACETDB_SECRET,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
    });
    expect(result.code, result.stderr).toBe(0);
    noKeyIn(result);
  });

  it("with no provider, still names TYPESAFE_API_KEY as before", async () => {
    const result = await run(["worker", "--dry-run"], projectWith(), {
      FACETDB_SECRET: ENV.FACETDB_SECRET,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "error: TYPESAFE_API_KEY is not set, so the worker has no model to ask",
    );
  });

  it("refuses a plugin's provider the plugin does not supply, naming the ones it does", async () => {
    const result = await run(["worker", "--dry-run"], acmeProject("acme/lunar"), {
      ...ENV,
      ACME_TOKEN,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'error: provider names "lunar", and the plugin "@facetdb/acme" supplies only solar',
    );
    expect(result.stderr).toContain('fix: use "acme/solar" as provider');
    noKeyIn(result);
  });
});

describe("doctor names the provider and the variable it checks", () => {
  const offline = ["doctor", "--offline"] as const;

  it("a preset with its key set: the variable's name, never its value, and the not-run note", async () => {
    const result = await run(offline, projectWith({ provider: "openrouter" }), {
      ...ENV,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
    });
    expect(lineFor(result.stdout, "model key")).toContain(
      "the openrouter provider reads OPENROUTER_API_KEY, and it is set",
    );
    expect(lineFor(result.stdout, "model reachable")).toContain(
      "the FacetDB team has not run the openrouter provider yet",
    );
    noKeyIn(result);
  });

  it("a preset with its key missing fails the model key check, naming the variable", async () => {
    const result = await run(offline, projectWith({ provider: "openrouter" }), ENV);
    const line = lineFor(result.stdout, "model key");
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain(
      "OPENROUTER_API_KEY is not set, so FacetDB has no key for the openrouter provider",
    );
    expect(line).not.toContain("TYPESAFE_API_KEY");
    expect(lineFor(result.stdout, "model reachable")).toMatch(
      /^skip.*model key check did not pass/,
    );
    noKeyIn(result);
  });

  it("asks the preset's own address with its own key and sends the TypeSafe key nowhere", async () => {
    const { answering, calls } = vendorFetch();
    const result = await run(
      ["doctor"],
      projectWith({ provider: "openrouter" }),
      { ...ENV, OPENROUTER_API_KEY: OPENROUTER_KEY },
      answering,
    );
    expect(lineFor(result.stdout, "model reachable")).toContain(
      "jev-1.14.0 answered a test question; the FacetDB team has not run the openrouter provider yet",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(JSON.stringify(calls)).not.toContain(TYPESAFE_KEY);
    noKeyIn(result);
  });

  it("a key an unreachable vendor quotes is scrubbed from the failure's words", async () => {
    const result = await run(
      ["doctor"],
      projectWith({ provider: "openrouter" }),
      { ...ENV, OPENROUTER_API_KEY: OPENROUTER_KEY },
      (() => Promise.reject(new Error(`refused for ${OPENROUTER_KEY}`))) as typeof fetch,
    );
    const line = lineFor(result.stdout, "model reachable");
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("refused for ***");
    expect(line).toContain(
      "check OPENROUTER_API_KEY and that https://openrouter.ai/api is running",
    );
    noKeyIn(result);
  });

  it("an optional key (Ollama) that is not set is fine, and the check says so", async () => {
    const result = await run(offline, projectWith({ provider: "ollama" }), {});
    const line = lineFor(result.stdout, "model key");
    expect(line).toMatch(/^ok/);
    expect(line).toContain(
      "the ollama provider reads OLLAMA_API_KEY when it is set; it is not, so the server is asked with no key",
    );
  });

  it("an optional key set for plain http to another machine is withheld, and the check says so", async () => {
    const result = await run(
      offline,
      projectWith({ provider: "strands-decider", modelUrl: "http://decider.internal:8080" }),
      { STRANDS_DECIDER_API_KEY: "strands-s3cret" },
    );
    const line = lineFor(result.stdout, "model key");
    expect(line).toMatch(/^ok/);
    expect(line).toContain(
      "the strands-decider provider reads STRANDS_DECIDER_API_KEY, and it is set, but it is not sent: http://decider.internal:8080 is plain http to another machine",
    );
    expect(result.stdout + result.stderr).not.toContain("strands-s3cret");
  });

  it("an optional key set for https is sent, and the check says only that it is set", async () => {
    const result = await run(
      offline,
      projectWith({ provider: "strands-decider", modelUrl: "https://decider.internal" }),
      { STRANDS_DECIDER_API_KEY: "strands-s3cret" },
    );
    expect(lineFor(result.stdout, "model key")).toContain(
      "the strands-decider provider reads STRANDS_DECIDER_API_KEY, and it is set",
    );
    expect(lineFor(result.stdout, "model key")).not.toContain("not sent");
  });

  it("the Cloudflare gateway reads CF_AIG_TOKEN, never the broad CLOUDFLARE_API_TOKEN", async () => {
    const config = projectWith({
      provider: "cloudflare-ai-gateway",
      modelUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw",
    });
    const onlyBroad = await run(offline, config, { CLOUDFLARE_API_TOKEN: "cf-broad-s3cret" });
    expect(lineFor(onlyBroad.stdout, "model key")).toContain(
      "CF_AIG_TOKEN is not set, so FacetDB has no key for the cloudflare-ai-gateway provider",
    );
    expect(onlyBroad.stdout + onlyBroad.stderr).not.toContain("cf-broad-s3cret");
    const set = await run(offline, config, { CF_AIG_TOKEN: "cf-aig-s3cret" });
    expect(lineFor(set.stdout, "model key")).toContain(
      "the cloudflare-ai-gateway provider reads CF_AIG_TOKEN, and it is set",
    );
  });

  it("facetdb dev refuses --model-url beside a plugin's provider instead of ignoring it", async () => {
    const result = await run(
      ["dev", "--model-url", "http://localhost:11434"],
      acmeProject("acme/solar"),
      { ...ENV, ACME_TOKEN },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "error: --model-url cannot be used with the plugin's provider acme/solar: the plugin names its own address, so the flag would be ignored",
    );
    expect(result.stdout).not.toContain("Asking the model server");
  });

  it("with no provider, says what it said before", async () => {
    const result = await run(offline, projectWith(), ENV);
    expect(lineFor(result.stdout, "model key")).toContain("TYPESAFE_API_KEY is set");
    expect(lineFor(result.stdout, "model reachable")).not.toContain("FacetDB team");
  });

  it("a plugin's provider: supplied by the plugin, or refused when the plugin has no such provider", async () => {
    const good = await run(offline, acmeProject("acme/solar"), { ...ENV, ACME_TOKEN });
    expect(lineFor(good.stdout, "model key")).toContain(
      "the provider acme/solar is supplied by the plugin acme",
    );
    const bad = await run(offline, acmeProject("acme/lunar"), { ...ENV, ACME_TOKEN });
    expect(lineFor(bad.stdout, "model key")).toContain(
      'provider names "lunar", and the plugin "@facetdb/acme" supplies only solar',
    );
    noKeyIn(good);
    noKeyIn(bad);
  });

  it("a plugin whose variable is not set fails the config check, and the provider says it did not load", async () => {
    const result = await run(offline, acmeProject("acme/solar"), ENV);
    expect(lineFor(result.stdout, "config")).toContain("ACME_TOKEN is not set");
    expect(lineFor(result.stdout, "model key")).toContain("which did not load");
  });
});

describe("a plugin's provider", () => {
  it("is found by the host and passes the entry check", async () => {
    const host = await pluginsOf({ ACME_TOKEN })(acmeProject("acme/solar"));
    expect(host.plugin("acme")?.packageName).toBe("@facetdb/acme");
    expect(() =>
      checkPluginProvider({
        provider: "acme/solar",
        ref: { plugin: "acme", entry: "solar" },
        host,
      }),
    ).not.toThrow();
  });

  describe("answers a preview", () => {
    const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
    let world: PgliteWorld;

    beforeAll(async () => {
      world = await createPgliteWorld();
    });

    afterAll(async () => {
      await world.close();
    });

    beforeEach(async () => {
      await world.client.query(
        "create table public.listings (id text primary key, title text not null, created_at timestamptz not null default now())",
      );
      await world.client.query(
        "insert into public.listings (id, title) values ('r1', 'Listing 1'), ('r2', 'Listing 2')",
      );
    });

    afterEach(async () => {
      await resetPgliteWorld(world);
    });

    function previewConfig(chosen: string): ProjectConfig {
      return facetdb({
        model: "jev-1.14.0",
        provider: chosen,
        plugins: { acme: { token: env("ACME_TOKEN") } },
        sources: [
          {
            name: "listings",
            database: WORKER_URL,
            table: "listings",
            read: ["id", "title"],
            questions: { is_scam: noul("Is this listing a scam?") },
          },
        ],
      });
    }

    function preview(config: ProjectConfig, environment: Record<string, string | undefined>) {
      return runInProcess(
        ["preview", "--limit", "2"],
        {
          projectDir: PROJECT_DIR,
          env: environment,
          loadConfig: () => Promise.resolve(config),
          engines: postgresEngines(world.connect),
          connect: world.connect,
          pluginHost: pluginsOf(environment),
          provider: (loaded, plugins) =>
            modelProviderOf({
              config: loaded,
              env: environment,
              fetch: (() => {
                throw new Error("a plugin's provider asked the network");
              }) as typeof fetch,
              clock,
              stopSignal: () => new AbortController().signal,
              plugins,
            }),
        },
        COMMANDS,
      );
    }

    it("through the plugin host, with the plugin's own secret and the pinned model", async () => {
      asked.length = 0;
      const result = await preview(previewConfig("acme/solar"), { ...ENV, ACME_TOKEN });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Row r2: would be decided");
      expect(result.stdout).toContain("2 of 2 answered rows would be decided automatically");
      expect(asked).toEqual([
        { token: ACME_TOKEN, model: "jev-1.14.0" },
        { token: ACME_TOKEN, model: "jev-1.14.0" },
      ]);
      noKeyIn(result);
    });

    it("stops before reading a row when the plugin's variable is not set", async () => {
      asked.length = 0;
      const result = await preview(previewConfig("acme/solar"), ENV);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ACME_TOKEN is not set");
      expect(asked).toEqual([]);
      noKeyIn(result);
    });

    it("fails the preview, and answers nothing, when the plugin's response leaves a question out", async () => {
      const broken = definePlugin({
        name: "acme",
        version: "1.0.0",
        facetdb: "*",
        config: z.object({ token: z.secret() }),
        providers: {
          solar: provider({
            config: z.object({}),
            ask: (_ctx, request) =>
              Promise.resolve({
                model: request.model,
                answers: {},
                usage: { inputTokens: 1, outputTokens: 0 },
              }),
          }),
        },
      });
      INSTALLED["@facetdb/acme"] = broken;
      try {
        const result = await preview(previewConfig("acme/solar"), { ...ENV, ACME_TOKEN });
        expect(result.code).toBe(1);
        // The plugin holds a secret, so only the field core refused is named, never its text.
        expect(result.stderr).toContain("its response was refused at answers.is_scam");
        noKeyIn(result);
      } finally {
        INSTALLED["@facetdb/acme"] = acme;
      }
    });

    it("is the provider `facetdb test` asks too, through the plugin host", async () => {
      const store = await createStore({
        pglite: world.db,
        secret: TEST_SECRET,
        clock: new FakeClock(0),
      });
      try {
        const [source] = previewConfig("acme/solar").sources;
        if (source === undefined) {
          throw new Error("the test config has no source");
        }
        const sourceId = sourceIdOf("listings-app", "listings");
        // Version 1 says what the file said, but low stakes; the file now says high, so a test has
        // something to compare, and asks the plugin's provider about the sampled rows.
        const low = facetdb({
          model: "jev-1.14.0",
          provider: "acme/solar",
          plugins: { acme: { token: env("ACME_TOKEN") } },
          sources: [
            {
              ...source,
              questions: { is_scam: noul("Is this listing a scam?", { stakes: "low" }) },
            },
          ],
        });
        const high = facetdb({
          model: "jev-1.14.0",
          provider: "acme/solar",
          plugins: { acme: { token: env("ACME_TOKEN") } },
          sources: [
            {
              ...source,
              questions: { is_scam: noul("Is this listing a scam?", { stakes: "high" }) },
            },
          ],
        });
        const lowSource = low.sources[0];
        if (lowSource === undefined) {
          throw new Error("the test config has no source");
        }
        await store.questionSets.record(sourceId, questionSetOf(low, lowSource));
        await store.log(sourceId).appendAnswer({
          kind: "answer",
          key: "r2",
          version: 1,
          model: "jev-1.14.0",
          stateHash: stateHash(["id", "title"], { id: "r2", title: "Listing 2" }),
          answers: { is_scam: { type: "noul", probability: 0.5 } },
          usage: { inputTokens: 100, outputTokens: 5 },
          at: new Date(0),
        });
        asked.length = 0;
        const environment = { ...ENV, ACME_TOKEN, DATABASE_URL: "postgres://localhost:5432/app" };
        const result = await runInProcess(
          ["test", "--sample", "2", "--yes", "--json"],
          {
            projectDir: PROJECT_DIR,
            env: environment,
            loadConfig: () => Promise.resolve(high),
            engines: postgresEngines(world.connect),
            connect: world.connect,
            clock: new FakeClock(0),
            random: () => 0.5,
            store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
            answers: [],
            pluginHost: pluginsOf(environment),
            provider: (loaded, plugins) =>
              modelProviderOf({
                config: loaded,
                env: environment,
                fetch: (() => {
                  throw new Error("a plugin's provider asked the network");
                }) as typeof fetch,
                clock,
                stopSignal: () => new AbortController().signal,
                plugins,
              }),
          },
          COMMANDS,
        );
        expect(result.code, result.stderr).toBe(0);
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.every((call) => call.token === ACME_TOKEN)).toBe(true);
        noKeyIn(result);
      } finally {
        await store.close();
      }
    });
  });
});
