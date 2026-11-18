import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";
import type { SqlClient } from "../sql/index.ts";
import { text, toMs } from "./rows.ts";

/**
 * The open-source studio's reviewer accounts: rows of `facetdb.users`, made by `facetdb users add`.
 * A row holds a scrypt hash and never the password. The worker login holds select on the table and
 * nothing more (store migration 6), so `add` and `remove` need the store's owner or admin login,
 * and `verify` is the only call the studio makes.
 */

/** A name is a letter, then 1 to 39 letters, digits, underscores or hyphens, lower case. */
const USER_NAME = /^[a-z][a-z0-9_-]{1,39}$/;

export const USER_NAME_RULE =
  "a lower-case letter, then 1 to 39 lower-case letters, digits, underscores or hyphens";

export function isUserName(name: string): boolean {
  return USER_NAME.test(name);
}

// scrypt's cost: N = 2^15, r = 8, p = 1 is about 32 MiB and 70 ms, a sound setting for an
// interactive login. The cost is written into every hash, so raising it later leaves older hashes
// checkable under the cost they were made with.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const HASH_PREFIX = "scrypt";

type Cost = { readonly n: number; readonly r: number; readonly p: number };

const HASH_COST: Cost = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

function derive(password: string, salt: Buffer, cost: Cost, bytes: number): Promise<Buffer> {
  // Node refuses a cost over its 32 MiB default memory limit, which N = 2^15 at r = 8 reaches.
  const options: ScryptOptions = {
    N: cost.n,
    r: cost.r,
    p: cost.p,
    maxmem: 256 * cost.n * cost.r * cost.p,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, bytes, options, (error, key) => {
      if (error === null) {
        resolve(key);
      } else {
        reject(error);
      }
    });
  });
}

/**
 * The string stored for a password: `scrypt$N$r$p$salt$key`, the salt random per hash. The
 * password is Unicode-normalized (NFKC) first, so the same letters typed on two keyboards agree.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, HASH_COST, KEY_BYTES);
  return [
    HASH_PREFIX,
    HASH_COST.n,
    HASH_COST.r,
    HASH_COST.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

// The bounds a stored hash's cost must keep to be checked at all: a row is a boundary, and a cost
// read from it sets how much memory and time one login attempt spends. Below N = 2^14 the hash is
// too weak to trust, N = 2^20 is the most FacetDB would ever set, and a cost whose memory,
// 128 * N * r * p bytes, passes 1 GiB could exhaust the studio with one attempt (r and p are
// bounded by that product, not one by one).
const MIN_COST_N = 2 ** 14;
const MAX_COST_N = 2 ** 20;
const MAX_COST_MEMORY_BYTES = 2 ** 30;

type ParsedHash = { readonly cost: Cost; readonly salt: Buffer; readonly key: Buffer };

/** The bytes a base64url field holds, or undefined when it is not canonical base64url or not `length` bytes. */
function fixedBytes(field: string, length: number): Buffer | undefined {
  const bytes = Buffer.from(field, "base64url");
  return bytes.length === length && bytes.toString("base64url") === field ? bytes : undefined;
}

/**
 * A stored hash is a database row, a boundary: exactly `scrypt$N$r$p$salt$key`, with the salt and
 * key the lengths `hashPassword` makes and a cost within the bounds above. Anything else is
 * undefined: a malformed row, never a password check.
 */
function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split("$");
  const [prefix, n, r, p, salt, key] = parts;
  if (
    parts.length !== 6 ||
    prefix !== HASH_PREFIX ||
    n === undefined ||
    r === undefined ||
    p === undefined ||
    salt === undefined ||
    key === undefined ||
    ![n, r, p].every((digits) => /^[1-9]\d{0,9}$/.test(digits))
  ) {
    return undefined;
  }
  const cost = { n: Number(n), r: Number(r), p: Number(p) };
  const saltBytes = fixedBytes(salt, SALT_BYTES);
  const keyBytes = fixedBytes(key, KEY_BYTES);
  if (
    saltBytes === undefined ||
    keyBytes === undefined ||
    cost.n < MIN_COST_N ||
    cost.n > MAX_COST_N ||
    (cost.n & (cost.n - 1)) !== 0 ||
    128 * cost.n * cost.r * cost.p > MAX_COST_MEMORY_BYTES
  ) {
    return undefined;
  }
  return { cost, salt: saltBytes, key: keyBytes };
}

