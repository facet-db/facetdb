import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ConfigFiles, configFileSource, facetdb, noul } from "../../config/index.ts";
import { runInProcess, type Workspace } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * Apply while the file names a plugin the worker did not load, through `facetdb worker`'s own
 * wiring: the real config file door and the real POST /v1/apply. The reload after a write would
 * refuse the whole file and the write be put back, so a question draft and a cap draft are each
 * refused before any diff with 409 `waits_for_restart`, in words that blame no draft and name what
 * whoever runs the worker does: install, set, restart, or take the plugin out. Nothing is written.
 * The file, git and the project's node_modules are the test's own; the store is PGlite.
 */

const PROJECT_DIR = "/work/support-app";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
};

const SOURCE = {
  name: "tickets",
  api: true,
  read: ["body"],
  questions: { urgent: noul("Is this ticket urgent?") },
} as const;
/** What the worker started with: no plugin. */
const STARTED = facetdb({ model: "jev-1.14.0", sources: [SOURCE] });
/** The file after `facetdb add slack` and its lines pasted, the worker not restarted. */
const WITH_SLACK = facetdb({
  model: "jev-1.14.0",
  plugins: { slack: { token: { env: "SLACK_TOKEN" } } },
  sources: [SOURCE],
});

const QUESTION_DRAFT = {
  source: {
    name: "tickets",
    questions: {
      urgent: { type: "noul", instructions: "Is this ticket urgent today?", stakes: "low" },
    },
  },
};
const CAP_DRAFT = { project: { spendingCap: 500_000 } };

let world: PgliteWorld;
let store: Store;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** The project's tree: package.json files by path, as `facetdb add` and an install leave them. */
function tree(files: Readonly<Record<string, string>>): Workspace {
  const none = () => Promise.reject(new Error("Apply writes through the config file's door"));
  return {
    exists: (path) => Promise.resolve(path in files),
    write: none,
    writeParts: none,
    peek: (path) =>
      Promise.resolve(path in files ? { kind: "file", firstLine: "{" } : { kind: "none" }),
    lines: async function* (path) {
      yield* (files[path] ?? "").split("\n");
    },
    hasClaudeCommand: () => false,
  };
}

const SLACK_INSTALLED = {
  "package.json": JSON.stringify({ dependencies: { "@facetdb/slack": "^0.3.0" } }),
  "node_modules/@facetdb/slack/package.json": JSON.stringify({
    name: "@facetdb/slack",
    version: "0.3.0",
  }),
};

/**
 * The worker started on STARTED, the file then edited by hand to WITH_SLACK: each draft's answer
 * to POST /v1/apply without confirm, and how many writes reached the file.
 */
async function answersFor(
  drafts: readonly unknown[],
  options: { readonly files: Readonly<Record<string, string>>; readonly env?: object },
) {
  const file = { text: configFileSource(STARTED), writes: 0 };
  const files: ConfigFiles = {
    read: () => Promise.resolve({ kind: "file", text: file.text }),
    replace: (_path, text) => {
      file.text = text;
      file.writes += 1;
      return Promise.resolve();
    },
    gitState: () => Promise.resolve({ kind: "clean" }),
  };
  const configs = [STARTED, WITH_SLACK];
  const stop = new AbortController();
  const answers: { status: number; body: unknown }[] = [];
  const result = await runInProcess(
    ["worker"],
    {
      projectDir: PROJECT_DIR,
      env: { ...ENV, ...options.env },
      osUser: () => "alex",
      loadConfig: () => {
        const found = configs.find((config) => configFileSource(config) === file.text);
        return found === undefined
          ? Promise.reject(new Error("the test's file holds no known config"))
          : Promise.resolve(found);
      },
      configFiles: files,
      workspace: tree(options.files),
      connect: world.connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock: new FakeClock(1_700_000_000_000),
      random: () => 0.5,
      stopSignal: () => stop.signal,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: async (handler, port) => {
        // Edited by hand once the worker is running: `facetdb add slack`'s lines pasted in.
        file.text = configFileSource(WITH_SLACK);
        for (const draft of drafts) {
          const response = await handler(
            new Request("http://127.0.0.1:4040/v1/apply", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(draft),
            }),
            THIS_MACHINE,
          );
          answers.push({ status: response.status, body: await response.json() });
        }
        stop.abort();
        return { port, close: () => Promise.resolve() };
      },
    },
    COMMANDS,
  );
  expect(result.code, result.stderr).toBe(0);
  return { answers, writes: file.writes };
}

describe("Apply while facetdb.config.ts names a plugin the worker did not load", () => {
  it("refuses a question draft and a cap draft with 409 waits_for_restart, in words that blame no draft", async () => {
    const { answers, writes } = await answersFor([QUESTION_DRAFT, CAP_DRAFT], {
      files: SLACK_INSTALLED,
      env: { SLACK_TOKEN: "xoxb-SLACKVALUE" },
    });
    const refused = {
      status: 409,
      body: {
        error: {
          code: "waits_for_restart",
          message:
            "facetdb.config.ts names the plugin slack, which loads when facetdb worker restarts; nothing can be applied until then.",
          fix: "Whoever runs the worker: restart it, or take plugins.slack out of the file.",
        },
      },
    };
    expect(answers).toEqual([refused, refused]);
    expect(writes).toBe(0);
    expect(JSON.stringify(answers)).not.toContain(PROJECT_DIR);
    expect(JSON.stringify(answers)).not.toContain("SLACKVALUE");
  });

  it("names the variable to set, never its value, and the install when the package is not there", async () => {
    const unset = await answersFor([QUESTION_DRAFT], { files: SLACK_INSTALLED });
    expect(unset.answers).toEqual([
      {
        status: 409,
        body: {
          error: {
            code: "waits_for_restart",
            message:
              "facetdb.config.ts names the plugin slack, which loads when facetdb worker restarts with SLACK_TOKEN set; nothing can be applied until then.",
            fix: "Whoever runs the worker: set SLACK_TOKEN and restart it, or take plugins.slack out of the file.",
          },
        },
      },
    ]);
    const missing = await answersFor([CAP_DRAFT], {
      files: { "package.json": "{}" },
      env: { SLACK_TOKEN: "xoxb-SLACKVALUE" },
    });
    expect(missing.answers).toEqual([
      {
        status: 409,
        body: {
          error: {
            code: "waits_for_restart",
            message:
              "facetdb.config.ts names the plugin slack, which is not installed; nothing can be applied until it is and facetdb worker restarts.",
            fix: "Whoever runs the worker: run facetdb add slack in the project and restart it, or take plugins.slack out of the file.",
          },
        },
      },
    ]);
    expect(unset.writes + missing.writes).toBe(0);
  });
});
