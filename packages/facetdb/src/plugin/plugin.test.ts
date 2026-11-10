import { readFileSync } from "node:fs";
import {
  type Connector,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  type ScanPage,
  type StateValue,
  stateHash,
  type WriteResult,
} from "@facetdb/core";
import { runConnectorContract } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { noul, score } from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  channel,
  definePlugin,
  type Infer,
  loadPlugin,
  type Plugin,
  type PluginContext,
  PluginError,
  pack,
  provider,
  type SourceDefinition,
  type SourcePage,
  type SourceRow,
  satisfies,
  source,
  z,
} from "./index.ts";

/** The GitHub plugin skeleton, with the manifest fields it leaves out. */
const githubConfig = z.object({ repo: z.string(), token: z.secret() });
type GithubContext = PluginContext<Infer<typeof githubConfig>>;

function githubPlugin() {
  return definePlugin({
    name: "github",
    version: "1.2.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: githubConfig,
    sources: {
      issues: source({
        watch: async function* (ctx: GithubContext) {
          yield [`${ctx.config.repo}#1`];
        },
        read: async (ctx: GithubContext, keys) =>
          keys.map((key) => ({ key, state: { title: ctx.config.repo, body: "" } })),
        scan: async function* () {
          yield { rows: [], next: null };
        },
      }),
    },
    actions: {
      label: action({
        config: z.object({ add: z.array(z.string()), remove: z.array(z.string()).optional() }),
        run: async (ctx: GithubContext, record, decisions, cfg) => {
          // The author's types: the plugin config in ctx, the action's own settings in cfg.
          expect(typeof ctx.config.repo).toBe("string");
          expect(cfg.add).toBeInstanceOf(Array);
          expect(record.key).toBeDefined();
          expect(decisions).toBeDefined();
        },
      }),
    },
  });
}

describe("facetdb/plugin as a consumer sees it", () => {
  it("resolves through the package's exports and exposes the authoring API", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    expect(manifest.exports["./plugin"]).toBe("./src/plugin/index.ts");

    const consumer = await import("facetdb/plugin");
    for (const name of ["definePlugin", "source", "action", "channel", "provider", "pack", "z"]) {
      expect(consumer).toHaveProperty(name);
    }
    expect(typeof consumer.definePlugin).toBe("function");
  });
});