/** What checking a password against a stored hash found. */
export type PasswordCheck = "match" | "mismatch" | "malformed";

/** Whether the password makes the stored hash, compared in constant time; a bad row is "malformed". */
export async function checkPassword(stored: string, password: string): Promise<PasswordCheck> {
  const parsed = parseHash(stored);
  if (parsed === undefined) {
    return "malformed";
  }
  const derived = await derive(password, parsed.salt, parsed.cost, parsed.key.length);
  return timingSafeEqual(derived, parsed.key) ? "match" : "mismatch";
}

/** One reviewer account, as `list` shows it: never the hash. */
export type ReviewerAccount = {
  readonly name: string;
  readonly createdAt: Date;
};

export type UsersStore = {
  /** True when the account was made; false when the name is taken (nothing changes). */
  add(name: string, passwordHash: string): Promise<boolean>;
  /** Whether the name and password belong to an account; an unknown name costs as much as a wrong password. */
  verify(name: string, password: string): Promise<boolean>;
  /** Every account, oldest first. */
  list(): Promise<readonly ReviewerAccount[]>;
  /** True when the account existed and is gone. */
  remove(name: string): Promise<boolean>;
};

/**
 * The login in use may read the accounts and not write them: the worker login, whose grants on
 * `facetdb.users` are select only. The fix is to run the command with the store's owner login.
 */
export class UsersNotWritableError extends Error {
  constructor() {
    super("this login may read the reviewer accounts but not change them");
    this.name = "UsersNotWritableError";
  }
}

const INSUFFICIENT_PRIVILEGE = "42501";

/** The server's error code, read off the driver's error (a boundary). */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function writing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw sqlState(error) === INSUFFICIENT_PRIVILEGE ? new UsersNotWritableError() : error;
  }
}

/**
 * `warn` hears of a stored hash that cannot be parsed, once per account name for the life of the
 * store, in words with the fix and never with the hash. Such an account cannot sign in.
 */
export function createUsersStore(
  client: SqlClient,
  warn: (message: string) => void = () => undefined,
): UsersStore {
  const reported = new Set<string>();
  let deriveFailureHeard = false;
  return {
    async add(name, passwordHash) {
      const rows = await writing(() =>
        client.query(
          "insert into facetdb.users (name, password_hash) values ($1, $2) on conflict (name) do nothing returning name",
          [name, passwordHash],
        ),
      );
      return rows.length > 0;
    },

    async verify(name, password) {
      const rows = await client.query("select password_hash from facetdb.users where name = $1", [
        name,
      ]);
      const row = rows[0];
      const stored = row === undefined ? undefined : text(row, "password_hash");
      let checked: PasswordCheck | "failed";
      try {
        if (stored === undefined) {
          // An unknown name still pays one derive at today's cost, so a miss takes the time of a
          // wrong password; nothing is kept between attempts.
          await derive(password, randomBytes(SALT_BYTES), HASH_COST, KEY_BYTES);
          return false;
        }
        checked = await checkPassword(stored, password);
      } catch (error) {
        checked = "failed";
        if (!deriveFailureHeard) {
          deriveFailureHeard = true;
          warn(
            `FacetDB could not check a reviewer password (${error instanceof Error ? error.message : String(error)}); sign-in is refused until that is fixed`,
          );
        }
      }
      if (checked === "failed") {
        return false;
      }
      if (checked === "malformed") {
        if (!reported.has(name)) {
          reported.add(name);
          warn(
            `the reviewer account "${name}" has a stored password hash FacetDB cannot read, so it cannot sign in; remove it with facetdb users remove ${name} and add it again`,
          );
        }
        return false;
      }
      return checked === "match";
    },

    async list() {
      const rows = await client.query(
        `select name, ${toMs("created_at", "created_ms")} from facetdb.users order by created_at, name`,
      );
      return rows.map((row) => ({
        name: text(row, "name"),
        createdAt: new Date(Number(text(row, "created_ms"))),
      }));
    },

    async remove(name) {
      const rows = await writing(() =>
        client.query("delete from facetdb.users where name = $1 returning name", [name]),
      );
      return rows.length > 0;
    },
  };
}
