import {
  type AnswerEntry,
  type BackfillDeps,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  stateHash,
} from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase } from "@facetdb/core/testing";
import {
  createFakeProvider,
  DEFAULT_MAX_ATTEMPTS,
  type FakeFailure,
  type FakeProvider,
  RetryableError,
} from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  choice,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
} from "../../config/index.ts";
import { wireBackfill } from "../backfill-wiring.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlConnect,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb backfill --question` asks the model through the provider `wireBackfill` hands the
 * engine, the composition root's door for the command, and that provider carries the worker's
 * backoff and in-flight limit. A 429 or a 529 is waited out on the clock and the record's answer is
 * still written; at most 8 requests are in flight, 4 after a 429. Without the wrapping the bare
 * provider's 429 fails the record and nothing caps the calls.
 */

const KEYS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;
const PROJECT = { id: "listings-app", name: "listings-app" };
const SOURCE_ID = sourceIdOf(PROJECT.id, "listings");
/** Fixed jitter: the first backoff of 500 ms loses 0.2 * 0.5 of itself, 450 ms. */
const RANDOM = 0.5;
const FIRST_BACKOFF_MS = 450;

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:pw@localhost:5432/app",
      table: "listings",
      read: ["id", "title"],
      questions: {
        is_scam: noul("Is this listing a scam?"),
        category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
      },
    },
  ],
});
const [firstSource] = config.sources;
if (firstSource === undefined) {
  throw new Error("the fixture config has a source");
}
const source: SourceConfig = firstSource;
const questionSet = questionSetOf(config, source);

/** The driver the command never reaches: a backfill reads its source through the connector. */
const noDatabase: SqlConnect = () => {
  throw new Error("backfill reaches the database only through its connector");
};

let world: PgliteWorld;
let store: Store;
let clock: FakeClock;
let db: FakeDatabase;
let connector: FakeConnector;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  clock = new FakeClock(Date.UTC(2026, 10, 18, 9, 0, 0));
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  db = new FakeDatabase({ fields: ["id", "title"], pageSize: 10 });
  connector = new FakeConnector(db);
  await connector.install();
  for (const key of KEYS) {
    db.edit(key, { id: key, title: `Listing ${key}` });
  }
  // The rows existed before FacetDB was installed: the trigger queued none of them.
  db.jobs.clear();
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** The wiring the composition root makes for `facetdb backfill` (main.ts), over these fakes. */
function wire(provider: ModelProvider): Promise<BackfillDeps> {
  return wireBackfill({
    config,
    source,
    project: PROJECT,
    store,
    connector,
    provider,
    clock,
    random: () => RANDOM,
    channels: [],
    report: () => undefined,
  });
}

/** What a prior whole-set run left: every record answered for `is_scam` only, at its current state. */
async function seedFirstQuestion(): Promise<void> {
  await store.ensureProject(PROJECT);
  await store.ensureSource({ projectId: PROJECT.id, name: source.name, kind: "plugin" });
  const { version } = await store.questionSets.record(SOURCE_ID, questionSet);
  const log = store.log(SOURCE_ID);
  for (const key of KEYS) {
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version,
      model: questionSet.model,
      stateHash: stateHash(questionSet.read, { id: key, title: `Listing ${key}` }),
      answers: { is_scam: { type: "noul", probability: 0.02 } },
      usage: { inputTokens: 10, outputTokens: 0 },
      at: new Date(0),
    };
    await log.appendAnswer(entry);
  }
}

function backfill(argv: readonly string[], provider: ModelProvider) {
  return runInProcess(
    argv,
    {
      projectDir: "/work/listings-app",
      env: {},
      loadConfig: () => Promise.resolve(config),
      engines: postgresEngines(noDatabase),
      connect: noDatabase,
      backfill: async () => ({ deps: await wire(provider), close: () => Promise.resolve() }),
    },
    COMMANDS,
  );
}

/** Every record's `category` answer in the store's log, by key. */
async function categoryAnswers(): Promise<Map<string, unknown>> {
  const latest = await store.log(SOURCE_ID).latestAnswers([...KEYS]);
  return new Map([...latest].map(([key, entry]) => [key, entry.answers["category"]]));
}

