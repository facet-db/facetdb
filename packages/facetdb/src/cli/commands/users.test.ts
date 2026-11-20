import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CliDeps, type CliIo, runInProcess, runProgram } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb users add|list|remove` through the in-process runner on PGlite: an account is made with
 * its password asked twice (or one line of standard input), listed with `--json`, and removed after
 * its name is typed back; the password and its hash appear in no output and in no row but the hash
 * column; the last account's removal says the studio falls back to loopback only; a login that may
 * only read the table is told which login to use.
 */

const PASSWORD = "a long enough password";
const ENV = { DATABASE_URL: "postgres://localhost:5432/app" };

let world: PgliteWorld;
let store: Store;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(argv: readonly string[], answers: readonly string[] = [], interactive = true) {
  return runInProcess(
    argv,
    {
      projectDir: "/work/app",
      env: ENV,
      loadConfig: () => Promise.reject(new Error("users reads no config")),
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      answers,
      interactive,
    },
    COMMANDS,
  );
}

/** Everything a run printed, for the checks that a secret appears nowhere. */
function everything(result: {
  stdout: string;
  stderr: string;
  prompts: readonly string[];
}): string {
  return `${result.stdout}\n${result.stderr}\n${result.prompts.join("\n")}`;
}

async function storedHash(name: string): Promise<string> {
  const { rows } = await world.db.query<{ password_hash: string }>(
    "select password_hash from facetdb.users where name = $1",
    [name],
  );
  return rows[0]?.password_hash ?? "";
}

describe("facetdb users add", () => {
  it("asks the password twice, stores only its scrypt hash and prints neither", async () => {
    const result = await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Added the reviewer account "maya"');
    expect(result.prompts).toEqual(["Password for maya: ", "Type it again: "]);
    const hash = await storedHash("maya");
    expect(hash).toMatch(/^scrypt\$/);
    expect(everything(result)).not.toContain(PASSWORD);
    expect(everything(result)).not.toContain(hash);
    expect(await store.users.verify("maya", PASSWORD)).toBe(true);
  });

  it("reads the password as one line of standard input with --password-stdin", async () => {
    const result = await run(["users", "add", "omar", "--password-stdin"], [PASSWORD], false);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Password: "]);
    expect(await store.users.verify("omar", PASSWORD)).toBe(true);
    expect(everything(result)).not.toContain(PASSWORD);
  });

  it("asks for every password with the echo off", async () => {
    const asked: { question: string; secret: boolean | undefined }[] = [];
    const answers = [PASSWORD, PASSWORD];
    const io: CliIo = {
      stdout: () => undefined,
      stderr: () => undefined,
      prompt: (question, options) => {
        asked.push({ question, secret: options?.secret });
        return Promise.resolve(answers.shift() ?? "");
      },
      answerable: () => Promise.resolve(true),
    };
    const unused = () => {
      throw new Error("users reaches for nothing but the store");
    };
    const deps: CliDeps = {
      io,
      workspace: {
        exists: unused,
        write: unused,
        writeParts: unused,
        peek: unused,
        hasClaudeCommand: unused,
      },
      clock: new FakeClock(0),
      projectDir: "/work/app",
      env: ENV,
      loadConfig: unused,
      engines: [],
      connect: world.connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: unused,
      backfill: unused,
      serve: unused,
      osUser: () => "tester",
      stopSignal: unused,
      webhookFetch: unused,
      abortAfter: unused,
      random: unused,
      embedded: { open: unused, wipe: unused },
      examples: { read: unused },
    };
    expect(await runProgram(["users", "add", "maya"], deps, COMMANDS)).toBe(0);
    expect(asked).toEqual([
      { question: "Password for maya: ", secret: true },
      { question: "Type it again: ", secret: true },
    ]);
  });

  it("refuses an existing name with the fix, before asking for a password", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    const before = await storedHash("maya");
    const result = await run(["users", "add", "maya"]);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain('a reviewer account named "maya" already exists');
    expect(result.stderr).toContain("fix: ");
    expect(result.stderr).toContain("facetdb users remove maya");
    expect(await storedHash("maya")).toBe(before);
  });

  it("refuses passwords that differ, and passwords that are too short, changing nothing", async () => {
    const differ = await run(["users", "add", "maya"], [PASSWORD, `${PASSWORD}!`]);
    expect(differ.code).toBe(1);
    expect(differ.stderr).toContain("the two passwords are not the same");
    expect(everything(differ)).not.toContain(PASSWORD);

    const short = await run(["users", "add", "maya"], ["short", "short"]);
    expect(short.code).toBe(1);
    expect(short.stderr).toContain("shorter than 8 characters");
    expect(await store.users.list()).toEqual([]);
  });

  it("refuses a name that is not allowed, and a missing name, as a bad invocation", async () => {
    const bad = await run(["users", "add", "Maya!"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not a name an account can have");
    const none = await run(["users", "add"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("needs the account's name");
    const action = await run(["users", "rename", "maya"]);
    expect(action.code).toBe(2);
    expect(action.stderr).toContain('no action "rename"');
    expect(await store.users.list()).toEqual([]);
  });

  it("says to use --password-stdin when there is no terminal and no line to read", async () => {
    const result = await run(["users", "add", "maya"], [], false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--password-stdin");
    expect(await store.users.list()).toEqual([]);
  });

  it("does not ask or open the store under --dry-run", async () => {
    const result = await run(["users", "add", "maya", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run");
    expect(result.prompts).toEqual([]);
    expect(await store.users.list()).toEqual([]);
  });

  it("tells a login that may only read the accounts which login to use", async () => {
    await world.db.exec(`
      create role accounts_reader;
      grant usage on schema facetdb to accounts_reader;
      grant select on facetdb.users to accounts_reader;
      set role accounts_reader;
    `);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    } finally {
      // A failure while the command runs must not leave every later test as the read-only role.
      await world.db.exec("reset role");
    }
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("may read the reviewer accounts but not change them");
    expect(result.stderr).toContain("the store's owner login");
    expect(everything(result)).not.toContain(PASSWORD);
    expect(await store.users.list()).toEqual([]);
  });
});

describe("facetdb users list", () => {
  it("says there is no account, and what the studio does without one", async () => {
    const result = await run(["users", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No reviewer accounts yet");
    expect(result.stdout).toContain("loopback");
  });

  it("lists the names and dates, and --json carries them with no password and no hash", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    await run(["users", "add", "omar"], [PASSWORD, PASSWORD]);
    const plain = await run(["users", "list"]);
    expect(plain.stdout).toMatch(/^maya {2}added \d{4}-\d{2}-\d{2}$/m);
    expect(plain.stdout).toMatch(/^omar {2}added /m);

    const json = await run(["users", "list", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      ok: boolean;
      users: { name: string; createdAt: string }[];
    };
    expect(parsed.users.map((user) => user.name).sort()).toEqual(["maya", "omar"]);
    expect(Object.keys(parsed.users[0] ?? {}).sort()).toEqual(["createdAt", "name"]);
    expect(json.stdout).not.toContain(PASSWORD);
    expect(json.stdout).not.toContain("scrypt");
  });

  it("takes no name", async () => {
    const result = await run(["users", "list", "maya"]);
    expect(result.code).toBe(2);
  });
});

describe("facetdb users remove", () => {
  it("asks for the name back, removes the account and keeps the others", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    await run(["users", "add", "omar"], [PASSWORD, PASSWORD]);
    const result = await run(["users", "remove", "maya"], ["maya"]);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Type the account name (maya) to remove it: "]);
    expect(result.stdout).toContain('Removed the reviewer account "maya"');
    expect(result.stdout).not.toContain("last account");
    expect((await store.users.list()).map((account) => account.name)).toEqual(["omar"]);
  });

  it("changes nothing when the name typed back is wrong", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    const result = await run(["users", "remove", "maya"], ["omar"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing was changed");
    expect((await store.users.list()).map((account) => account.name)).toEqual(["maya"]);
  });

  it("says the studio falls back to loopback only when the last account goes", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    const result = await run(["users", "remove", "maya", "--json"], ["maya"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("That was the last account");
    expect(result.stderr).toContain("only on this machine's loopback address");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      name: "maya",
      removed: true,
      lastAccount: true,
    });
    expect(await store.users.list()).toEqual([]);
  });

  it("names an account that does not exist, before asking for anything", async () => {
    const result = await run(["users", "remove", "maya"]);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain('no reviewer account named "maya"');
    expect(result.stderr).toContain("facetdb users list");
  });

  it("asks nothing and removes nothing under --dry-run", async () => {
    await run(["users", "add", "maya"], [PASSWORD, PASSWORD]);
    const result = await run(["users", "remove", "maya", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect((await store.users.list()).map((account) => account.name)).toEqual(["maya"]);
  });
});
