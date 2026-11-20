import type { PGlite } from "@electric-sql/pglite";
import type { BackfillDeps, Clock, DatabaseEngine, ModelProvider } from "@facetdb/core";
import type { SqlConnect, Store } from "@facetdb/postgres";
import type { Peer, StudioFiles, WebhookFetch } from "@facetdb/server";
import { Command, CommanderError } from "commander";
import type { ConfigFiles, ProjectConfig, SourceConfig } from "../config/index.ts";
import { VERSION } from "../index.ts";
import { NO_TERMINAL, type ReviewTerminal } from "./terminal.ts";

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

// How a probability reads is core's (the explain history shares it with the HTTP surface).
export { likelyYes, percent } from "@facetdb/core";

/** Where a connection string points, without its user or password: what a confirmation names. */
export function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name === "" ? parsed.host : `${parsed.host}/${name}`;
  } catch {
    return "the database";
  }
}

/** An error's message with every secret it carries blanked out, so nothing printed holds one. */
export function plainMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    message = message.replaceAll(secret, "***");
    try {
      const password = decodeURIComponent(new URL(secret).password);
      if (password !== "") {
        message = message.replaceAll(password, "***");
      }
    } catch {
      // Not a URL: the whole value was already blanked.
    }
  }
  return message;
}

/** The terminal, as the commands see it; the composition root passes the process's, a test its own. */
export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Asks one question on the terminal and returns the answer; `secret` hides what is typed. */
  readonly prompt: (question: string, options?: { readonly secret?: boolean }) => Promise<string>;
  /**
   * Whether a question asked now gets an answer: always at a terminal; on a pipe (a script, CI, a
   * coding agent), while a line is left to read, the answers taken in the order a terminal asks.
   * A question with a safe default takes it, and says so, when none will come.
   */
  readonly answerable: () => Promise<boolean>;
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
  /**
   * Writes a file from parts made one at a time (`export --out`'s pages), creating its directory:
   * the parts go to a temporary file beside it, which takes the file's name only once the last part
   * is written, so a failure while `parts` runs leaves the file as it was and the temporary one
   * gone. Replaces a file that exists only when `overwrite` is set, and says `"exists"` instead,
   * writing nothing, when one exists at that moment (another run's, say).
   */
  writeParts(
    path: string,
    parts: AsyncIterable<string>,
    options: { readonly overwrite: boolean },
  ): Promise<"written" | "exists">;
  /**
   * What is at a path, never through a symbolic link: nothing, a regular file with its first line
   * (from its first 4 KiB), or something else (a link, a directory), which is never read through.
   * `facetdb types` replaces a file only when its first line is the generated header.
   */
  peek(path: string): Promise<PathFound>;
  /**
   * The lines of a file, one at a time as they are asked for, never through a symbolic link
   * (`facetdb review --from`). The caller has `peek`ed the path: a missing file fails here.
   */
  lines(path: string): AsyncIterable<string>;
  /** Whether the `claude` command is on the PATH. */
  hasClaudeCommand(): boolean;
};

/** What `Workspace.peek` finds at a path. */
export type PathFound =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly firstLine: string }
  | { readonly kind: "other" };

