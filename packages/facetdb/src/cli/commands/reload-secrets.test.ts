import type { AlertEvent } from "@facetdb/core";
import { FakeConnector, FakeDatabase, FakeEngine, freshHeldModel } from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import {
  CREDENTIAL_WORDS_WITHHELD,
  createConfigService,
  credentialRefusedAlert,
} from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
  toProjectJson,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { BUILTIN_PLUGINS, createPluginHost, type SettingsReload } from "../../plugin/index.ts";
import { lazyEngine } from "../engines.ts";
import { CliError, runInProcess } from "../program.ts";
import { createHide, hideOverLoads } from "../secret-words.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { createFleet, type InstallCheck, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";
import { deliverUntil, outboxAlerts, previewLine, withHiddenFailure } from "./worker.ts";

/**
 * No line the worker prints, logs or serves at a reload or a webhook delivery carries a connection
 * string's secret parts or a secret variable's value. A fleet on handwritten fakes whose driver
 * errors quote a source's whole string, its password, its user and host, the store's string and the
 * secret variables in force fails at each place a reload words an error (the file that does not
 * load, the install check that could not read, the open that failed, the start that failed, the
 * closing failures, the heartbeat during a reload, a loop that stops alone, settings that cannot be
 * put in force); a delivery pass's alert that could not be raised and the error a `--once` run ends
 * with, the same. Nothing printed and no word the studio is served (the reload's summary,
 * `pending()`, `stopped()`) holds any of them, and each still says what failed.
 */

const START_MS = 1_700_000_000_000;

const SOURCE_PASSWORD = "Src-Pa55-word";
const SOURCE_URL = `postgres://ann_worker:${SOURCE_PASSWORD}@db-src.example.com:5432/app`;
/** The new source's password, as its string writes it URL-encoded and its driver says it decoded. */
const NEW_PASSWORD = "p@ss/New-Word-77";
const NEW_URL = `postgres://newbie_login:${encodeURIComponent(NEW_PASSWORD)}@db-new.example.com:5432/shop`;
const STORE_PASSWORD = "Store-Pa55-word";
const STORE_URL = `postgres://store_login:${STORE_PASSWORD}@db-store.example.com:5432/facetdb`;
const WEBHOOK_SECRET = "whsec_Signing-Secret-123";
const MODEL_KEY = "ts-key-ABCDEFGH123";
const SESSION_SECRET = "fdb-session-secret-0123456789";

const ENV = {
  DATABASE_URL: STORE_URL,
  FACETDB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TYPESAFE_API_KEY: MODEL_KEY,
  FACETDB_SECRET: SESSION_SECRET,
};

/** Every planted secret: none may reach a reader. */
const PLANTED = [
  SOURCE_URL,
  SOURCE_PASSWORD,
  "ann_worker",
  "db-src.example.com",
  NEW_URL,
  NEW_PASSWORD,
  encodeURIComponent(NEW_PASSWORD),
  "newbie_login",
  "db-new.example.com",
  STORE_URL,
  STORE_PASSWORD,
  "store_login",
  "db-store.example.com",
  WEBHOOK_SECRET,
  MODEL_KEY,
  SESSION_SECRET,
];

/** A driver's words for a string, quoting all of it and the secrets in force beside it. */
function driver(url: string): Error {
  const parsed = new URL(url);
  return new Error(
    `password authentication failed for user "${decodeURIComponent(parsed.username)}" at ${parsed.host} (${url}, password ${decodeURIComponent(parsed.password)}); store ${STORE_URL}; signing ${WEBHOOK_SECRET}; key ${MODEL_KEY}; session ${SESSION_SECRET}`,
  );
}

function expectNothingSecret(text: string): void {
  for (const secret of PLANTED) {
    expect(text).not.toContain(secret);
  }
}

function project(...sources: readonly SourceConfig[]): ProjectConfig {
  return projectOn(SOURCE_URL, ...sources);
}

