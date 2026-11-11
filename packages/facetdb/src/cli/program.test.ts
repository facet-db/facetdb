import type { SqlConnect } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../config/index.ts";
import { COMMANDS } from "./commands/index.ts";
import {
  CliError,
  createProgram,
  DOCS_FIX_URL,
  defineCommand,
  type ExitCode,
  likelyYes,
  type RegisteredCommand,
  runInProcess,
} from "./program.ts";

/**
 * The program every command is registered on: `--dry-run` and `--json` on each, exit code 2 for a
 * bad invocation and 1 for a problem in the setup, and an error that says what to do and links the
 * page that fixes it.
 */

const ADMIN_URL = "postgres://admin:admin@localhost:5432/app";

/** The commands that run SQL with an admin connection string; init and doctor are tested in their own files. */
const ADMIN_COMMANDS = ["migrate", "uninstall"] as const;

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:worker-password@localhost:5432/app",
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

let world: PgliteWorld;

beforeEach(async () => {
  world = await createPgliteWorld();
  await world.client.query("create table public.listings (id text primary key, title text)");
});

afterEach(async () => {
  await world.close();
});

function run(
  argv: readonly string[],
  commands: readonly RegisteredCommand[] = COMMANDS,
  connect: SqlConnect = world.connect,
) {
  return runInProcess(
    argv,
    { projectDir: "/work/app", env: {}, loadConfig: () => Promise.resolve(config), connect },
    commands,
  );
}

/** A command that fails the way a setup problem does, to see how the program prints it. */
const failing = defineCommand<{ readonly why?: string }>("fail", {
  description: "fails",
  options: [{ flags: "--why <text>", description: "the message" }],
  run: ({ options }) =>
    Promise.reject(
      new CliError(
        "example-problem",
        options.why ?? "something in the setup is wrong",
        "do the one thing that fixes it",
      ),
    ),
});

const crashing = defineCommand<object>("crash", {
  description: "throws a plain error",
  options: [],
  run: () => Promise.reject(new Error("connection refused")),
});

describe("the facetdb program", () => {
  it("registers migrate and uninstall, each with --dry-run and --json", () => {
    const program = createProgram(
      {
        io: { stdout: () => undefined, stderr: () => undefined, prompt: () => Promise.resolve("") },
        projectDir: "/work/app",
        env: {},
        loadConfig: () => Promise.resolve(config),
        connect: world.connect,
        store: () => Promise.reject(new Error("unused")),
        provider: () => {
          throw new Error("unused");
        },
        workspace: {
          exists: () => Promise.resolve(false),
          write: () => Promise.resolve(),
          hasClaudeCommand: () => false,
        },
        clock: { now: () => 0, sleep: () => Promise.resolve() },
        backfill: () => Promise.reject(new Error("unused")),
        serve: () => Promise.reject(new Error("unused")),
        stopSignal: () => {
          throw new Error("unused");
        },
        webhookFetch: () => Promise.reject(new Error("unused")),
        random: () => {
          throw new Error("unused");
        },
        embedded: {
          open: () => Promise.reject(new Error("unused")),
          wipe: () => Promise.reject(new Error("unused")),
        },
      },
      COMMANDS,
      { code: 0 },
    );
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual([
      "init",
      "doctor",
      "migrate",
      "uninstall",
      "preview",
      "backfill",
      "explain",
      "worker",
      "dev",
    ]);
    for (const command of program.commands) {
      const flags = command.options.map((option) => option.long);
      expect(flags, command.name()).toContain("--dry-run");
      expect(flags, command.name()).toContain("--json");
    }
  });

  it.each(ADMIN_COMMANDS)("%s accepts --dry-run", async (name) => {
    const result = await run([name, "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.code, result.stderr).not.toBe(2);
    expect(result.prompts).toEqual([]);
  });

  it("exits 2 on an unknown option, with the usage page", async () => {
    const result = await run(["migrate", "--not-an-option"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--not-an-option");
    expect(result.stderr).toContain(`${DOCS_FIX_URL}usage`);
  });

  it.each([
    [["no-such-command"], 2],
    [[], 2],
    [["migrate", "extra-argument"], 2],
    [["--help"], 0],
    [["--version"], 0],
  ] as const)("exits %j with %i", async (argv, code: ExitCode) => {
    expect((await run(argv)).code).toBe(code);
  });

  it("prints an error in plain words, with the fix and the link, and exits 1", async () => {
    const result = await run(["fail"], [failing]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: something in the setup is wrong\nfix: do the one thing that fixes it\nsee: https://docs.facetdb.dev/fix/example-problem\n",
    );
  });

  it("exits 2 for a bad invocation a command finds itself", async () => {
    const result = await run(["migrate", "--source", "nope", "--admin-url", ADMIN_URL]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('the config has no source named "nope"');
    expect(result.stderr).toContain("fix: pass one of: listings");
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/unknown-source");
  });

  it("still gives a fix and a link for an error nobody planned for", async () => {
    const result = await run(["crash"], [crashing]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: connection refused");
    expect(result.stderr).toContain("fix: run facetdb doctor");
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/unexpected");
  });

  it("prints JSON that parses under --json, for a result and for an error", async () => {
    const ok = await run(["migrate", "--dry-run", "--json", "--admin-url", ADMIN_URL]);
    expect(ok.code).toBe(0);
    const parsed = JSON.parse(ok.stdout) as {
      ok: boolean;
      dryRun: boolean;
      sources: { source: string; sql: string }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.sources[0]?.source).toBe("listings");
    expect(parsed.sources[0]?.sql).toContain("begin;");

    const failed = await run(["fail", "--json"], [failing]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toEqual({
      ok: false,
      error: {
        code: "example-problem",
        message: "something in the setup is wrong",
        fix: "do the one thing that fixes it",
        docs: "https://docs.facetdb.dev/fix/example-problem",
      },
    });
  });

  it("speaks of probabilities in plain words", async () => {
    expect(likelyYes(0.58)).toBe("58% likely yes");
    expect(likelyYes(0.995)).toBe("100% likely yes");
    for (const name of ADMIN_COMMANDS) {
      const result = await run([name, "--dry-run", "--admin-url", ADMIN_URL]);
      expect(`${result.stdout}${result.stderr}`).not.toContain("noul=");
    }
  });
});