describe("definePlugin", () => {
  it("accepts the GitHub skeleton and derives the manifest", () => {
    const plugin = githubPlugin();
    expect(plugin.manifest).toMatchObject({
      name: "github",
      version: "1.2.0",
      kinds: ["source", "action"],
      secrets: ["token"],
      coreVersions: ">=0.0.0 <1.0.0",
    });
    expect(Object.keys(plugin.sources)).toEqual(["issues"]);
    expect(Object.keys(plugin.actions)).toEqual(["label"]);
    // One schema for both audiences: the manifest carries the very schema that validates the config.
    expect(plugin.manifest.config.safeParse({ repo: "a/b", token: "t" }).success).toBe(true);
    expect(plugin.manifest.config.safeParse({ repo: "a/b" }).success).toBe(false);
  });

  it("lists secrets through optional wrappers and leaves plain strings out", () => {
    const plugin = definePlugin({
      name: "facetdb-plugin-chat",
      version: "0.1.0",
      facetdb: "^0.0.0",
      config: z.object({ channel: z.string(), webhook: z.secret().optional(), token: z.secret() }),
      channels: {
        post: channel({ config: z.object({}), deliver: async () => {} }),
      },
    });
    expect(plugin.manifest.secrets).toEqual(["webhook", "token"]);
    expect(plugin.manifest.kinds).toEqual(["channel"]);
  });

  it("refuses a missing config schema and names the field", () => {
    const withoutConfig = {
      name: "github",
      version: "1.0.0",
      facetdb: "^0.0.0",
      actions: { label: action({ config: z.object({}), run: async () => {} }) },
    };
    expect(() => definePlugin(withoutConfig as never)).toThrow(PluginError);
    expect(() => definePlugin(withoutConfig as never)).toThrow(/config: is missing/);
    const issues = catchIssues(() => definePlugin(withoutConfig as never));
    expect(issues.map((issue) => issue.field)).toEqual(["config"]);
  });

  it("refuses a config that is not an object schema", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "github",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.string() as never,
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      }),
    );
    expect(issues).toEqual([{ field: "config", message: expect.stringContaining("z.object") }]);
  });

  it("refuses a bad version, a bad core range and a bad name, each by field", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "GitHub Plugin",
        version: "one",
        facetdb: "latest",
        config: z.object({}),
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      }),
    );
    expect(issues.map((issue) => issue.field)).toEqual(["name", "version", "facetdb"]);
  });

  it("refuses a plugin that provides nothing", () => {
    const issues = catchIssues(() =>
      definePlugin({ name: "empty", version: "1.0.0", facetdb: "^0.0.0", config: z.object({}) }),
    );
    expect(issues[0]?.message).toContain("at least one of sources, actions");
  });

  it("refuses an entry that was not made by its helper, or lacks its function or settings schema", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "broken",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        sources: { Issues: { watch: () => {} } as never },
        actions: {
          label: action({ config: z.object({}), run: undefined as never }),
          other: { kind: "action", run: async () => {} } as never,
        },
        providers: {
          model: provider({ config: undefined as never, ask: undefined as never }),
        },
      }),
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "sources.Issues",
      "sources.Issues",
      "actions.label.run",
      "actions.other.config",
      "providers.model.ask",
      "providers.model.config",
    ]);
  });

  it("checks a question pack with the config's own question rules", () => {
    const good = definePlugin({
      name: "triage",
      version: "1.0.0",
      facetdb: "^0.0.0",
      config: z.object({}),
      packs: {
        support: pack({
          description: "Support triage",
          questions: {
            urgency: score("How urgent is it?", ["low", "high"], {
              thresholds: { confidenceAtLeast: 0.6 },
            }),
            wants_refund: noul("Is the customer asking for money back?", { stakes: "high" }),
          },
        }),
      },
    });
    expect(good.packs["support"]?.questions.map((q) => q.name)).toEqual([
      "urgency",
      "wants_refund",
    ]);
    expect(good.packs["support"]?.thresholds).toEqual({ urgency: { confidenceAtLeast: 0.6 } });

    const issues = catchIssues(() =>
      definePlugin({
        name: "triage",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        packs: { support: pack({ questions: { facetdb_x: noul("Is it a reserved name?") } }) },
      }),
    );
    expect(issues).toEqual([
      { field: "packs.support", message: expect.stringContaining("facetdb_x") },
    ]);
  });
});

