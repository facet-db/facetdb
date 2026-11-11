import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { FakeClock } from "@facetdb/core/testing";
import { pgliteClient } from "@facetdb/postgres";
import { freshPglite } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { diskEmbedded } from "../embedded.ts";
import type { EmbeddedDatabases } from "../program.ts";
import { runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb dev` through the in-process runner: with no `TYPESAFE_API_KEY` and no `--model-url` it
 * opens the embedded database under `.facetdb/dev/`, installs the config's table there and answers
 * what is queued with the fake provider; the database outlives the run, and `--reset` wipes it
 * first. The embedded databases are a PGlite kept across opens (what a data directory does), passed
 * through `CliDeps.embedded`; the last test runs the real one on disk.
 */

const PROJECT_DIR = "/work/listings-app";
const DEV_DIR = join(PROJECT_DIR, ".facetdb", "dev");

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      // An unset DATABASE_URL: dev never connects to it.
      database: "",
      table: "listings",
      read: ["id", "title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

/** One PGlite per directory, kept open across the command's opens and closes, as a disk would. */
class KeptDatabases implements EmbeddedDatabases {
  readonly databases = new Map<string, PGlite>();
  readonly calls: string[] = [];

  async open(dir: string) {
    this.calls.push(`open ${dir}`);
    let pglite = this.databases.get(dir);
    if (pglite === undefined) {
      pglite = await freshPglite();
      this.databases.set(dir, pglite);
    }
    return { pglite, close: () => Promise.resolve() };
  }

  async wipe(dir: string) {
    this.calls.push(`wipe ${dir}`);
    await this.databases.get(dir)?.close();
    this.databases.delete(dir);
  }

  /** The test's own door into a directory's database, as `psql` would be. */
  async query(dir: string, sql: string) {
    const { pglite } = await this.open(dir);
    this.calls.pop();
    return pgliteClient(pglite).query(sql);
  }

  async closeAll() {
    for (const pglite of this.databases.values()) {
      await pglite.close();
    }
  }
}

let embedded: KeptDatabases;

beforeEach(() => {
  embedded = new KeptDatabases();
});

afterEach(async () => {
  await embedded.closeAll();
});

function run(argv: readonly string[], deps: { readonly embedded?: EmbeddedDatabases } = {}) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      // No TYPESAFE_API_KEY, no DATABASE_URL, no FACETDB_SECRET: dev needs none of them.
      env: {},
      loadConfig: () => Promise.resolve(config),
      connect: () => {
        throw new Error("dev connected to a database outside the embedded one");
      },
      provider: () => {
        throw new Error("dev built the real model provider without --model-url");
      },
      clock: new FakeClock(1_700_000_000_000),
      embedded: deps.embedded ?? embedded,
    },
    COMMANDS,
  );
}

async function listing(id: string) {
  const rows = await embedded.query(
    DEV_DIR,
    `select is_scam, facetdb_status from public.listings where id = '${id}'`,
  );
  return rows[0];
}

describe("facetdb dev", () => {
  it("answers offline with the fake provider: no key, no network, the database under .facetdb/dev/", async () => {
    await embedded.query(DEV_DIR, "create table public.listings (id text primary key, title text)");

    const first = await run(["dev", "--once", "--no-http"]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(embedded.calls).toEqual([`open ${DEV_DIR}`]);
    expect(first.stdout).toContain("answers come from the scripted fake provider");
    expect(first.stdout).toContain("Installed listings on public.listings in .facetdb/dev");

    // The install outlived the run: a new row is queued by its trigger and answered by the next.
    await embedded.query(DEV_DIR, "insert into public.listings (id, title) values ('r1', 'A car')");
    const second = await run(["dev", "--once", "--no-http"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("listings: answered r1");
    expect(await listing("r1")).toMatchObject({ facetdb_status: "done" });
    expect((await listing("r1"))?.["is_scam"]).not.toBeNull();
  });

  it("skips a table that is not in the dev database yet, and says how to add it", async () => {
    const result = await run(["dev", "--once", "--no-http"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipped listings");
    expect(result.stdout).toContain("Create public.listings in the dev database");
  });

  it("--reset wipes .facetdb/dev/ before opening it", async () => {
    await embedded.query(DEV_DIR, "create table public.listings (id text primary key, title text)");

    const result = await run(["dev", "--reset", "--once", "--no-http"]);

    expect(result.code).toBe(0);
    expect(embedded.calls).toEqual([`wipe ${DEV_DIR}`, `open ${DEV_DIR}`]);
    expect(result.stdout).toContain("Deleted .facetdb/dev/");
    // The table went with the directory.
    expect(result.stdout).toContain("skipped listings");
  });

  it("--dry-run opens nothing", async () => {
    const result = await run(["dev", "--dry-run", "--reset"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run: nothing was started.");
    expect(embedded.calls).toEqual([]);
  });

  it("creates .facetdb/dev/ on disk and keeps what was written there", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "facetdb-dev-"));
    try {
      const dir = join(projectDir, ".facetdb", "dev");
      const first = await diskEmbedded.open(dir);
      try {
        await pgliteClient(first.pglite).query(
          "create table public.listings (id text primary key, title text)",
        );
      } finally {
        await first.close();
      }
      const result = await runInProcess(
        ["dev", "--once", "--no-http"],
        {
          projectDir,
          env: {},
          loadConfig: () => Promise.resolve(config),
          connect: () => {
            throw new Error("dev connected to a database outside the embedded one");
          },
          clock: new FakeClock(1_700_000_000_000),
          embedded: diskEmbedded,
        },
        COMMANDS,
      );
      expect(result.code).toBe(0);
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect((await readdir(dir)).length).toBeGreaterThan(0);

      expect(result.stdout).toContain("Installed listings on public.listings");

      // The install and the store the run made are still there when the directory is opened again.
      const again = await diskEmbedded.open(dir);
      try {
        const client = pgliteClient(again.pglite);
        const beats = await client.query("select count(*)::int as n from facetdb.heartbeats");
        expect(beats[0]?.["n"]).toBe(1);
        const columns = await client.query(
          "select column_name from information_schema.columns where table_name = 'listings' and column_name = 'facetdb_status'",
        );
        expect(columns).toHaveLength(1);
      } finally {
        await again.close();
      }

      await diskEmbedded.wipe(dir);
      await expect(stat(dir)).rejects.toThrow();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});
