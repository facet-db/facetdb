import { describe, expect, it } from "vitest";
import { pgliteClient } from "../sql/index.ts";
import { newDb, newStore, useStoreWorld } from "./store-world.ts";
import {
  checkPassword,
  createUsersStore,
  hashPassword,
  isUserName,
  UsersNotWritableError,
} from "./users.ts";

/**
 * The reviewer accounts store on PGlite: the scrypt hash, the constant-time check, the
 * one-row-per-name rule, and the refusal a select-only login gets. The worker login's real grants
 * are proven by store-migration-6.db.test.ts.
 */

useStoreWorld();

const PASSWORD = "correct horse battery staple";

describe("the password hash", () => {
  it("is scrypt with its cost and a fresh salt, and never holds the password", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(PASSWORD);
    expect(await checkPassword(first, PASSWORD)).toBe("match");
    expect(await checkPassword(second, PASSWORD)).toBe("match");
  });

  it("mismatches a wrong password, a password with one letter changed, and a key of zeros", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await checkPassword(hash, "correct horse battery stapl")).toBe("mismatch");
    expect(await checkPassword(hash, `${PASSWORD}.`)).toBe("mismatch");
    const parts = hash.split("$");
    parts[5] = Buffer.alloc(32).toString("base64url");
    expect(await checkPassword(parts.join("$"), PASSWORD)).toBe("mismatch");
  });

  it("calls a stored hash that is not exactly the form hashPassword makes malformed, never a mismatch", async () => {
    const [, n, r, p, salt, key] = (await hashPassword(PASSWORD)).split("$");
    const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64url");
    const rows: Record<string, string> = {
      "not a hash": "plain-text-password",
      "an empty salt and key": `scrypt$${n}$${r}$${p}$$`,
      "an empty key": `scrypt$${n}$${r}$${p}$${salt}$`,
      "an empty salt": `scrypt$${n}$${r}$${p}$$${key}`,
      "a key of zero bytes": `scrypt$${n}$${r}$${p}$${salt}$${Buffer.alloc(0).toString("base64url")}`,
      "a salt one byte short": `scrypt$${n}$${r}$${p}$${b64(15)}$${key}`,
      "a key one byte long": `scrypt$${n}$${r}$${p}$${salt}$${b64(33)}`,
      "a key that is not base64url": `scrypt$${n}$${r}$${p}$${salt}$${"*".repeat(43)}`,
      "an N of zero": `scrypt$0$${r}$${p}$${salt}$${key}`,
      "an N that is not a power of two": `scrypt$20000$${r}$${p}$${salt}$${key}`,
      "an N below 2^14": `scrypt$${2 ** 13}$${r}$${p}$${salt}$${key}`,
      "an N above 2^20": `scrypt$${2 ** 21}$${r}$${p}$${salt}$${key}`,
      "an N of 2^30": `scrypt$${2 ** 30}$${r}$${p}$${salt}$${key}`,
      "an N written in hex": `scrypt$0x8000$${r}$${p}$${salt}$${key}`,
      "an r of zero": `scrypt$${n}$0$${p}$${salt}$${key}`,
      "a p of zero": `scrypt$${n}$${r}$0$${salt}$${key}`,
      "a memory of 2 GiB (N 2^20, r 8, p 2)": `scrypt$${2 ** 20}$8$2$${salt}$${key}`,
      "a memory just over 1 GiB (N 2^15, r 8, p 33)": `scrypt$${n}$8$33$${salt}$${key}`,
      "an r of a billion": `scrypt$${n}$1000000000$${p}$${salt}$${key}`,
      "a p of a million": `scrypt$${n}$${r}$1000000$${salt}$${key}`,
      "another algorithm": `argon2$${n}$${r}$${p}$${salt}$${key}`,
      "a seventh field": `scrypt$${n}$${r}$${p}$${salt}$${key}$x`,
    };
    for (const [what, stored] of Object.entries(rows)) {
      expect(await checkPassword(stored, PASSWORD), what).toBe("malformed");
    }
  });

  it("accepts the bounds of the cost it allows", async () => {
    const [, , , , salt, key] = (await hashPassword(PASSWORD)).split("$");
    // Valid in form, so a wrong key is a mismatch; the lowest cost is cheap to derive.
    expect(await checkPassword(`scrypt$16384$1$1$${salt}$${key}`, PASSWORD)).toBe("mismatch");
    // r and p are bounded by their product with N (here 64 MiB), not each on its own.
    expect(await checkPassword(`scrypt$16384$16$2$${salt}$${key}`, PASSWORD)).toBe("mismatch");
  });
});