describe("loadPlugin", () => {
  const modules = (known: Record<string, unknown>) => ({
    coreVersion: VERSION,
    importModule: async (specifier: string): Promise<unknown> => {
      if (specifier in known) {
        return known[specifier];
      }
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
  });

  it("resolves a short name to @facetdb/<name>, then to facetdb-plugin-<name>", async () => {
    const plugin = githubPlugin();
    expect(await loadPlugin("github", modules({ "@facetdb/github": { default: plugin } }))).toBe(
      plugin,
    );
    expect(
      await loadPlugin("github", modules({ "facetdb-plugin-github": { default: plugin } })),
    ).toBe(plugin);
    expect(
      await loadPlugin(
        "facetdb-plugin-github",
        modules({ "facetdb-plugin-github": { default: plugin } }),
      ),
    ).toBe(plugin);
  });

  it("refuses a plugin whose core range excludes the running version, naming the field", async () => {
    const future = definePlugin({
      name: "github",
      version: "3.0.0",
      facetdb: "^2.0.0",
      config: z.object({}),
      packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
    });
    const attempt = loadPlugin("github", modules({ "@facetdb/github": { default: future } }));
    await expect(attempt).rejects.toThrow(
      /facetdb: supports FacetDB \^2\.0\.0, but this is FacetDB 0\.0\.0/,
    );
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as PluginError).issues.map((issue) => issue.field)).toEqual(["facetdb"]);
  });

  it("says what to do when no package is installed, when the name is wrong and when the export is not a plugin", async () => {
    await expect(loadPlugin("github", modules({}))).rejects.toThrow(/run `facetdb add github`/);
    await expect(loadPlugin("./local/thing", modules({}))).rejects.toThrow(
      /name: a plugin is named/,
    );
    await expect(
      loadPlugin("github", modules({ "@facetdb/github": { default: { name: "github" } } })),
    ).rejects.toThrow(/default export: is not a plugin/);
    await expect(
      loadPlugin("slack", modules({ "@facetdb/slack": { default: githubPlugin() } })),
    ).rejects.toThrow(/calls itself "github", not "slack"/);
  });

  it("lets a plugin that breaks while loading fail as itself", async () => {
    const options = {
      coreVersion: VERSION,
      importModule: async () => {
        throw new SyntaxError("unexpected token");
      },
    };
    await expect(loadPlugin("github", options)).rejects.toThrow(SyntaxError);
  });
});

