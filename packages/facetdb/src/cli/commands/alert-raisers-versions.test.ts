import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  judgeDraftSource,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import { sharePools } from "../pools.ts";
import { type CliDeps, docsLink, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * Question set changed through `facetdb worker`'s own wiring: a source that starts under a version
 * higher than the one it ran raises it once, naming who changed what; its first version raises
 * nothing. The store on PGlite, the set in force kept in it as the worker writes it at every open;
 * the file and git the test's own.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  LISTINGS_URL: WORKER_URL,
  TYPESAFE_API_KEY: "ts-test-key",
};

/** As the loader reads `database: process.env.LISTINGS_URL`. */
function project(instructions: string): ProjectConfig {
  const declared = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["id", "title"],
        questions: { is_scam: noul(instructions) },
      },
    ],
  });
  return {
    ...declared,
    sources: declared.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
  };
}

const FIRST = project("Is this listing a scam?");
const REWORDED = project("Is this listing a scam or a fake?");

let world: PgliteWorld;
let store: Store;
let provider: FakeProvider;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new SteppedClock(0) });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const [source] = FIRST.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet: questionSetOf(FIRST, source),
      project: projectRef(PROJECT_DIR),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  options: {
    readonly config: () => Promise<ProjectConfig>;
    readonly files?: ConfigFiles;
    readonly serve?: CliDeps["serve"];
    readonly stop?: AbortSignal;
  },
) {
  const connect = sharePools(world.connect);
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      osUser: () => "alex",
      loadConfig: options.config,
      ...(options.files === undefined ? {} : { configFiles: options.files }),
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock: new SteppedClock(START),
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve:
        options.serve ??
        ((_handler, port) => Promise.resolve({ port, close: () => Promise.resolve() })),
      ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
    },
    COMMANDS,
  );
}

/** The question-set alerts recorded, oldest first. */
async function changes(): Promise<
  readonly { readonly what: string; readonly link: string; readonly severity: string }[]
> {
  const rows = await world.client.query(
    "select record::text as record from facetdb.alert_history order by id",
  );
  return rows.flatMap((row) => {
    const record = JSON.parse(String(row["record"])) as {
      severity: string;
      event: { kind: string; what: string; link: string };
    };
    return record.event.kind === "question_set_changed"
      ? [{ what: record.event.what, link: record.event.link, severity: record.severity }]
      : [];
  });
}

const once = (config: ProjectConfig) =>
  run(["worker", "--once", "--no-http"], { config: () => Promise.resolve(config) });

describe("Question set changed when a source starts under a new version (alert-raisers)", () => {
  it("is silent at a first install and at a start under the same version, and names the file for a hand edit", async () => {
    expect((await once(FIRST)).code).toBe(0);
    expect((await once(FIRST)).code).toBe(0);
    expect(await changes()).toEqual([]);

    const edited = await once(REWORDED);

    expect(edited.code, edited.stderr).toBe(0);
    expect(await changes()).toEqual([
      {
        what: "The question set of listings changed from version 1 to version 2, by a change to facetdb.config.ts: the wording of is_scam.",
        // With no studio, the docs fix page of a question-set change.
        link: docsLink("question-set"),
        severity: "information",
      },
    ]);
    // A start again under version 2 is not a change.
    expect((await once(REWORDED)).code).toBe(0);
    expect(await changes()).toHaveLength(1);
  });

  it("raises one alert when two workers start under the same new version", async () => {
    expect((await once(FIRST)).code).toBe(0);

    const both = await Promise.all([once(REWORDED), once(REWORDED)]);

    expect(both.map((result) => result.code)).toEqual([0, 0]);
    expect(await changes()).toHaveLength(1);
  });

  it("names the reviewer of the Apply that wrote the set, through the studio's POST /v1/apply", async () => {
    expect((await once(FIRST)).code).toBe(0);
    const judged = judgeDraftSource(
      FIRST,
      {
        name: "listings",
        questions: {
          is_scam: {
            type: "noul",
            instructions: "Is this listing a scam or a fake?",
            stakes: "low",
          },
        },
      },
      ENV,
    );
    if (!judged.ok) {
      throw new Error("the draft is valid");
    }
    const file = { text: configFileSource(FIRST) };
    const configs = [FIRST, judged.config];
    const files: ConfigFiles = {
      read: () => Promise.resolve({ kind: "file", text: file.text }),
      replace: (_path, text) => {
        file.text = text;
        return Promise.resolve();
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    const load = () => {
      const found = configs.find((config) => configFileSource(config) === file.text);
      return found === undefined
        ? Promise.reject(new Error("the test's file holds no known config"))
        : Promise.resolve(found);
    };
    const draft = {
      source: {
        name: "listings",
        questions: {
          is_scam: {
            type: "noul",
            instructions: "Is this listing a scam or a fake?",
            stakes: "low",
          },
        },
      },
    };
    const stop = new AbortController();
    const answers: Record<string, unknown> = {};

    const result = await run(["worker"], {
      config: load,
      files,
      stop: stop.signal,
      serve: async (handler, port) => {
        // This machine's own user, who needs no sign-in: the reviewer `os:alex`.
        const post = async (body: unknown) => {
          const response = await handler(
            new Request("http://127.0.0.1:4040/v1/apply", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
            THIS_MACHINE,
          );
          return (await response.json()) as Record<string, unknown>;
        };
        const shown = await post(draft);
        answers["confirmed"] = await post({ ...draft, confirm: shown["plan"] });
        stop.abort();
        return { port, close: () => Promise.resolve() };
      },
    });

    expect(result.code, result.stderr).toBe(0);
    expect(answers["confirmed"]).toMatchObject({
      written: true,
      reload: { sources: [{ source: "listings", outcome: "restarted", version: 2 }] },
    });
    expect((await changes()).map((change) => change.what)).toEqual([
      "The question set of listings changed from version 1 to version 2, by os:alex, through Apply in the studio: the wording of is_scam.",
    ]);
  });
});
