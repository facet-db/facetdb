import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgliteClient } from "../polling/index.ts";
import type { SqlClient, SqlConnect } from "../sql/index.ts";

/**
 * Fast PGlite instances for tests. A plain `new PGlite()` spends about 1.3 s in `initdb`, the
 * cluster initialisation; compiling the WebAssembly is 20 ms and loading a dumped data directory
 * 250 ms (measured 2026-11-01). So one empty cluster is initialised per machine and PGlite version,
 * its data directory dumped to a cache file, and every instance boots from that dump: five times
 * faster, and the 50-test store suite drops from 67 s to a fraction. The dump holds nothing but an
 * empty cluster, so every test still starts from scratch.
 */

const require = createRequire(import.meta.url);

/** The cache file: keyed by the installed PGlite's path, which carries its version. */
function templatePath(): string {
  const installed = dirname(require.resolve("@electric-sql/pglite"));
  const key = createHash("sha1").update(installed).digest("hex").slice(0, 12);
  return join(tmpdir(), "facetdb-pglite", `template-${key}.tar`);
}

let template: Promise<Blob> | undefined;

async function templateDataDir(): Promise<Blob> {
  template ??= (async () => {
    const path = templatePath();
    try {
      return new Blob([await readFile(path)]);
    } catch {
      // No cache yet (or unreadable): initialise one cluster, dump it, publish the file atomically
      // so two workers racing here never read a half-written tarball.
      const db = new PGlite();
      await db.waitReady;
      const dump = await db.dumpDataDir("none");
      await db.close();
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.${process.pid}.part`;
      await writeFile(partial, Buffer.from(await dump.arrayBuffer()));
      await rename(partial, path);
      return dump;
    }
  })();
  return template;
}

/**
 * Builds the template once, before the test workers start (vitest `globalSetup`): otherwise every
 * file's first test builds it, all at once on a cold checkout, and the slowest of them passes the
 * 5-second default timeout (seen on 2026-11-01).
 */
export async function warmPgliteTemplate(): Promise<void> {
  await templateDataDir();
}

/** A fresh, empty PGlite, booted from the cached template. The caller closes it. */
export async function freshPglite(): Promise<PGlite> {
  const db = new PGlite({ loadDataDir: await templateDataDir() });
  await db.waitReady;
  return db;
}

/**
 * One in-process PGlite for a unit test: the database, a `SqlClient` over it, and a `connect` that
 * hands the same client to any code written against `SqlConnect` (migrate, the connectors), so the
 * production code runs its own SQL on a real Postgres engine with nothing installed. PGlite is one
 * connection and one superuser: it proves SQL shape, triggers and NOTIFY, not roles or two workers
 * (those are `*.db.test.ts`, see `postgres.ts`).
 */
export type PgliteWorld = {
  readonly db: PGlite;
  readonly client: SqlClient;
  readonly connect: SqlConnect;
  close(): Promise<void>;
};

export async function createPgliteWorld(): Promise<PgliteWorld> {
  const db = await freshPglite();
  const client = pgliteClient(db);
  return {
    db,
    client,
    connect: () => client,
    close: () => db.close(),
  };
}
