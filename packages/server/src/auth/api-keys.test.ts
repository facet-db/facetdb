import { createHash } from "node:crypto";
import type { ApiKeyStore } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApiKeys } from "./api-keys.ts";

/** Holds only the SHA-256 of each key, as the store does, so a test can see what was kept. */
function hashedStore(): ApiKeyStore & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  const revoked = new Set<string>();
  const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
  return {
    kept,
    create(projectId, _name) {
      const id = `key-${kept.size + 1}`;
      const secret = `fdb_made_${kept.size + 1}`;
      kept.set(hash(secret), `${id}:${projectId}`);
      return Promise.resolve({ id, secret });
    },
    verify(secret) {
      const owner = kept.get(hash(secret));
      const [id = "", projectId = ""] = owner?.split(":") ?? [];
      return Promise.resolve(
        owner === undefined || revoked.has(id) ? undefined : { id, projectId },
      );
    },
    revoke(id) {
      const live = [...kept.values()].some((owner) => owner.startsWith(`${id}:`));
      const first = live && !revoked.has(id);
      revoked.add(id);
      return Promise.resolve(first);
    },
  };
}

describe("project API keys", () => {
  it("shows the plaintext once, keeps only its hash, and finds the owner from a Bearer header", async () => {
    const store = hashedStore();
    const keys = createApiKeys(store);
    const { id, secret } = await keys.create("p1", "ci");

    expect([...store.kept.keys()]).not.toContain(secret);
    expect(await keys.verify(`Bearer ${secret}`)).toEqual({ id, projectId: "p1" });
    expect(await keys.verify(`bearer ${secret}`)).toEqual({ id, projectId: "p1" });
  });

  it("refuses a missing, malformed or unknown header", async () => {
    const keys = createApiKeys(hashedStore());
    const { secret } = await keys.create("p1", "ci");
    for (const header of [undefined, "", secret, `Token ${secret}`, "Bearer", "Bearer nope"]) {
      expect(await keys.verify(header)).toBeUndefined();
    }
  });

  it("stops accepting a key once it is revoked, and says so only the first time", async () => {
    const keys = createApiKeys(hashedStore());
    const { id, secret } = await keys.create("p1", "ci");
    expect(await keys.revoke(id)).toBe(true);
    expect(await keys.verify(`Bearer ${secret}`)).toBeUndefined();
    expect(await keys.revoke(id)).toBe(false);
  });
});
