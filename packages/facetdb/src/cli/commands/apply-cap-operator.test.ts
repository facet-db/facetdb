import type { Asker, ConfigDraft, ReloadSummary, SpendingSettings } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  type ConfigFiles,
  configFileSource,
  facetdb,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import { configFileDoor } from "./config-reload.ts";

/**
 * On the real config file door: a project draft from anyone but the operator that loosens the
 * spending cap is refused against the stricter of the cap in force and the file's as it loads now,
 * inside the door's queue, so a hand edit no reload has put in force yet is never written over, and
 * a Check again racing a reviewer's write leaves nothing between the judgment and the write. The
 * file, git, the loader and the reload are fakes; the queue is the door's own.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const ENV = { DATABASE_URL: URL };
const REVIEWER: Asker = { operator: false };
const OPERATOR: Asker = { operator: true };

/** The project with these spending settings, as the loader returns it. */
function project(spending: Partial<SpendingSettings>): ProjectConfig {
  const config = facetdb({
    model: "jev-1.14.0",
    ...spending,
    sources: [
      {
        name: "listings",
        database: URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
  return {
    ...config,
    sources: config.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
  };
}

/**
 * The worker over a config file: `inForce` is what the gate enforces (a reload puts the file's in
 * force), `file` what facetdb.config.ts holds, edited by hand by setting it. Every read, load and
 * reload is logged in order; `writes` is every text written.
 */
function worker(start: { inForce: ProjectConfig; file: ProjectConfig; holdReload?: boolean }) {
  const state = { inForce: start.inForce, file: start.file, writes: [] as string[] };
  const log: string[] = [];
  /**
   * With `holdReload`, a reload holds the queue until `release`; `reloadStarted` resolves once one
   * has begun. Without it, a reload runs at once.
   */
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const reloadStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const files: ConfigFiles = {
    read: () => {
      log.push("read");
      return Promise.resolve({ kind: "file", text: configFileSource(state.file) });
    },
    replace: (_path, text) => {
      state.writes.push(text);
      return Promise.resolve();
    },
    gitState: () => Promise.resolve({ kind: "clean" }),
  };
  const reload = async (): Promise<ReloadSummary> => {
    log.push("reload");
    started();
    if (start.holdReload === true) {
      await held;
    }
    state.inForce = state.file;
    log.push("reloaded");
    return { loaded: true, sources: [], notes: [] };
  };
  const door = configFileDoor({
    path: "facetdb.config.ts",
    files,
    load: () => {
      log.push("load");
      return Promise.resolve(state.file);
    },
    env: ENV,
    spending: () => state.inForce,
    reload,
  });
  return {
    door,
    state,
    log,
    reloadStarted,
    release: () => {
      release();
    },
  };
}

/** The diff the operator would be shown for `draft`: its plan names the write. */
async function planOf(door: ReturnType<typeof worker>["door"], draft: ConfigDraft) {
  const shown = await door.diff(draft, OPERATOR);
  if (shown.kind !== "planned") {
    throw new Error(`the operator's diff is planned, not ${shown.kind}`);
  }
  return shown.plan;
}

const OPTIONS = { force: false, by: "maya" } as const;

describe("the config file door: a draft that loosens the cap", () => {
  it("1: 2M in force, the file hand-edited to 1M: a reviewer's 1.9M is refused by the file's figure", async () => {
    const w = worker({
      inForce: project({ spendingCap: 2_000_000 }),
      file: project({ spendingCap: 1_000_000 }),
    });
    const draft = { project: { spendingCap: 1_900_000 } };
    const refused = {
      kind: "operator_only",
      changes: [{ kind: "raises", from: 1_000_000, to: 1_900_000 }],
    };
    expect(await w.door.diff(draft, REVIEWER)).toEqual(refused);
    const plan = await planOf(w.door, draft);
    expect(await w.door.apply(draft, { ...OPTIONS, plan }, REVIEWER)).toEqual(refused);
    expect(w.state.writes).toEqual([]);
    // Below the operator's 1M stays open; the operator may write 1.9M.
    expect(await w.door.diff({ project: { spendingCap: 900_000 } }, REVIEWER)).toMatchObject({
      kind: "planned",
    });
    expect(await w.door.diff(draft, OPERATOR)).toMatchObject({ kind: "planned" });
  });

  it("2: no cap in force, the file hand-edited to 1M: a reviewer's null is refused", async () => {
    const w = worker({ inForce: project({}), file: project({ spendingCap: 1_000_000 }) });
    const draft = { project: { spendingCap: null } };
    const refused = { kind: "operator_only", changes: [{ kind: "removes", from: 1_000_000 }] };
    expect(await w.door.diff(draft, REVIEWER)).toEqual(refused);
    const plan = await planOf(w.door, draft);
    expect(await w.door.apply(draft, { ...OPTIONS, plan }, REVIEWER)).toEqual(refused);
    expect(w.state.writes).toEqual([]);
  });

  it("3: continue in force, the file hand-edited to pause: a reviewer's continue is refused", async () => {
    const w = worker({
      inForce: project({ spendingCap: 1_000_000, onCapReached: "continue" }),
      file: project({ spendingCap: 1_000_000, onCapReached: "pause" }),
    });
    const draft = { project: { onCapReached: "continue" as const } };
    const refused = { kind: "operator_only", changes: [{ kind: "continues" }] };
    expect(await w.door.diff(draft, REVIEWER)).toEqual(refused);
    const plan = await planOf(w.door, draft);
    expect(await w.door.apply(draft, { ...OPTIONS, plan }, REVIEWER)).toEqual(refused);
    expect(w.state.writes).toEqual([]);
  });

  it("4: a reviewer's write queued behind the operator's Check again is judged after it, and refused", async () => {
    const w = worker({
      inForce: project({ spendingCap: 2_000_000 }),
      file: project({ spendingCap: 1_000_000 }),
      holdReload: true,
    });
    const draft = { project: { spendingCap: 1_900_000 } };
    // The plan names this file and draft: the reload changes neither, so it still matches.
    const plan = await planOf(w.door, draft);
    w.log.length = 0;
    const reload = w.door.reload();
    const write = w.door.apply(draft, { ...OPTIONS, plan }, REVIEWER);
    // The Check again holds the queue: the write behind it has read nothing yet.
    await w.reloadStarted;
    expect(w.log).toEqual(["reload"]);
    w.release();
    await reload;
    expect(await write).toEqual({
      kind: "operator_only",
      changes: [{ kind: "raises", from: 1_000_000, to: 1_900_000 }],
    });
    expect(w.log).toEqual(["reload", "reloaded", "read", "load"]);
    expect(w.state.writes).toEqual([]);
  });

  it("lets a reviewer lower the cap below both, and leaves a file that does not load refused as before", async () => {
    const w = worker({
      inForce: project({ spendingCap: 2_000_000 }),
      file: project({ spendingCap: 1_000_000 }),
    });
    const draft = { project: { spendingCap: 500_000 } };
    const shown = await w.door.diff(draft, REVIEWER);
    if (shown.kind !== "planned") {
      throw new Error("planned");
    }
    const written = await w.door.apply(draft, { ...OPTIONS, plan: shown.plan }, REVIEWER);
    expect(written).toMatchObject({ kind: "applied" });
    expect(w.state.writes).toHaveLength(1);

    const broken = configFileDoor({
      path: "facetdb.config.ts",
      files: {
        read: () => Promise.resolve({ kind: "file", text: "export default nothing;\n" }),
        replace: () => Promise.reject(new Error("nothing is written")),
        gitState: () => Promise.resolve({ kind: "clean" }),
      },
      load: () => Promise.reject(new ConfigError([{ path: "", message: "no default export" }])),
      env: ENV,
      spending: () => project({ spendingCap: 1_000_000 }),
      reload: () => Promise.reject(new Error("nothing is written, so nothing reloads")),
    });
    expect(await broken.diff({ project: { spendingCap: null } }, REVIEWER)).toMatchObject({
      kind: "unreadable",
    });
  });
});