/** The project with its listings source on `url`. */
function projectOn(url: string, ...sources: readonly SourceConfig[]): ProjectConfig {
  const config = facetdb({
    model: "jev-1.14.0",
    plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET") } },
    sources: [
      {
        name: "listings",
        database: url,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
  return {
    ...config,
    sources: [
      ...config.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
      ...sources,
    ],
  };
}

const START = project();

/** A source new in the file named `name`, on `url`. */
function newSource(name: string, url: string): SourceConfig {
  return {
    ...facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name,
          database: url,
          table: name,
          read: ["reason"],
          questions: { is_abuse: noul("Is this request abusive?") },
        },
      ],
    }).sources[0],
    databaseEnv: `${name.toUpperCase()}_URL`,
  } as SourceConfig;
}

/** The source new in the file, on a database the worker never had in force. */
const REFUNDS = newSource("refunds", NEW_URL);

/** The listings source with its question reworded: a reload restarts its loop. */
function reworded(): ProjectConfig {
  const config = project();
  return {
    ...config,
    sources: config.sources.map((source) => ({
      ...source,
      questions: source.questions.map((question) => ({
        ...question,
        question: "Is this listing a scam, as a buyer would see it?",
      })),
    })),
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) {
    await Promise.resolve();
  }
}

