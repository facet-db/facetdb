import type { ModelProvider, ProviderRequest } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  type SqlConnect,
  SteppedClock,
  sourceIdOf,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb doctor`'s notes on the model's name: a server that answers under its own name makes the
 * config's model a label, and a version the store holds to another name than the server answers its
 * source's own model with is one whose source the worker holds. Warnings under the model check,
 * never checks; silent when the names agree. The store holds two API sources' versions in force:
 * `tickets` on the project's model, `orders` on its own, each held to the model it names.
 */

const PROJECT_DIR = "/work/support-desk";
const PROJECT_ID = "support-desk";
const SECRET = "a-long-random-secret-for-doctor-model-tests";
const KEY = "tsk-s3cret-model-key";
const STORE_PASSWORD = "s3cret-store-password";
const ENV = {
  DATABASE_URL: `postgres://facetdb:${STORE_PASSWORD}@localhost:5432/app`,
  FACETDB_SECRET: SECRET,
  TYPESAFE_API_KEY: KEY,
};
const HELD = "jev-1.14.0";
/** The model `orders` sets for itself. */
const OWN = "jev-1.13.0";
const OTHER = "strands-decider-7b";
// Its sleeps end only when a test moves it: each doctor step's 10-second bound waits.
const clock = new SteppedClock(10_000_000);

function configNaming(model: string, ordersModel = OWN): ProjectConfig {
  return facetdb({
    model,
    sources: [
      { name: "tickets", api: true, read: ["subject"], questions: { urgent: noul("Urgent?") } },
      {
        name: "orders",
        api: true,
        read: ["note"],
        model: ordersModel,
        questions: { fraud: noul("Fraud?") },
      },
    ],
  });
}

/** A model server answering under `model`, or under the name asked for when it is null. */
function answeringAs(model: string | null): ModelProvider & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: (request: ProviderRequest) => {
      asked.push(request.model);
      return Promise.resolve({
        model: model ?? request.model,
        answers: { doctor_ping: { type: "noul", probability: 0.9 } },
        usage: { inputTokens: 12, outputTokens: 1 },
      });
    },
  };
}

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
  const store = await createStore({ pglite: world.db, secret: SECRET, clock });
  const config = configNaming(HELD);
  await store.ensureProject({ id: PROJECT_ID, name: PROJECT_ID });
  for (const source of config.sources) {
    const id = sourceIdOf(PROJECT_ID, source.name);
    const questionSet = questionSetOf(config, source);
    await store.ensureSource({ projectId: PROJECT_ID, name: source.name, kind: "api" });
    const { version } = await store.questionSets.record(id, questionSet);
    await store.questionSets.run(id, version, questionSet);
    await store.questionSets.answeredBy(id, version, questionSet.model);
  }
  await store.close();
  await world.client.query("insert into facetdb.heartbeats (project, at) values ($1, $2)", [
    PROJECT_ID,
    clock.now(),
  ]);
});

afterAll(async () => {
  await world.close();
});

function doctor(
  config: ProjectConfig,
  provider: ModelProvider,
  connect: SqlConnect = world.connect,
) {
  return runInProcess(
    ["doctor"],
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      loadConfig: () => Promise.resolve(config),
      engines: [],
      connect,
      provider: () => provider,
      clock,
    },
    COMMANDS,
  );
}

/** The printed notes on the model's name. */
function notes(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("warn  model name: "));
}

const ownName = `warn  model name: the server answers as ${OTHER}, not ${HELD}: it serves its own model whatever is asked, so the config's model is only a label. To serve another model, also set a new model in facetdb.config.ts, which starts a new question-set version`;
const holds = (source: string, held: string, asked: string) =>
  `warn  model name: the store holds version 1 of ${source} to ${held}, and the server now answers ${asked} as ${OTHER}: the worker holds ${source}, writing none of its answers, until ${held} is served again or a new model in facetdb.config.ts starts a new version`;