describe("a reviewer's name", () => {
  it("is a lower-case letter, then 1 to 39 letters, digits, underscores or hyphens", () => {
    for (const name of ["ab", "maya", "m4ya_k-2", "a".repeat(40)]) {
      expect(isUserName(name), name).toBe(true);
    }
    for (const name of [
      "",
      "a",
      "a".repeat(41),
      "Maya",
      "1maya",
      "-maya",
      "ma ya",
      "maya!",
      "maya\n",
    ]) {
      expect(isUserName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("the users store", () => {
  it("keeps the hash and nothing else of the password, and refuses a name that is taken", async () => {
    const { store, db } = await newStore();
    const hash = await hashPassword(PASSWORD);
    expect(await store.users.add("maya", hash)).toBe(true);
    // The second add changes nothing, whatever its hash.
    expect(await store.users.add("maya", await hashPassword("another password"))).toBe(false);

    const { rows } = await db.query<Record<string, unknown>>("select * from facetdb.users");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["name"]).toBe("maya");
    expect(rows[0]?.["password_hash"]).toBe(hash);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(await store.users.verify("maya", PASSWORD)).toBe(true);
  });

  it("verifies a name with its password, and nothing else", async () => {
    const { store } = await newStore();
    await store.users.add("maya", await hashPassword(PASSWORD));
    await store.users.add("omar", await hashPassword("omar's own password"));
    expect(await store.users.verify("maya", PASSWORD)).toBe(true);
    expect(await store.users.verify("maya", "omar's own password")).toBe(false);
    expect(await store.users.verify("omar", PASSWORD)).toBe(false);
    expect(await store.users.verify("nobody", PASSWORD)).toBe(false);
    expect(await store.users.verify("Maya", PASSWORD)).toBe(false);
  });

  it("verifies an account with an unreadable stored hash as false and says so once, without the hash", async () => {
    const { db } = await newStore();
    const heard: string[] = [];
    const users = createUsersStore(pgliteClient(db), (message) => heard.push(message));
    const bad = "scrypt$32768$8$1$$";
    await db.query("insert into facetdb.users (name, password_hash) values ('maya', $1)", [bad]);
    expect(await users.verify("maya", PASSWORD)).toBe(false);
    expect(await users.verify("maya", PASSWORD)).toBe(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('"maya"');
    expect(heard[0]).toContain("facetdb users remove maya");
    expect(heard[0]).not.toContain(bad);
    // A good account is still checked, and a wrong password on it is not reported as a bad row.
    await users.add("omar", await hashPassword(PASSWORD));
    expect(await users.verify("omar", "another password")).toBe(false);
    expect(await users.verify("omar", PASSWORD)).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it("lists the accounts oldest first, with no hash", async () => {
    const { store, db } = await newStore();
    expect(await store.users.list()).toEqual([]);
    await store.users.add("omar", await hashPassword(PASSWORD));
    await db.query("update facetdb.users set created_at = created_at - interval '1 day'");
    await store.users.add("maya", await hashPassword(PASSWORD));
    const accounts = await store.users.list();
    expect(accounts.map((account) => account.name)).toEqual(["omar", "maya"]);
    expect(accounts[0]?.createdAt.getTime()).toBeLessThan(accounts[1]?.createdAt.getTime() ?? 0);
    expect(Object.keys(accounts[0] ?? {}).sort()).toEqual(["createdAt", "name"]);
  });

  it("removes an account once, and it can no longer sign in", async () => {
    const { store } = await newStore();
    await store.users.add("maya", await hashPassword(PASSWORD));
    expect(await store.users.remove("maya")).toBe(true);
    expect(await store.users.remove("maya")).toBe(false);
    expect(await store.users.list()).toEqual([]);
    expect(await store.users.verify("maya", PASSWORD)).toBe(false);
  });

  it("lets a login that may only select read the accounts and refuses it a write in words", async () => {
    const { store, db } = await newStore();
    await store.users.add("maya", await hashPassword(PASSWORD));
    await db.exec(`
      create role reader_only;
      grant usage on schema facetdb to reader_only;
      grant select on facetdb.users to reader_only;
      set role reader_only;
    `);
    try {
      const asReader = createUsersStore(pgliteClient(await newDb()));
      expect((await asReader.list()).map((account) => account.name)).toEqual(["maya"]);
      expect(await asReader.verify("maya", PASSWORD)).toBe(true);
      await expect(asReader.add("omar", "scrypt$1$1$1$c2FsdA$a2V5")).rejects.toBeInstanceOf(
        UsersNotWritableError,
      );
      await expect(asReader.remove("maya")).rejects.toBeInstanceOf(UsersNotWritableError);
    } finally {
      // A failed assertion must not leave every later test running as the read-only role.
      await db.exec("reset role");
    }
    expect((await store.users.list()).map((account) => account.name)).toEqual(["maya"]);
  });
});