/** Everything a command may touch, wired once by the composition root (`main.ts`). */
export type CliDeps = {
  readonly io: CliIo;
  readonly workspace: Workspace;
  /** The time, for ages (a heartbeat's); a test passes a fake. */
  readonly clock: Clock;
  /** The directory the command runs in; its name is the project's name for now (see `projectRef`). */
  readonly projectDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Loads and validates the config file at a path relative to the project directory; `quiet` keeps
   * its wording warnings unprinted (Apply's diff loads the file on every look).
   */
  readonly loadConfig: (
    path: string,
    options?: { readonly quiet?: boolean },
  ) => Promise<ProjectConfig>;
  /**
   * The config file as Apply reads, judges with `git status` and replaces it: the disk and the
   * `git` command in the process, a fake in a test.
   */
  readonly configFiles: ConfigFiles;
  /**
   * The database engines a source's connection string picks from by its scheme (`cli/engines.ts`),
   * each loaded on first use only, so a driver no source needs is never imported: the composition
   * root registers the Postgres engine, other engines append theirs. A command reaches a source's
   * database through its engine and nothing else.
   */
  readonly engines: readonly EngineEntry[];
  /**
   * Opens a connection to the FacetDB store's Postgres (the store door, `cli/store-door.ts`):
   * postgres.js in the process, PGlite in a test. Never a source's database: that is its engine's.
   */
  readonly connect: SqlConnect;
  /**
   * The FacetDB store, opened on first use from `DATABASE_URL` and `FACETDB_SECRET`; a command that
   * needs no store never opens one (nor needs the secret). The caller closes it. A store refuses a
   * plaintext URL to another machine unless `allowInsecure` (`--allow-insecure`) says it is trusted.
   */
  readonly store: (options?: {
    readonly allowInsecure?: boolean;
    /**
     * Opens the store's client: the worker hands in its shared pool, so the store and the table
     * sources on its database use one; one-off commands leave it out and get the driver's own.
     */
    readonly connect?: SqlConnect;
    /** Hears of a stored row the store cannot trust (a reviewer's unreadable hash); never a secret. */
    readonly warn?: (message: string) => void;
  }) => Promise<Store>;
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
    mode: { readonly dryRun: boolean; readonly allowInsecure?: boolean },
  ) => Promise<BackfillSetup>;
  /**
   * Binds the HTTP surface on a host and port (`facetdb worker --host --port`); the composition
   * root uses `node:http`. The handler is told the address of each connection's other end.
   */
  readonly serve: (handler: HttpHandler, port: number, host: string) => Promise<HttpListener>;
  /** The operating system's user name: the reviewer on record on this machine's loopback address. */
  readonly osUser: () => string;
  /** Aborts when the process is asked to stop (SIGINT, SIGTERM); a test aborts its own. */
  readonly stopSignal: () => AbortSignal;
  /** Sends a webhook from the outbox: `fetch` in the process, a recording fake in a test. */
  readonly webhookFetch: WebhookFetch;
  /**
   * A signal that aborts `ms` milliseconds from now, bounding one webhook send or give-up alert:
   * the platform's timeout signal in the process, a fake on the test's clock in a test.
   */
  readonly abortAfter: (ms: number) => AbortSignal;
  /** A number in [0, 1), as `Math.random`, for the model backoff's jitter. */
  readonly random: () => number;
  /** The embedded Postgres of `facetdb dev`, kept in a directory of the project. */
  readonly embedded: EmbeddedDatabases;
  /** The example projects `facetdb init --example` copies into the project. */
  readonly examples: ExampleShelf;
  /** Single keys and a card's width and colour, for `facetdb review`. */
  readonly terminal: ReviewTerminal;
  /** The studio's build the worker serves beside the API. */
  readonly studio: StudioInstall;
  /**
   * Opens an address in the user's browser (`facetdb studio`): the platform's opener in the
   * process (`cli/browser.ts`), a recording fake in a test. Rejects when no browser could be started.
   */
  readonly openBrowser: (url: string) => Promise<void>;
};

/** Where this install keeps the studio's build, and how a build directory's files are read. */
export type StudioInstall = {
  /**
   * The build `facetdb studio` serves unless `--studio-dir` names another: `@facetdb/studio`'s
   * `dist/`, absolute; undefined when this install holds no studio package.
   */
  readonly defaultDir: string | undefined;
  /** The files of a build directory (absolute), as the HTTP surface reads them. */
  readonly files: (dir: string) => StudioFiles;
};

/** One request in, one response out: the shape of a Hono app's `fetch`, told who is on the other end. */
export type HttpHandler = (request: Request, peer: Peer) => Response | Promise<Response>;

/** A bound HTTP server: the port it listens on, and how to stop listening. */
export type HttpListener = {
  readonly port: number;
  close(): Promise<void>;
};

/**
 * A database engine as the composition root registers it: the key the scheme table names it by
 * (`postgres`, `mysql`, `polling`; `cli/engines.ts`), and how to make it, called on first use for a
 * source of that key only (`lazyEngine` keeps what it made), so `facetdb` never imports a driver
 * no source of the project needs (SQL Server's alone loads a whole identity library).
 */
