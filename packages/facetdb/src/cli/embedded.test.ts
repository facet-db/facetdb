import type { PGlite } from "@electric-sql/pglite";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { facetdb, noul } from "../config/index.ts";
import { engineTarget, projectRef } from "./commands/database.ts";
import { embeddedParts } from "./embedded.ts";
import { freshPglite, TEST_SECRET } from "./testing.ts";

/**
 * The engine `facetdb dev` runs on: no network reaches the embedded database and its client ignores
 * every address, so no connection string is judged for TLS, whatever the caller knows of it (the
 * studio's doors judge an admin string as remote until told otherwise).
 */

const REMOTE = "postgres://admin:secret@db.example.com:5432/app";

const config = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: REMOTE,
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

let pglite: PGlite;

beforeAll(async () => {
  pglite = await freshPglite();
});

afterAll(async () => {
  await pglite.close();
});

describe("the embedded engine", () => {
  it("judges no address for TLS: a remote-looking string without it is not refused", async () => {
    const { store, engine } = await embeddedParts(
      { pglite, close: () => Promise.resolve() },
      { secret: TEST_SECRET, clock: new FakeClock(0) },
    );
    try {
      const [source] = config.sources;
      if (source === undefined) {
        throw new Error("the config has a source");
      }
      const target = engineTarget(
        config,
        { source, schema: "public", table: "listings" },
        projectRef("/work/listings-app"),
      );
      expect(engine.checkUrl(target, REMOTE, { allowInsecure: false })).toBeUndefined();
      await expect(engine.inspect?.(REMOTE, { allowInsecure: false })).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        engine.planInstall(target, REMOTE, {
          clock: new FakeClock(0),
          allowInsecure: false,
          storeShared: true,
          workerPassword: "dev-password",
        }),
      ).resolves.toMatchObject({ ok: false, refusal: { code: "migrate-refused" } });
    } finally {
      await store.close();
    }
  });
});
