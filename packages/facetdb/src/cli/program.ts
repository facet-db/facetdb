import type { PGlite } from "@electric-sql/pglite";
import type { BackfillDeps, Clock, ModelProvider } from "@facetdb/core";
import type { SqlConnect, Store } from "@facetdb/postgres";
import type { WebhookFetch } from "@facetdb/server";
import { Command, CommanderError } from "commander";
import type { ProjectConfig, SourceConfig } from "../config/index.ts";
import { VERSION } from "../index.ts";

/**
 * The commander program every `facetdb` command is registered on. `registerCommand` gives each
 * command `--dry-run` and `--json`, turns a thrown `CliError` into plain words with the fix and the
 * page that fixes it, and maps every outcome to one exit code: 0 success, 1 a problem in the user's
 * setup, 2 a bad invocation.
 */

/** Where every error's page lives: the Mintlify docs site, one page per error code. */
export const DOCS_FIX_URL = "https://docs.facetdb.dev/fix/";

export const EXIT_OK = 0;
export const EXIT_SETUP = 1;
export const EXIT_USAGE = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_SETUP | typeof EXIT_USAGE;

/**
 * An error a user can act on: what went wrong, what to do, and the code of the docs page about it.
 * `exit` is 1 for a problem in the setup (the default) and 2 for a bad invocation.
 */
export class CliError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly exit: typeof EXIT_SETUP | typeof EXIT_USAGE;
  /** Plain data a piped command still wants on failure (`doctor --json` lists every check). */
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    fix: string,
    exit: typeof EXIT_SETUP | typeof EXIT_USAGE = EXIT_SETUP,
    details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.fix = fix;
    this.exit = exit;
    this.details = details;
  }
}

export function docsLink(code: string): string {
  return `${DOCS_FIX_URL}${code}`;
}

/** "58%": a probability or a confidence as a whole percent, never a decimal. */
export function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** "58% likely yes": how a probability reads anywhere a user sees one. */
export function likelyYes(probability: number): string {
  return `${percent(probability)} likely yes`;
}

/** The terminal, as the commands see it; the composition root passes the process's, a test its own. */
export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Asks one question on the terminal and returns the answer; `secret` hides what is typed. */
  readonly prompt: (question: string, options?: { readonly secret?: boolean }) => Promise<string>;
};

/**
 * The project directory's files and the machine's tools, as the commands that write or detect see
 * them. Paths are relative to the project directory; the composition root passes the real disk,
 * a test a temporary directory.
 */
export type Workspace = {
  exists(path: string): Promise<boolean>;
  /** Writes a file, creating its directory; replaces one that exists only when `overwrite` is set. */
  write(path: string, text: string, options: { readonly overwrite: boolean }): Promise<void>;
  /** Whether the `claude` command is on the PATH. */
  hasClaudeCommand(): boolean;
};

/** Everything a command may touch, wired once by the composition root (`main.ts`). */
export type CliDeps = {
  readonly io: CliIo;
  readonly workspace: Workspace;
  /** The time, for ages (a heartbeat's); a test passes a fake. */
  readonly clock: Clock;
  /** The directory the command runs in; its name is the project's name for now (see `projectRef`). */
  readonly projectDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Loads and validates the config file at a path relative to the project directory. */
  readonly loadConfig: (path: string) => Promise<ProjectConfig>;
  /** Opens a database connection for a URL: postgres.js in the process, PGlite in a test. */
  readonly connect: SqlConnect;
  /**
   * The FacetDB store, opened on first use from `DATABASE_URL` and `FACETDB_SECRET`; a command that
   * needs no store never opens one (nor needs the secret). The caller closes it.
   */
  readonly store: () => Promise<Store>;
  /** The model provider for a config: `modelUrl`'s server, else TypeSafe with `TYPESAFE_API_KEY`. */
  readonly provider: (config: ProjectConfig) => ModelProvider;
  /**
   * Everything a backfill of one source needs, wired by the composition root: the source's
   * connector, the decision log, the cursor store, the spending gate. The caller closes it. With
   * `dryRun` the setup must not open the FacetDB store nor write anything: it only reads the
   * source, enough for the estimate.
   */
  readonly backfill: (
    config: ProjectConfig,
    source: SourceConfig,
    mode: { readonly dryRun: boolean },
  ) => Promise<BackfillSetup>;
  /** Binds the HTTP surface on a port (`facetdb worker`); the composition root uses `node:http`. */
  readonly serve: (handler: HttpHandler, port: number) => Promise<HttpListener>;
  /** Aborts when the process is asked to stop (SIGINT, SIGTERM); a test aborts its own. */
  readonly stopSignal: () => AbortSignal;
  /** Sends a webhook from the outbox: `fetch` in the process, a recording fake in a test. */
  readonly webhookFetch: WebhookFetch;
  /** A number in [0, 1), as `Math.random`, for the model backoff's jitter. */
  readonly random: () => number;
  /** The embedded Postgres of `facetdb dev`, kept in a directory of the project. */
  readonly embedded: EmbeddedDatabases;
};