export type EngineEntry = {
  readonly key: string;
  readonly load: () => Promise<DatabaseEngine>;
};

/** A connection to the store's Postgres, as `CliDeps.connect` opens it. */
export type StoreClient = ReturnType<SqlConnect>;

/** The FacetDB store's services, as `CliDeps.store` opens them. */
export type OpenStore = Store;

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

/** One file of an example project: its path inside the example's directory, and its text. */
export type ExampleFile = { readonly path: string; readonly text: string };

/**
 * The example projects the facetdb package ships under `examples/` (`facetdb init --example`):
 * the composition root reads the package's own directory, a test may pass the same reader.
 */
export type ExampleShelf = {
  /** The files of the example in `directory` (`listings-mysql`), sorted by path; none when absent. */
  read(directory: string): Promise<readonly ExampleFile[]>;
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
export function asCliError(error: unknown): CliError {
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
  | "engines"
  | "store"
  | "provider"
  | "workspace"
  | "clock"
  | "backfill"
  | "serve"
  | "osUser"
  | "stopSignal"
  | "webhookFetch"
  | "abortAfter"
  | "random"
  | "embedded"
  | "examples"
  | "terminal"
  | "configFiles"
  | "studio"
  | "openBrowser";

/**
 * The test helper: runs the program in this process with the given dependencies and captures the
 * output. `answers` are what a user types at each prompt, in order; a prompt with none left fails
 * the run, so a test notices a question it did not expect. `interactive: false` is a run with no
 * terminal (a script piping `answers`, none left once they are read); a run is at a terminal
 * unless it says so.
 */
export async function runInProcess(
  argv: readonly string[],
  deps: Omit<CliDeps, "io" | OptionalInTests> &
    Partial<Pick<CliDeps, OptionalInTests>> & {
      readonly answers?: readonly string[];
      readonly interactive?: boolean;
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
    answerable: () => Promise.resolve((deps.interactive ?? true) || answers.length > 0),
  };
  const { answers: _answers, interactive: _interactive, ...rest } = deps;
  const code = await runProgram(
    argv,
    {
      // No engine: a command that picks one is refused in words naming none registered.
      engines: [],
      store: () => Promise.reject(new Error("this test gave the command no store")),
      provider: () => {
        throw new Error("this test gave the command no model provider");
      },
      backfill: () => Promise.reject(new Error("this test gave the command no backfill")),
      workspace: {
        exists: () => Promise.reject(new Error("this test gave the command no workspace")),
        write: () => Promise.reject(new Error("this test gave the command no workspace")),
        writeParts: () => Promise.reject(new Error("this test gave the command no workspace")),
        peek: () => Promise.reject(new Error("this test gave the command no workspace")),
        lines: () => {
          throw new Error("this test gave the command no workspace");
        },
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
      osUser: () => {
        throw new Error("this test gave the command no operating system user");
      },
      stopSignal: () => {
        throw new Error("this test gave the command no stop signal");
      },
      webhookFetch: () => Promise.reject(new Error("this test gave the command no webhook fetch")),
      abortAfter: () => {
        throw new Error("this test gave the command no timeout signal");
      },
      random: () => {
        throw new Error("this test gave the command no random numbers");
      },
      embedded: {
        open: () => Promise.reject(new Error("this test gave the command no embedded database")),
        wipe: () => Promise.reject(new Error("this test gave the command no embedded database")),
      },
      examples: {
        read: () => Promise.reject(new Error("this test gave the command no example projects")),
      },
      terminal: NO_TERMINAL,
      configFiles: {
        read: () => Promise.reject(new Error("this test gave the command no config file")),
        replace: () => Promise.reject(new Error("this test gave the command no config file")),
        gitState: () => Promise.reject(new Error("this test gave the command no config file")),
      },
      // No studio in this install: a worker serves the API alone, and `facetdb studio` refuses.
      studio: {
        defaultDir: undefined,
        files: () => ({
          read: () => Promise.reject(new Error("this test gave the command no studio build")),
        }),
      },
      openBrowser: () => Promise.reject(new Error("this test gave the command no browser")),
      ...rest,
      io,
    },
    commands,
  );
  return { code, stdout, stderr, prompts };
}
