import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgliteClient, unlistenAll } from "../polling/index.ts";
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
 * Drops what a test left in the cluster: every schema but the system ones (`public` with them,
 * then recreated as initdb leaves it), and every role a test or an install created.
 */
const EMPTY_CLUSTER = `
do $$
declare
  schemas text;
  roles text;
begin
  select string_agg(format('%I', nspname), ', ') into schemas
    from pg_namespace
    where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and nspname not like 'pg\\_temp\\_%' and nspname not like 'pg\\_toast\\_temp\\_%';
  if schemas is not null then
    execute 'drop schema ' || schemas || ' cascade';
  end if;
  -- initdb's roles (the bootstrap superuser and the pg_* roles) all sit below FirstNormalObjectId.
  select string_agg(format('%I', rolname), ', ') into roles from pg_roles where oid >= 16384;
  if roles is not null then
    execute 'drop owned by ' || roles || ' cascade';
    execute 'drop role ' || roles;
  end if;
end
$$;
create schema public authorization pg_database_owner;
grant usage on schema public to public;
comment on schema public is 'standard public schema';
`;

/**
 * Returns an engine to the empty cluster it booted as, without a reboot (a boot is 440 ms, this
 * 3 ms empty and about 20 after an install). It ends a transaction a failed test left open
 * (first: an unlisten inside an aborted transaction throws), lets go of every listener the
 * `pgliteClient`s over it registered, discards the session (role, settings, prepared statements,
 * temporary tables, `LISTEN`s), then drops every user schema and role; sequences go with their
 * schemas, so a new `serial` starts at 1 again. A file boots one engine in `beforeAll` and resets
 * it `afterEach`.
 *
 * Known limits (no FacetDB SQL meets them; a test that does cleans up after itself):
 * - default privileges shared between two roles (`alter default privileges for role a … to b`)
 *   make `drop owned by … cascade` fail with "could not find tuple for default ACL" and wedge the
 *   file's engine: a test that needs them revokes them itself;
 * - a custom `facetdb.*` setting a test set reads '' after the reset, where a fresh engine raises
 *   "unrecognized configuration parameter" (Postgres keeps the placeholder);
 * - database-level settings, grants and the database's comment survive the reset;
 * - only listeners registered through `pgliteClient` are released: a test calling `db.listen`
 *   directly unlistens itself.
 */
export async function resetPglite(db: PGlite): Promise<void> {
  await db.exec("rollback");
  await unlistenAll(db);
  await db.exec("discard all");
  await db.exec(EMPTY_CLUSTER);
}

/** `resetPglite` for a world: its client and `connect` keep working over the emptied engine. */
export async function resetPgliteWorld(world: PgliteWorld): Promise<void> {
  await resetPglite(world.db);
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
