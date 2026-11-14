import type {
  Clock,
  Question,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { migrate, type TableSource, uninstall } from "../install/index.ts";
import type { StorageMode } from "../scan/index.ts";
import type { SqlClient } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { createPostgresConnector, type Installer, type PostgresConnector } from "./connector.ts";

/**
 * The world the trigger-and-jobs connector tests share (capture.test.ts and
 * capture-contract.test.ts, split by subject so no file passes 10 s): one PGlite per test
 * file with the application's table, the install through `facetdb migrate`, and the connectors
 * over it. Each file calls `useCaptureWorld()` once at its top.
 */

export const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const project = { id: "proj_listings", name: "Listings" };
const PASSWORD = "a-long-random-password";

/** A fake clock whose sleep lets the event loop turn, so a polling watch cannot starve the test's I/O. */
class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A clock whose sleep never ends: only a notification can wake a watch under it. */
export class FrozenClock implements Clock {
  now(): number {
    return 1_700_000_000_000;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

/** What a world may differ in besides its storage mode and `onChange`. */
export type WorldOptions = {
  /** The application's primary key type. Defaults to `text`. */
  readonly keyType?: "text" | "integer";
  /** The questions asked of the table. Defaults to `questionSet`'s one noul. */
  readonly questions?: readonly Question[];
};

/** One PGlite with the application's table; the admin and the workers share its single connection. */
export class World {
  readonly clock = new TurningClock(1_700_000_000_000);
  readonly open: PostgresConnector[] = [];
  pg!: PgliteWorld;
  installed = false;
  readonly storage: StorageMode;
  readonly onChange: "reset" | "keep";
  readonly keyType: "text" | "integer";
  readonly questionSet: QuestionSet;
  constructor(
    storage: StorageMode = "inline",
    onChange: "reset" | "keep" = "reset",
    options: WorldOptions = {},
  ) {
    this.storage = storage;
    this.onChange = onChange;
    this.keyType = options.keyType ?? "text";
    this.questionSet =
      options.questions === undefined
        ? questionSet
        : { ...questionSet, questions: options.questions };
  }

  async create(): Promise<this> {
    this.pg = engine;
    await this.pg.client.query(
      `create table public.listings (id ${this.keyType} primary key, title text, body text)`,
    );
    return this;
  }

  get source(): TableSource {
    return { table: "listings", key: "id", storage: this.storage, onChange: this.onChange };
  }

  /** `facetdb migrate` / `uninstall` with the admin credential, which never reaches the connector. */
  installer(): Installer {
    return {
      install: async () => {
        const result = await migrate({
          adminUrl: "pglite://admin",
          connect: this.pg.connect,
          print: () => undefined,
          plan: {
            source: this.source,
            questionSet: this.questionSet,
            project,
            workerPassword: PASSWORD,
          },
        });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        this.installed = true;
      },
      uninstall: async () => {
        if (!this.installed) {
          return;
        }
        const result = await uninstall({
          adminUrl: "pglite://admin",
          connect: this.pg.connect,
          source: { table: "listings", name: "listings", projectId: "proj_listings" },
          print: () => undefined,
          confirm: ({ project: asked }) => Promise.resolve(asked.name),
        });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        this.installed = false;
      },
    };
  }

  connector(
    options: { workerId?: string; clock?: Clock; pollMs?: number } = {},
  ): PostgresConnector {
    const connector = createPostgresConnector({
      workerUrl: "pglite://worker",
      source: this.source,
      questionSet: this.questionSet,
      clock: options.clock ?? this.clock,
      pollMs: options.pollMs ?? 50,
      scanPageSize: 10,
      workerId: options.workerId ?? "w1",
      installer: this.installer(),
      connect: () => this.pg.client,
    });
    this.open.push(connector);
    return connector;
  }

  /** The application's own write: insert or update the state fields; the trigger queues the key. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.pg.client.query(
      `insert into public.listings (id, title, body) values ($1, $2, $3)
       on conflict (id) do update set title = excluded.title, body = excluded.body`,
      [key, state["title"] ?? null, state["body"] ?? null],
    );
  }

  /** Where the decision lives: the table in inline mode, `facetdb.listings_answers` in side-table mode. */
  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const relation = this.storage === "side-table" ? `facetdb.listings_answers` : `public.listings`;
    const rows = await this.pg.client.query(
      `select facetdb_status as status, facetdb_updated_at as written, not_priority as value,
              not_priority_probability as probability, facetdb_reviewed as reviewed
         from ${relation} where id = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined || row["written"] === null || row["written"] === undefined) {
      return null;
    }
    return {
      decisions:
        row["value"] === null || row["probability"] === null
          ? {}
          : {
              not_priority: {
                kind: "decided",
                value: row["value"] as boolean,
                probabilityOrConfidence: Number(row["probability"]),
              },
            },
      status: String(row["status"]) as RecordDecision["status"],
      ...(row["reviewed"] === true ? { reviewed: true as const } : {}),
    };
  }

  async statusOf(key: RecordKey): Promise<string | null> {
    const relation =
      this.storage === "side-table" ? `public.listings_with_answers` : `public.listings`;
    const rows = await this.pg.client.query(
      `select facetdb_status as status from ${relation} where id = $1`,
      [key],
    );
    return rows[0] === undefined ? null : String(rows[0]["status"]);
  }

  async queued(): Promise<string[]> {
    const rows = await this.pg.client.query(`select record_key from facetdb.jobs order by 1`);
    return rows.map((row) => String(row["record_key"]));
  }

  /** The worker holding a queued key, or null when it is waiting. */
  async claimOf(queuedKey: string): Promise<string | null> {
    const rows = await this.pg.client.query(
      `select claimed_by from facetdb.jobs where record_key = $1`,
      [queuedKey],
    );
    return rows[0] === undefined ? null : (rows[0]["claimed_by"] as string | null);
  }

  /** Closes the connectors and empties the file's engine for the next test. */
  async close(): Promise<void> {
    for (const connector of this.open.splice(0)) {
      await connector.close();
    }
    await resetPgliteWorld(this.pg);
  }
}

/** The test file's engine: booted once, emptied after every test by `World.close` (a boot cost 440 ms). */
let engine: PgliteWorld;
const worlds: World[] = [];

/** Boots the file's engine before its first test, closes each test's worlds after it, and the engine at the end. */
export function useCaptureWorld(): void {
  beforeAll(async () => {
    engine = await createPgliteWorld();
  });

  afterEach(async () => {
    for (const world of worlds.splice(0)) {
      await world.close();
    }
  });

  afterAll(async () => {
    await engine.close();
  });
}

/** A world on the emptied engine, closed (its connectors, then a reset) after the test. */
export async function newWorld(
  storage: StorageMode = "inline",
  onChange: "reset" | "keep" = "reset",
  options: WorldOptions = {},
): Promise<World> {
  const world = await new World(storage, onChange, options).create();
  worlds.push(world);
  return world;
}

export const decided = (): RecordDecision => ({
  decisions: { not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
  status: "done",
});

/**
 * A connector whose client records the text of every statement it sends, those inside a
 * transaction marked so, through the same `connect` parameter production uses.
 */
export function recordingConnector(world: World): {
  connector: PostgresConnector;
  statements: string[];
} {
  const statements: string[] = [];
  const inner = world.pg.client;
  const client: SqlClient = {
    ...inner,
    query: (text, params) => {
      statements.push(text);
      return inner.query(text, params);
    },
    pipeline: (text, paramSets) => {
      statements.push(`pipeline of ${paramSets.length} one-key runs: ${text}`);
      expect(paramSets.every((params) => params.length === 1)).toBe(true);
      return inner.pipeline(text, paramSets);
    },
    transaction: (work) =>
      inner.transaction((query) =>
        work((text, params) => {
          statements.push(`in transaction: ${text}`);
          return query(text, params);
        }),
      ),
  };
  const connector = createPostgresConnector({
    workerUrl: "pglite://worker",
    source: world.source,
    questionSet: world.questionSet,
    clock: world.clock,
    workerId: "w1",
    installer: world.installer(),
    connect: () => client,
  });
  world.open.push(connector);
  return { connector, statements };
}

/** The application inserts `count` records; the trigger queues each. Returns their keys, sorted. */
export async function editMany(world: World, count: number): Promise<RecordKey[]> {
  const keys = Array.from({ length: count }, (_, i) => `r${String(i + 1).padStart(2, "0")}`);
  for (const key of keys) {
    await world.edit(key, { title: "a", body: "b" });
  }
  return keys;
}

export async function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T | "quiet"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Promise<"quiet">((resolve) => {
    timer = setTimeout(() => resolve("quiet"), ms);
  });
  try {
    return await Promise.race([pending, quiet]);
  } finally {
    clearTimeout(timer);
  }
}