describe("the core version range", () => {
  it.each([
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.4.0", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["0.0.0", "*", true],
    ["1.9.9", "1.x", true],
    ["2.0.0", "1", false],
    ["1.2.7", "1.2", true],
    ["3.1.0", "^1.0.0 || ^3.0.0", true],
    ["2.1.0", "^1.0.0 || ^3.0.0", false],
    ["1.0.0", "1.0.0", true],
    ["1.0.1", "1.0.0", false],
    ["1.5.0-beta.1", "^1.0.0", false],
    ["1.5.0-beta.1", "^1.5.0-beta.0", true],
    ["1.0.0-rc.1", "<1.0.0", false],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("reads an invalid range or version as not satisfied", () => {
    expect(satisfies("1.0.0", "latest")).toBe(false);
    expect(satisfies("1.0", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "1.0.0 - 2.0.0")).toBe(false);
  });
});

// A defined source plugin passes the connector contract through an in-memory adapter.
describe("a defined source plugin", () => {
  const fields = ["title", "body"] as const;
  runConnectorContract(async () => {
    const service = new IssueTracker();
    const plugin = definePlugin({
      name: "tracker",
      version: "1.0.0",
      facetdb: "^0.0.0",
      config: z.object({ pageSize: z.number() }),
      sources: { issues: trackerSource(service) },
    });
    const issues = plugin.sources["issues"];
    if (issues === undefined) {
      throw new Error("the tracker plugin has no issues source");
    }
    const store = new MemoryStore();
    const make = () =>
      new SourceAdapter({
        plugin: issues,
        ctx: { config: { pageSize: 10 }, secrets: {} },
        fields,
        store,
        changeCount: () => service.changes.length,
      });
    return {
      connector: make(),
      peer: make(),
      fields,
      edit: async (key, state) => {
        service.edit(key, state);
      },
      decisionOf: async (key) => store.decisions.get(key) ?? null,
    };
  });
});

function catchIssues(define: () => Plugin): readonly { field: string; message: string }[] {
  try {
    define();
  } catch (error) {
    if (error instanceof PluginError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("definePlugin accepted a definition it should have refused");
}

// --- the external service a source plugin watches, and the adapter that lets core use it ---------

type TrackerState = Readonly<Record<string, StateValue>>;

/** An issue tracker: the thing outside FacetDB. Its feed is what a real plugin gets from webhooks. */
class IssueTracker {
  readonly issues = new Map<RecordKey, { seq: number; state: TrackerState }>();
  readonly changes: RecordKey[] = [];
  readonly #waiters: (() => void)[] = [];
  #seq = 1;

  edit(key: RecordKey, state: TrackerState): void {
    this.issues.set(key, { seq: this.issues.get(key)?.seq ?? this.#seq++, state });
    this.changes.push(key);
    for (const wake of this.#waiters.splice(0)) {
      wake();
    }
  }

  /** Resolves when the log passes `after` entries, or when `signal` aborts. */
  nextChange(after: number, signal: AbortSignal): Promise<void> {
    if (this.changes.length > after || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

/** The plugin under test: watch, read and scan over the tracker, newest first, three to a page. */
function trackerSource(service: IssueTracker): SourceDefinition<{ pageSize: number }> {
  return source<{ pageSize: number }>({
    watch: async function* (ctx) {
      let seen = service.changes.length;
      for (;;) {
        await service.nextChange(seen, ctx.signal);
        if (ctx.signal.aborted) {
          return;
        }
        const batch = service.changes.slice(seen);
        seen += batch.length;
        yield batch;
      }
    },
    read: async (_ctx, keys) =>
      keys.flatMap((key) => {
        const issue = service.issues.get(key);
        return issue === undefined ? [] : [{ key, state: issue.state }];
      }),
    scan: async function* (ctx, cursor) {
      let bound = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
      for (;;) {
        const candidates = [...service.issues.entries()]
          .filter(([, issue]) => issue.seq < bound)
          .sort(([, a], [, b]) => b.seq - a.seq);
        const page = candidates.slice(0, ctx.config.pageSize);
        const last = page.at(-1);
        const next =
          candidates.length > page.length && last !== undefined ? String(last[1].seq) : null;
        const result: SourcePage = {
          rows: page.map(([key, issue]) => ({ key, state: issue.state })),
          next,
        };
        yield result;
        if (next === null) {
          return;
        }
        bound = Number(next);
      }
    },
  });
}

/** FacetDB's side of a source plugin: the queue and the decisions, shared by every worker. */
class MemoryStore {
  readonly decisions = new Map<RecordKey, RecordDecision>();
  readonly jobs = new Map<RecordKey, string | null>();
  /** While the change capture runs: the tracker's change count when it started, and how many it queued. */
  capture: { readonly base: number; queued: number } | undefined;
}

type AdapterParts = {
  readonly plugin: SourceDefinition<{ pageSize: number }>;
  /** The plugin's config and secrets; the adapter adds the signal of each call. */
  readonly ctx: Omit<PluginContext<{ pageSize: number }>, "signal">;
  readonly fields: readonly string[];
  readonly store: MemoryStore;
  /** How many changes the tracker has logged so far. */
  readonly changeCount: () => number;
};

let workerCount = 0;

/**
 * Makes a source plugin a `Connector`: watch, read and scan come from the plugin; the queue and the
 * decisions are FacetDB's (here in memory). `install` starts the change capture, which queues every
 * key the plugin's watch yields, the way a trigger queues in the application's own write.
 */
class SourceAdapter implements Connector {
  readonly capabilities = {
    inlineColumns: false,
    pushWakeup: true,
    transactions: false,
    sideTable: false,
    multipleWorkers: true,
  };
  readonly #parts: AdapterParts;
  readonly #worker = `worker-${workerCount++}`;
  #capture: AsyncIterator<readonly RecordKey[]> | undefined;
  #stop: AbortController | undefined;

  constructor(parts: AdapterParts) {
    this.#parts = parts;
  }

  async install(): Promise<void> {
    const { plugin, store, changeCount } = this.#parts;
    if (this.#capture !== undefined) {
      return;
    }
    this.#stop = new AbortController();
    const capture = plugin.watch(this.#ctx(this.#stop.signal))[Symbol.asyncIterator]();
    this.#capture = capture;
    const state = { base: changeCount(), queued: 0 };
    store.capture = state;
    const pump = async (): Promise<void> => {
      for (;;) {
        const batch = await capture.next();
        if (batch.done === true) {
          return;
        }
        for (const key of batch.value) {
          if (!store.jobs.has(key)) {
            store.jobs.set(key, null);
          }
        }
        state.queued += batch.value.length;
      }
    };
    void pump();
  }

  async uninstall(): Promise<void> {
    // A waiting `watch` only ends through its signal; `return()` would queue behind its pending wait.
    this.#stop?.abort();
    await this.#capture?.return?.();
    this.#capture = undefined;
    this.#parts.store.capture = undefined;
    this.#parts.store.jobs.clear();
    this.#parts.store.decisions.clear();
  }

  watch(): AsyncIterable<readonly RecordKey[]> {
    return this.#parts.plugin.watch(this.#ctx());
  }

  async read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const rows = await this.#parts.plugin.read(this.#ctx(), keys);
    const found = new Set(rows.map((row) => row.key));
    return {
      rows: rows.map((row) => this.#readRow(row)),
      missing: keys.filter((k) => !found.has(k)),
    };
  }

  async write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const { plugin, fields, store } = this.#parts;
    const [row] = await plugin.read(this.#ctx(), [key]);
    if (row === undefined || stateHash(fields, row.state) !== expectedHash) {
      return { written: false };
    }
    // `facetdb_reviewed` is never cleared once a person has decided.
    const reviewed = decision.reviewed ?? store.decisions.get(key)?.reviewed;
    store.decisions.set(key, reviewed === true ? { ...decision, reviewed } : decision);
    return { written: true };
  }

  async scan(cursor: string | null): Promise<ScanPage> {
    const pages = this.#parts.plugin.scan(this.#ctx(), cursor)[Symbol.asyncIterator]();
    const first = await pages.next();
    await pages.return?.();
    if (first.done === true) {
      return { rows: [], next: null };
    }
    return { rows: first.value.rows.map((row) => this.#readRow(row)), next: first.value.next };
  }

  async enqueue(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (!this.#parts.store.jobs.has(key)) {
        this.#parts.store.jobs.set(key, null);
      }
    }
  }

  async claim(limit: number): Promise<readonly RecordKey[]> {
    await this.#captureCaughtUp();
    const claimed: RecordKey[] = [];
    for (const [key, owner] of this.#parts.store.jobs) {
      if (claimed.length < limit && owner === null) {
        this.#parts.store.jobs.set(key, this.#worker);
        claimed.push(key);
      }
    }
    return claimed;
  }

  async claimKey(key: RecordKey): Promise<boolean> {
    await this.#captureCaughtUp();
    if (this.#parts.store.jobs.has(key)) {
      return false;
    }
    this.#parts.store.jobs.set(key, this.#worker);
    return true;
  }

  async ack(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (this.#parts.store.jobs.get(key) === this.#worker) {
        this.#parts.store.jobs.delete(key);
      }
    }
  }

  async release(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (this.#parts.store.jobs.get(key) === this.#worker) {
        this.#parts.store.jobs.set(key, null);
      }
    }
  }

  /** The context of one call; only the change capture ever has a signal that fires. */
  #ctx(signal: AbortSignal = new AbortController().signal): PluginContext<{ pageSize: number }> {
    return { ...this.#parts.ctx, signal };
  }

  #readRow(row: SourceRow): ReadRow {
    return {
      key: row.key,
      state: row.state,
      hash: stateHash(this.#parts.fields, row.state),
      excluded: false,
    };
  }

  /**
   * A database queues a key inside the application's write; here the capture runs a turn later, so
   * a claim first waits until it has queued every change the tracker has logged since install.
   */
  async #captureCaughtUp(): Promise<void> {
    const { store, changeCount } = this.#parts;
    while (
      store.capture !== undefined &&
      store.capture.base + store.capture.queued < changeCount()
    ) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
}