/** One request in, one response out: the shape of a Hono app's `fetch`. */
export type HttpHandler = (request: Request) => Response | Promise<Response>;

/** A bound HTTP server: the port it listens on, and how to stop listening. */
export type HttpListener = {
  readonly port: number;
  close(): Promise<void>;
};

/** An embedded database opened on a data directory; closing it flushes the directory. */
export type EmbeddedDatabase = {
  readonly pglite: PGlite;
  close(): Promise<void>;
};

export type EmbeddedDatabases = {
  /** Opens (creating when missing) the database kept in `dir`, an absolute path. */
  open(dir: string): Promise<EmbeddedDatabase>;
  /** Deletes the directory and everything in it; a missing one is fine. */
  wipe(dir: string): Promise<void>;
};

/** What `CliDeps.backfill` hands the command: the engine's dependencies, and how to let go of them. */
export type BackfillSetup = {
  readonly deps: BackfillDeps;
  close(): Promise<void>;
};

/** What a command's `run` receives: its parsed options and the commander arguments. */
export type CommandContext<Options> = {
  readonly options: Options & { readonly dryRun: boolean; readonly json: boolean };
  readonly args: readonly string[];
  readonly deps: CliDeps;
  /**
   * Human output on stdout; on stderr under `--json`, where the command's result is stdout, so what
   * a command shows before doing (its SQL, before a confirmation) is never hidden.
   */
  readonly print: (text: string) => void;
};

export type OptionSpec = {
  /** As commander writes it: `--admin-url <url>`, `--yes`. */
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: string;
};

export type CommandSpec<Options> = {
  readonly description: string;
  /** Positional arguments, as commander writes them: `<plugin>`, `[name]`. */
  readonly arguments?: readonly string[];
  readonly options: readonly OptionSpec[];
  /** Returns what `--json` prints: plain data, never a probability in raw form. */
  readonly run: (context: CommandContext<Options>) => Promise<unknown>;
};

/** A command as the program registers it; `defineCommand` keeps its options typed. */
export type RegisteredCommand = {
  readonly name: string;
  readonly spec: CommandSpec<never>;
};

export function defineCommand<Options>(
  name: string,
  spec: CommandSpec<Options>,
): RegisteredCommand {
  return { name, spec: spec as unknown as CommandSpec<never> };
}

/** The error as a user reads it: what happened, what to do, and the link to the page about it. */
export function formatError(error: CliError): string {
  return `error: ${error.message}\nfix: ${error.fix}\nsee: ${docsLink(error.code)}\n`;
}

function errorJson(error: CliError): string {
  return `${JSON.stringify({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      fix: error.fix,
      docs: docsLink(error.code),
    },
    ...(error.details === undefined ? {} : { details: error.details }),
  })}\n`;
}

/** Anything else that escapes a command is still reported in plain words, with somewhere to go. */
function asCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(
    "unexpected",
    message,
    "run facetdb doctor to check the connection, permissions and model key; if it reports nothing, open an issue with this message",
  );
}

/** Commander's own refusals: help and version are a success, everything else a bad invocation. */
function commanderExit(error: CommanderError): ExitCode {
  return error.code === "commander.helpDisplayed" || error.code === "commander.version"
    ? EXIT_OK
    : EXIT_USAGE;
}

/**
 * Adds one command to the program with `--dry-run` and `--json`. An error is printed once, here,
 * as plain words (or as JSON under `--json`, on stdout, so a pipe still parses it).
 */