describe("facetdb backfill --question behind the worker's backoff", () => {
  it.each([
    { status: "429", failure: { kind: "429" } as FakeFailure, waited: FIRST_BACKOFF_MS },
    { status: "529", failure: { kind: "529" } as FakeFailure, waited: FIRST_BACKOFF_MS },
    {
      status: "529 with retry-after",
      failure: { kind: "529", retryAfterMs: 3_000 } as FakeFailure,
      waited: 3_000,
    },
  ])(
    "a $status waits the backoff on the clock, then writes the answer @timing",
    async ({ failure, waited }) => {
      await seedFirstQuestion();
      const provider = createFakeProvider({ defaults: { choice: 0 }, failures: { 0: failure } });

      const result = await backfill(["backfill", "--yes", "--question", "category"], provider);

      expect(result.code, result.stderr).toBe(0);
      // Six records, one asked twice: the failed call, then its retry after the wait.
      expect(provider.callCount).toBe(KEYS.length + 1);
      const retried = provider.requests[0]?.state["id"];
      expect(provider.requests.filter((request) => request.state["id"] === retried)).toHaveLength(
        2,
      );
      expect(clock.sleeps).toContain(waited);
      expect(result.stdout).toContain("Done: 6 answered.\n");
      const answers = await categoryAnswers();
      for (const key of KEYS) {
        expect(answers.get(key)).toMatchObject({ type: "choice", top: "car" });
        expect(db.decisionOf(key)?.status).toBe("done");
      }
    },
  );

  it("a 429 on every attempt is an error for that record, never an answer @timing", async () => {
    await seedFirstQuestion();
    const fake = createFakeProvider({ defaults: { choice: 0 } });
    // r4 is rate limited on every attempt; the other records are answered.
    const r4Attempts: ProviderRequest[] = [];
    const provider: ModelProvider = {
      ask: (request) => {
        if (request.state["id"] !== "r4") {
          return fake.ask(request);
        }
        r4Attempts.push(request);
        return Promise.reject(new RetryableError(429, undefined));
      },
    };

    const result = await backfill(["backfill", "--yes", "--question", "category"], provider);

    expect(result.code).toBe(1);
    // The backoff's attempts per call (DEFAULT_MAX_ATTEMPTS), each wait on the clock between them.
    expect(r4Attempts).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    expect(clock.sleeps).toContain(FIRST_BACKOFF_MS);
    const answers = await categoryAnswers();
    expect(answers.get("r4")).toBeUndefined();
    expect(db.decisionOf("r4")?.status).not.toBe("done");
    for (const key of KEYS.filter((key) => key !== "r4")) {
      expect(answers.get(key)).toMatchObject({ type: "choice", top: "car" });
    }
  });
});

/**
 * A provider that holds every call until the test lets it go, counting how many it holds at once:
 * what reaches it is what the wired provider let through.
 */
function heldProvider(fake: FakeProvider) {
  const held: (() => void)[] = [];
  let inFlight = 0;
  let most = 0;
  return {
    ask: async (request: ProviderRequest): Promise<ProviderResponse> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise<void>((resolve) => held.push(resolve));
        return await fake.ask(request);
      } finally {
        inFlight -= 1;
      }
    },
    release: (): void => {
      held.shift()?.();
    },
    get held() {
      return held.length;
    },
    get most() {
      return most;
    },
  };
}

/** Lets every promise that can settle without the test settle. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function requestFor(key: string): ProviderRequest {
  return {
    model: questionSet.model,
    state: { id: key, title: `Listing ${key}` },
    questions: questionSet.questions.filter((question) => question.name === "category"),
  };
}

describe("the backfill's in-flight limit", () => {
  it("lets at most 8 requests reach the model at once, the rest wait for a slot", async () => {
    const provider = heldProvider(createFakeProvider({ defaults: { choice: 0 } }));
    const deps = await wire(provider);

    const asks = Array.from({ length: 12 }, (_, n) => deps.worker.ask(requestFor(`r${n}`)));
    await flush();

    expect(provider.held).toBe(8);
    provider.release();
    await flush();
    expect(provider.held).toBe(8);
    while (provider.held > 0) {
      provider.release();
      await flush();
    }
    await Promise.all(asks);
    expect(provider.most).toBe(8);
  });

  it("halves the limit to 4 after a 429 @timing", async () => {
    const provider = heldProvider(
      createFakeProvider({ defaults: { choice: 0 }, failures: { 0: { kind: "429" } } }),
    );
    const deps = await wire(provider);

    const first = deps.worker.ask(requestFor("r0"));
    await vi.waitFor(() => expect(provider.held).toBe(1));
    provider.release();
    // The 429 is waited out on the clock and asked again.
    await vi.waitFor(() => expect(provider.held).toBe(1));
    expect(clock.sleeps).toEqual([FIRST_BACKOFF_MS]);
    provider.release();
    await first;

    const asks = Array.from({ length: 12 }, (_, n) => deps.worker.ask(requestFor(`r${n + 1}`)));
    await flush();

    expect(provider.held).toBe(4);
    while (provider.held > 0) {
      provider.release();
      await flush();
    }
    await Promise.all(asks);
    expect(provider.most).toBe(4);
  });
});