describe("facetdb doctor on the model's name", () => {
  it("warns when the server answers under its own name, and for each source held to another", async () => {
    const provider = answeringAs(OTHER);
    const result = await doctor(configNaming(HELD), provider);

    // Warnings, not failures: every check passes and the exit code stays 0.
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(notes(result.stdout)).toEqual([
      ownName,
      holds("orders", OWN, OWN),
      holds("tickets", HELD, HELD),
    ]);
    // Each source's name is compared with an answer to its own model: one more question, for orders.
    expect(provider.asked).toEqual([HELD, OWN]);
    const everything = result.stdout + result.stderr;
    for (const secret of [KEY, STORE_PASSWORD, SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("is silent when the names agree, a source with its own model compared under that model", async () => {
    const provider = answeringAs(null);
    const result = await doctor(configNaming(HELD), provider);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(notes(result.stdout)).toEqual([]);
    expect(result.stdout).toContain(`${HELD} answered a test question`);
    expect(provider.asked).toEqual([HELD, OWN]);
  });

  it("says a new version starts at the next reload when the config names another model than the one in force", async () => {
    // facetdb.config.ts already names the server's own model for tickets, and a new one for orders:
    // the worker still runs version 1 of each, which its next reload replaces.
    const provider = answeringAs(OTHER);
    const result = await doctor(configNaming(OTHER, "jev-1.15.0"), provider);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(notes(result.stdout)).toEqual([
      `warn  model name: the worker runs version 1 of orders on ${OWN}, and facetdb.config.ts names jev-1.15.0: a new version starts at the worker's next reload`,
      `warn  model name: the worker runs version 1 of tickets on ${HELD}, and facetdb.config.ts names ${OTHER}: a new version starts at the worker's next reload`,
    ]);
    // No test question for a model no version runs yet: only the model check's own.
    expect(provider.asked).toEqual([OTHER]);
  });

  it("quotes a server's name as plain text: no markup or link, cut at 80 characters", async () => {
    const link = await doctor(configNaming(HELD), answeringAs("https://evil.example/x"));
    expect(link.stdout).toContain("https[:]//evil[.]example/x answered a test question");
    expect(notes(link.stdout)[0]).toContain("the server answers as https[:]//evil[.]example/x,");
    expect(link.stdout).not.toContain("evil.example");

    const emphasis = await doctor(configNaming(HELD), answeringAs("_x_"));
    expect(emphasis.stdout).toContain("model reachable: x answered a test question");
    expect(emphasis.stdout).not.toContain("_x_");

    const hostile = `evil\u0007<!channel>\n${"x".repeat(100)}`;
    const result = await doctor(configNaming(HELD), answeringAs(hostile));
    const shown = `evilchannel${"x".repeat(68)}…`;
    expect(result.stdout).toContain(`${shown} answered a test question`);
    const [first] = notes(result.stdout);
    expect(first).toContain(`the server answers as ${shown}, not ${HELD}`);
    for (const unsafe of ["\u0007", "<", ">", "!channel"]) {
      expect(result.stdout).not.toContain(unsafe);
    }
  });

  it("says once that the store could not be read, never quoting its secrets", async () => {
    const refusing: SqlConnect = (url) => {
      const client = world.connect(url);
      return {
        ...client,
        query: (text, params) =>
          text.includes("question_sets_in_force")
            ? Promise.reject(
                new Error(
                  `permission denied for table question_sets_in_force (${ENV.DATABASE_URL})`,
                ),
              )
            : client.query(text, params),
      };
    };
    const result = await doctor(configNaming(HELD), answeringAs(OTHER), refusing);
    expect(notes(result.stdout)).toEqual([
      ownName,
      "warn  model name: the store could not be read, so no source's model was compared with the one its version is held to: permission denied for table question_sets_in_force (***)",
    ]);
    expect(result.stdout + result.stderr).not.toContain(STORE_PASSWORD);
  });
});