export function registerCommand(
  program: Command,
  deps: CliDeps,
  command: RegisteredCommand,
  exit: { code: ExitCode },
): Command {
  const sub = program.command(command.name).description(command.spec.description);
  for (const argument of command.spec.arguments ?? []) {
    sub.argument(argument);
  }
  for (const option of command.spec.options) {
    if (option.defaultValue === undefined) {
      sub.option(option.flags, option.description);
    } else {
      sub.option(option.flags, option.description, option.defaultValue);
    }
  }
  sub.option("--dry-run", "print what would happen and change nothing", false);
  sub.option("--json", "print the result as JSON", false);
  sub.allowUnknownOption(false).allowExcessArguments(false);
  sub.action(async (...received: unknown[]) => {
    const commandArgs = received.slice(0, -2).filter((a): a is string => typeof a === "string");
    const options = sub.opts<{ dryRun: boolean; json: boolean }>();
    // Under --json the human output still shows (the SQL before any confirmation), on stderr.
    const print = (text: string) => {
      (options.json ? deps.io.stderr : deps.io.stdout)(text.endsWith("\n") ? text : `${text}\n`);
    };
    try {
      const result = await command.spec.run({
        options: options as never,
        args: commandArgs,
        deps,
        print,
      });
      if (options.json) {
        deps.io.stdout(`${JSON.stringify(result ?? { ok: true })}\n`);
      }
      exit.code = EXIT_OK;
    } catch (error) {
      const cliError = asCliError(error);
      if (options.json) {
        deps.io.stdout(errorJson(cliError));
      } else {
        deps.io.stderr(formatError(cliError));
      }
      exit.code = cliError.exit;
    }
  });
  return sub;
}

/** The program with every command registered; `main.ts` and the tests run the same one. */
export function createProgram(
  deps: CliDeps,
  commands: readonly RegisteredCommand[],
  exit: { code: ExitCode },
): Command {
  const program = new Command("facetdb")
    .description("AI answers as database columns")
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.io.stdout(text),
      writeErr: (text) => deps.io.stderr(text),
    })
    .allowUnknownOption(false)
    .allowExcessArguments(false);
  for (const command of commands) {
    registerCommand(program, deps, command, exit);
  }
  return program;
}

/** Parses `argv` (the user's words, without `node main.ts`), runs the command and returns its exit code. */
export async function runProgram(
  argv: readonly string[],
  deps: CliDeps,
  commands: readonly RegisteredCommand[],
): Promise<ExitCode> {
  const exit: { code: ExitCode } = { code: EXIT_OK };
  const program = createProgram(deps, commands, exit);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (commanderExit(error) === EXIT_USAGE) {
        deps.io.stderr(`see: ${docsLink("usage")}\n`);
      }
      return commanderExit(error);
    }
    throw error;
  }
  return exit.code;
}

/** What `runInProcess` hands back: the exit code and everything the command printed. */
export type CapturedRun = {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  /** The questions the command asked, in order. */
  readonly prompts: readonly string[];
};

/** What a test may leave out: each one fails the run, in words, if a command reaches for it. */
type OptionalInTests =
  | "store"
  | "provider"
  | "workspace"
  | "clock"
  | "backfill"
  | "serve"
  | "stopSignal"
  | "webhookFetch"
  | "random"
  | "embedded";

/**
 * The test helper: runs the program in this process with the given dependencies and captures the
 * output. `answers` are what a user types at each prompt, in order; a prompt with none left fails
 * the run, so a test notices a question it did not expect.
 */
export async function runInProcess(
  argv: readonly string[],
  deps: Omit<CliDeps, "io" | OptionalInTests> &
    Partial<Pick<CliDeps, OptionalInTests>> & {
      readonly answers?: readonly string[];
    },
  commands: readonly RegisteredCommand[],
): Promise<CapturedRun> {
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const answers = [...(deps.answers ?? [])];
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: (question) => {
      prompts.push(question);
      const answer = answers.shift();
      return answer === undefined
        ? Promise.reject(new Error(`unexpected prompt: ${question}`))
        : Promise.resolve(answer);
    },
  };
  const { answers: _answers, ...rest } = deps;
  const code = await runProgram(
    argv,
    {
      store: () => Promise.reject(new Error("this test gave the command no store")),
      provider: () => {
        throw new Error("this test gave the command no model provider");
      },
      backfill: () => Promise.reject(new Error("this test gave the command no backfill")),
      workspace: {
        exists: () => Promise.reject(new Error("this test gave the command no workspace")),
        write: () => Promise.reject(new Error("this test gave the command no workspace")),
        hasClaudeCommand: () => {
          throw new Error("this test gave the command no workspace");
        },
      },
      clock: {
        now: () => {
          throw new Error("this test gave the command no clock");
        },
        sleep: () => Promise.reject(new Error("this test gave the command no clock")),
      },
      serve: () => Promise.reject(new Error("this test gave the command no HTTP server")),
      stopSignal: () => {
        throw new Error("this test gave the command no stop signal");
      },
      webhookFetch: () => Promise.reject(new Error("this test gave the command no webhook fetch")),
      random: () => {
        throw new Error("this test gave the command no random numbers");
      },
      embedded: {
        open: () => Promise.reject(new Error("this test gave the command no embedded database")),
        wipe: () => Promise.reject(new Error("this test gave the command no embedded database")),
      },
      ...rest,
      io,
    },
    commands,
  );
  return { code, stdout, stderr, prompts };
}