async function rig(
  given: { readonly env?: Readonly<Record<string, string>>; readonly start?: ProjectConfig } = {},
) {
  const environment = given.env ?? ENV;
  const start = given.start ?? START;
  const clock = new SteppedClock(START_MS);
  const lines: string[] = [];
  const failNow = new Map<string, (error: unknown) => void>();
  const state: {
    file: ProjectConfig;
    loadFails: Error | undefined;
    installed: (source: SourceConfig) => Promise<InstallCheck>;
    openFails: Map<string, Error>;
    closeFails: Map<string, Error>;
    beatFails: Error | undefined;
    settings: SettingsReload;
  } = {
    file: start,
    loadFails: undefined,
    installed: () => Promise.resolve({ kind: "holds", rightsRead: true }),
    openFails: new Map(),
    closeFails: new Map(),
    beatFails: undefined,
    settings: { ok: true, restarts: () => undefined, notes: [] },
  };
  // The webhook's signing secret is a variable its plugin's schema marks secret.
  const host = await createPluginHost({
    config: start,
    env: environment,
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: () => Promise.reject(new Error("no plugin is imported in these tests")),
    builtins: BUILTIN_PLUGINS,
  });
  // As the worker wires it: the start's config, then each reload's as it loads.
  const { hide, loaded } = hideOverLoads({ env: environment, plugins: host });
  loaded(start);
  const fleet = createFleet({
    open: (source, from) => {
      const fails = state.openFails.get(source.name);
      if (fails !== undefined) {
        return Promise.reject(fails);
      }
      const loop: SourceLoop = {
        source,
        questionSet: questionSetOf(from, source),
        version: 1,
        heldModel: freshHeldModel(),
        worker: {
          runOnce: () => Promise.reject(new Error("not run here")),
          onHumanDecision: () => Promise.reject(new Error("not run here")),
          run: (signal) =>
            new Promise<void>((resolve, reject) => {
              failNow.set(source.name, reject);
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        },
        connector: new FakeConnector(new FakeDatabase({ fields: source.read, clock })),
        keyText: undefined,
        close: () => {
          const closing = state.closeFails.get(source.name);
          return closing === undefined ? Promise.resolve() : Promise.reject(closing);
        },
      };
      return Promise.resolve(loop);
    },
    installed: (source) => state.installed(source),
    load: () =>
      state.loadFails === undefined
        ? Promise.resolve(state.file).then(loaded)
        : Promise.reject(state.loadFails),
    settings: (next) => {
      loaded(next);
      return state.settings;
    },
    beat: () =>
      state.beatFails === undefined ? Promise.resolve() : Promise.reject(state.beatFails),
    clock,
    print: (line) => lines.push(line),
    hide,
    onPass: () => () => undefined,
  });
  await fleet.open(start);
  const stop = new AbortController();
  const done = fleet.run(stop.signal);
  /** Every word a reader is given: the lines, then what the studio is served. */
  const served = (...more: readonly unknown[]) =>
    [
      lines.join("\n"),
      JSON.stringify(fleet.pending()),
      JSON.stringify(fleet.stopped()),
      ...more.map((value) => JSON.stringify(value)),
    ].join("\n");
  const end = async () => {
    stop.abort();
    await done;
    await fleet.close();
  };
  return { clock, lines, state, fleet, failNow, served, end };
}

describe("a reload says what failed without a secret", () => {
  it("of a file that does not load", async () => {
    const t = await rig();
    t.state.loadFails = new Error(`the import failed: ${STORE_URL}, ${WEBHOOK_SECRET}`);

    const summary = await t.fleet.reload();

    expect(summary.loaded).toBe(false);
    expect(JSON.stringify(summary)).toContain(
      "facetdb.config.ts could not be loaded: the import failed: [hidden], [hidden]",
    );
    expectNothingSecret(t.served(summary));
    await t.end();
  });

  it("of an install check that could not read a source new in the file, hidden before it is in force", async () => {
    const t = await rig();
    t.state.file = project(REFUNDS);
    t.state.installed = (source) =>
      source.name === "refunds" ? Promise.reject(driver(NEW_URL)) : Promise.resolve(HOLDS);

    const summary = await t.fleet.reload();

    const said = JSON.stringify(summary);
    expect(said).toContain("its database could not be read to check its install (");
    expect(said).toContain('password authentication failed for user \\"[hidden]\\"');
    expect(JSON.stringify(t.fleet.pending())).toContain(
      "its database could not be read to check its install (",
    );
    expectNothingSecret(t.served(summary));
    await t.end();
  });

  it("of an open that failed for a source new in the file", async () => {
    const t = await rig();
    t.state.file = project(REFUNDS);
    t.state.openFails.set("refunds", driver(NEW_URL));

    const summary = await t.fleet.reload();

    expect(JSON.stringify(summary)).toContain("it could not be started (password authentication");
    expect(JSON.stringify(t.fleet.pending())).toContain("it could not be started (");
    expectNothingSecret(t.served(summary));
    await t.end();
  });

  it("of a restart whose start failed", async () => {
    const t = await rig();
    t.state.file = reworded();
    t.state.openFails.set("listings", driver(SOURCE_URL));

    const summary = await t.fleet.reload();

    expect(JSON.stringify(summary)).toContain(
      "could not start with what the file now says (password authentication failed",
    );
    expectNothingSecret(t.served(summary));
    await t.end();
  });

  it("of a previous connection that would not close, and of the heartbeat during the swap", async () => {
    const t = await rig();
    t.state.file = reworded();
    t.state.closeFails.set("listings", driver(SOURCE_URL));
    t.state.beatFails = driver(STORE_URL);

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(t.lines).toContainEqual(
      expect.stringMatching(/^listings: closing its previous connection failed: password/),
    );
    expect(t.lines).toContainEqual(
      expect.stringMatching(/^the heartbeat could not be saved during the reload: password/),
    );
    expectNothingSecret(t.served(summary));
    t.state.closeFails.clear();
    await t.end();
  });

  it("of a removed source's closing, its string no longer in force", async () => {
    const t = await rig();
    t.state.file = { ...START, sources: [] };
    t.state.closeFails.set("listings", driver(SOURCE_URL));

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(t.lines).toContainEqual(
      expect.stringMatching(/^listings: closing its previous connection failed: password/),
    );
    expectNothingSecret(t.served(summary));
    t.state.closeFails.clear();
    await t.end();
  });

  it("of a loop that stops alone, to the lines, Home's stopped sources and pending", async () => {
    const t = await rig();
    t.failNow.get("listings")?.(driver(SOURCE_URL));
    await flush();

    expect(t.fleet.stopped()).toEqual([
      expect.objectContaining({
        source: "listings",
        why: expect.stringContaining('password authentication failed for user "[hidden]"'),
      }),
    ]);
    expectNothingSecret(t.served());
    await t.end();
  });

  it("of a loop's error whose secret sits in its cause or inside an AggregateError: only its own words are said", async () => {
    const t = await rig();
    t.failNow.get("listings")?.(
      new Error("the pool could not connect", {
        cause: new AggregateError([driver(SOURCE_URL), driver(STORE_URL)], ""),
      }),
    );
    await flush();

    expect(t.fleet.stopped()[0]?.why).toBe("the pool could not connect");
    expectNothingSecret(t.served());
    await t.end();
  });
});

describe("the one hide", () => {
  it("hides a short secret only as a whole word, so ordinary words survive", () => {
    const hide = createHide(() => [{ text: "k3y", bounded: true }]);

    expect(hide("the key k3y was refused; the k3yboard and monk3y stay")).toBe(
      "the key [hidden] was refused; the k3yboard and monk3y stay",
    );
  });

  it("hides a secret a reload loaded after the hide was built, and keeps hiding it", async () => {
    const host = await createPluginHost({
      config: START,
      env: ENV,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: () => Promise.reject(new Error("no plugin is imported in these tests")),
      builtins: BUILTIN_PLUGINS,
    });
    const { hide, loaded } = hideOverLoads({ env: ENV, plugins: host });
    loaded(START);
    expect(hide(`failed: ${NEW_URL}`)).toBe(`failed: ${NEW_URL}`);

    loaded(project(REFUNDS));
    loaded(START);

    expect(hide(`failed: ${NEW_URL} (password ${NEW_PASSWORD})`)).toBe(
      "failed: [hidden] (password [hidden])",
    );
    // The host is a name, hidden as a word, with its port when it is written host:port; the
    // database's name stays.
    expect(hide("could not reach db-src.example.com:5432/app")).toBe(
      "could not reach [hidden]/app",
    );
  });
});

describe("a delivery pass whose alert could not be raised", () => {
  it("prints the alert's failure without the store's string or a secret", async () => {
    const host = await createPluginHost({
      config: START,
      env: ENV,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: () => Promise.reject(new Error("no plugin is imported in these tests")),
      builtins: BUILTIN_PLUGINS,
    });
    const { hide, loaded } = hideOverLoads({ env: ENV, plugins: host });
    loaded(START);
    const printed: string[] = [];
    const stop = new AbortController();

    await deliverUntil(
      stop.signal,
      () => {
        stop.abort();
        return Promise.resolve({
          alertFailures: [
            {
              event: {
                projectId: "p",
                deliveryId: "7",
                host: "hooks.example.com",
                attempts: 31,
                queuedAt: START_MS,
              },
              error: driver(STORE_URL),
              final: false,
            },
          ],
        });
      },
      new SteppedClock(START_MS),
      (text) => printed.push(text),
      hide,
    );

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(
      "webhook to hooks.example.com (delivery 7) was given up after 31 attempts in 24 hours, and its alert could not be raised: password authentication failed",
    );
    expectNothingSecret(printed.join("\n"));
  });
});

/** As an engine whose doctor reads the worker login's rights answers. */
const HOLDS: InstallCheck = { kind: "holds", rightsRead: true };

/** A database whose every connector call fails in a driver's words, with its error code if any. */
class LeakyDatabase extends FakeDatabase {
  readonly #failure: string;
  readonly #code: string | undefined;

  constructor(
    options: ConstructorParameters<typeof FakeDatabase>[0],
    failure: string,
    code?: string,
  ) {
    super(options);
    this.#failure = failure;
    this.#code = code;
  }

  override assertInstalled(): void {
    throw Object.assign(
      new Error(this.#failure),
      this.#code === undefined ? {} : { code: this.#code },
    );
  }
}

/** The common development store: the operator guide's own, on this machine. */
function devStore(password: string): string {
  return `postgres://postgres:${password}@127.0.0.1:5432/postgres`;
}

/** A driver's words for a login the development store refused. */
function refusedLogin(password: string): Error {
  return new Error(
    `password authentication failed for user "postgres" at 127.0.0.1:5432 (password ${password})`,
  );
}

/** What those words read once hidden: the user, the host and the password. */
const REFUSED_HIDDEN =
  'password authentication failed for user "[hidden]" at [hidden] (password [hidden])';

describe("a short secret that is an ordinary word hides only the outside words, never FacetDB's", () => {
  it.each(["facetdb", "postgres"])(
    "with the store's password %s: a reload of a file that does not load",
    async (password) => {
      const url = devStore(password);
      const t = await rig({
        env: { ...ENV, DATABASE_URL: url },
        start: projectOn(url),
      });
      t.state.loadFails = refusedLogin(password);

      const summary = await t.fleet.reload();

      expect(t.lines).toContain(
        `facetdb.config.ts could not be loaded: ${REFUSED_HIDDEN}\nThe worker keeps running on the config it had; fix facetdb.config.ts, then apply again or restart facetdb worker.`,
      );
      expect(summary).toMatchObject({
        loaded: false,
        message: `facetdb.config.ts was written but does not load, so the worker keeps running on the config it had. facetdb.config.ts could not be loaded: ${REFUSED_HIDDEN}`,
        fix: "Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.",
      });

      // The loader's own refusal is FacetDB's words: whole, its file's name and the scheme too.
      t.state.loadFails = new ConfigError(
        [{ path: "sources[0].database", message: "is not a postgres:// connection string" }],
        "facetdb.config.ts",
      );
      await t.fleet.reload();
      expect(t.lines.at(-1)).toBe(
        "facetdb.config.ts has problems:\n  - sources[0].database: is not a postgres:// connection string\nThe worker keeps running on the config it had; fix facetdb.config.ts, then apply again or restart facetdb worker.",
      );
      await t.end();
    },
  );

  it.each(["facetdb", "postgres"])(
    "with the store's password %s: pending names the open that failed and the CLI's own refusal whole",
    async (password) => {
      const url = devStore(password);
      const t = await rig({
        env: { ...ENV, DATABASE_URL: url },
        start: projectOn(url),
      });
      t.state.file = projectOn(url, newSource("refunds", url), newSource("payouts", url));
      t.state.openFails.set("refunds", refusedLogin(password));
      t.state.installed = (source) =>
        source.name === "payouts"
          ? Promise.reject(
              new CliError(
                "worker-login",
                "the worker login's connection string (postgres://facetdb_worker:…@host/db) is refused by its database",
                "set PAYOUTS_URL to the worker login's string where facetdb worker runs, then run facetdb doctor",
              ),
            )
          : Promise.resolve(HOLDS);

      await t.fleet.reload();

      expect(t.fleet.pending().map((pending) => pending.message)).toEqual([
        `new in facetdb.config.ts and not answered yet: its install is in its database, and it could not be started (${REFUSED_HIDDEN}). Check it with facetdb doctor, then Check again or restart facetdb worker.`,
        "new in facetdb.config.ts and not answered yet: the worker login's connection string (postgres://facetdb_worker:…@host/db) is refused by its database; set PAYOUTS_URL to the worker login's string where facetdb worker runs, then run facetdb doctor. Then restart facetdb worker.",
      ]);
      // The reload printed the same words, each after its source's name.
      expect(t.lines).toEqual(
        expect.arrayContaining(
          t.fleet.pending().map((pending) => `${pending.source}: ${pending.message}`),
        ),
      );
      await t.end();
    },
  );

  it("plugin settings that cannot be put in force are said in FacetDB's own words, whole", async () => {
    const url = devStore("facetdb");
    const t = await rig({ env: { ...ENV, DATABASE_URL: url }, start: projectOn(url) });
    t.state.settings = {
      ok: false,
      message: 'the settings of the plugin "facetdb-slack" are refused: SLACK_TOKEN is not set',
      fix: "set SLACK_TOKEN where facetdb worker runs",
    };

    const summary = await t.fleet.reload();

    expect(summary).toMatchObject({
      loaded: false,
      message:
        'facetdb.config.ts loads, but the settings of the plugin "facetdb-slack" are refused: SLACK_TOKEN is not set, so the worker keeps running on the config it had.',
      fix: "Set SLACK_TOKEN where facetdb worker runs; then apply again, or Check again.",
    });
    await t.end();
  });

  it("a secret address keeps its version query and its short path readable, and hides its token", async () => {
    const hook = "https://hooks.example.com/v1?v=2&token=Tok-Secret-999";
    const slack = "https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX";
    const environment = { ...ENV, FACETDB_WEBHOOK_SECRET: hook, TYPESAFE_API_KEY: slack };
    const host = await createPluginHost({
      config: START,
      env: environment,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: () => Promise.reject(new Error("no plugin is imported in these tests")),
      builtins: BUILTIN_PLUGINS,
    });
    const { hide, loaded } = hideOverLoads({ env: environment, plugins: host });
    loaded(START);

    expect(hide("POST /v1?v=2 answered 500 (version 2 of /v1); token Tok-Secret-999")).toBe(
      "POST /v1?v=2 answered 500 (version 2 of /v1); token [hidden]",
    );
    expect(hide("refused /services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX")).toBe("refused [hidden]");
    expect(hide("the hook XXXXXXXXXXXXXXXXXXXXXXXX is gone")).toBe("the hook [hidden] is gone");
  });
});

describe("the worker's other lines and alerts quote outside words through the hide", () => {
  /** The hide of the planted secrets, as the worker wires it. */
  async function plantedHide(environment: Readonly<Record<string, string>> = ENV) {
    const host = await createPluginHost({
      config: START,
      env: environment,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: () => Promise.reject(new Error("no plugin is imported in these tests")),
      builtins: BUILTIN_PLUGINS,
    });
    const { hide, loaded } = hideOverLoads({ env: environment, plugins: host });
    loaded(START);
    return hide;
  }

  it("a webhook's give-up alert", async () => {
    const raised: AlertEvent[] = [];
    const hooks = outboxAlerts({
      raise: (event) => {
        raised.push(event);
        return Promise.resolve();
      },
      gaveUp: () => "http://127.0.0.1:4040/alerts",
      credential: () => "http://127.0.0.1:4040/alerts",
      hide: await plantedHide(),
    });

    await hooks.onGiveUp(
      {
        projectId: "p",
        deliveryId: "7",
        host: "hooks.example.com",
        attempts: 31,
        queuedAt: START_MS,
      },
      new AbortController().signal,
      `the receiver said: bad signature ${WEBHOOK_SECRET}`,
    );

    expect(raised).toHaveLength(1);
    expect(raised[0]?.what).toContain("the receiver said: bad signature [hidden]");
    expectNothingSecret(JSON.stringify(raised));
  });

  it("an action's credential alert, the withheld words known before anything is hidden", async () => {
    const raised: AlertEvent[] = [];
    const link = () => "http://127.0.0.1:4040/alerts";
    const hooks = outboxAlerts({
      raise: (event) => {
        raised.push(event);
        return Promise.resolve();
      },
      gaveUp: link,
      credential: link,
      // A store password that is a word of the withheld sentence: "credential".
      hide: await plantedHide({ ...ENV, DATABASE_URL: devStore("credential") }),
    });
    const event = {
      projectId: "p",
      deliveryId: "9",
      sourceId: "p:issues",
      plugin: "@facetdb/github",
      action: "label",
      attempts: 2,
      queuedAt: START_MS,
    };

    await hooks.onCredentialRefused(
      event,
      new AbortController().signal,
      `the service refused the token ${MODEL_KEY}`,
    );
    await hooks.onCredentialRefused(event, new AbortController().signal, CREDENTIAL_WORDS_WITHHELD);

    expect(raised[0]?.what).toContain("the service refused the token [hidden]");
    expect(raised[1]).toEqual(credentialRefusedAlert(event, CREDENTIAL_WORDS_WITHHELD, link));
    expectNothingSecret(JSON.stringify(raised));
  });

  it("the HTTP server's log line of a version history the store could not give", async () => {
    const logged: string[] = [];
    const service = createConfigService({
      config: {
        projectId: "p",
        json: () => toProjectJson(START),
        validate: () => {
          throw new Error("not validated in these tests");
        },
        pending: () => [],
        history: {
          sources: () => [{ name: "listings", inForce: 1 }],
          read: withHiddenFailure(() => Promise.reject(driver(STORE_URL)), await plantedHide()),
        },
      },
      preview: () => undefined,
      log: (line) => logged.push(line),
    });

    await service.json("p");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^the version history of listings could not be read from the store: password authentication failed/,
    );
    expectNothingSecret(logged.join("\n"));
  });

  it("a preview's or a test's log line, core's words whole", async () => {
    const printed: string[] = [];
    const line = previewLine(
      (text) => printed.push(text),
      "listings: preview: ",
      await plantedHide(),
    );

    line(`the reservation is left to its lease: ${driver(STORE_URL).message}`);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(
      /^listings: preview: the reservation is left to its lease: password authentication failed/,
    );
    expectNothingSecret(printed.join("\n"));
  });
});

describe("facetdb worker --once whose source fails in a driver's words", () => {
  let world: PgliteWorld;
  let store: Store;

  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  beforeEach(async () => {
    store = await createStore({
      pglite: world.db,
      secret: TEST_SECRET,
      clock: new SteppedClock(START_MS),
    });
  });

  afterEach(async () => {
    await store.close();
    await resetPgliteWorld(world);
  });

  /** `facetdb worker --once` over one source whose database fails in `failure`'s words. */
  async function runOnce(url: string, failure: string, code?: string) {
    const leaky = new LeakyDatabase({ fields: ["amount"] }, failure, code);
    leaky.install();
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "refunds",
          database: url,
          table: "refunds",
          read: ["amount"],
          questions: { is_abuse: noul("Is this refund abuse?") },
        },
      ],
    });
    return runInProcess(
      ["worker", "--once", "--no-http"],
      {
        projectDir: "/work/shop",
        env: {
          FACETDB_SECRET: TEST_SECRET,
          DATABASE_URL: "postgres://localhost:5432/facetdb",
          TYPESAFE_API_KEY: "ts-test-key",
        },
        osUser: () => "alex",
        loadConfig: () => Promise.resolve(config),
        engines: [
          lazyEngine("mssql", () =>
            Promise.resolve(
              new FakeEngine({ name: "mssql", schemes: ["mssql", "sqlserver"], database: leaky }),
            ),
          ),
        ],
        connect: world.connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
        clock: new SteppedClock(START_MS),
        random: () => 0.5,
        stopSignal: () => new AbortController().signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      },
      COMMANDS,
    );
  }

  it("exits with that error, hidden in what it prints", async () => {
    const leakyUrl = "mssql://facetdb_worker:Leaky-Pa55-77@localhost:1433/app";
    const result = await runOnce(leakyUrl, `login failed for ${leakyUrl} (password Leaky-Pa55-77)`);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: login failed for [hidden] (password [hidden])");
    const all = `${result.stdout}${result.stderr}`;
    expect(all).not.toContain("Leaky-Pa55-77");
    expect(all).not.toContain(leakyUrl);
  });

  it.each(["facetdb", "postgres"])(
    "with the password %s, its error and the CLI's fix: the driver's words hidden, FacetDB's whole",
    async (password) => {
      const url = `mssql://facetdb_worker:${password}@localhost:1433/app`;
      const result = await runOnce(
        url,
        `login failed for user "facetdb_worker" (password ${password})`,
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'error: login failed for user "[hidden]" (password [hidden])\nfix: run facetdb doctor to check the connection, permissions and model key',
      );
    },
  );

  it.each(["facetdb", "postgres"])(
    "with the password %s, a missing table's own sentence and fix whole around the driver's hidden words",
    async (password) => {
      const url = `mssql://facetdb_worker:${password}@localhost:1433/app`;
      const result = await runOnce(
        url,
        `relation "refunds" does not exist for user "facetdb_worker" (password ${password})`,
        "42P01",
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'error: the source "refunds" stopped: a table or a column it uses is not there (relation "refunds" does not exist for user "[hidden]" (password [hidden]))\nfix: run facetdb migrate --source refunds --dry-run on this machine to see what the install is missing, then facetdb migrate --source refunds; or, if a column of your own table was renamed or dropped, change read or where for "refunds" in facetdb.config.ts',
      );
    },
  );
});
