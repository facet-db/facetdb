import { type CliDeps, CliError, defineCommand, EXIT_USAGE, type OpenStore } from "../program.ts";
import { hashPassword, isUserName, USER_NAME_RULE, UsersNotWritableError } from "../store-door.ts";
import { ALLOW_INSECURE_OPTION } from "./database.ts";

/**
 * `facetdb users add|list|remove` ("In the open-source version, reviewer accounts are created with
 * `facetdb users add`"): the accounts of `facetdb.users` the studio asks for on any address but
 * this machine's. The store is opened as every store command opens it, from DATABASE_URL, so the
 * login that runs `add` and `remove` is that URL's: the worker login holds select on the table and
 * nothing more (store migration 6), and a command run with it is refused in words naming the owner
 * login to use instead. With a separate store database the store's own login owns the table and
 * DATABASE_URL already writes it. The password is asked twice with the echo off, or read as one
 * line of standard input with `--password-stdin`; only its scrypt hash is stored, and neither it
 * nor the hash is ever printed.
 */

type UsersOptions = {
  readonly passwordStdin?: boolean;
  readonly allowInsecure?: boolean;
};

const ACTIONS = ["add", "list", "remove"] as const;
type Action = (typeof ACTIONS)[number];

/** The shortest password `add` takes: a guess at an account that guards the review screen. */
const MIN_PASSWORD_LENGTH = 8;

/** What the studio does with no account, said wherever the last one goes or none exists. */
const LOOPBACK_ONLY =
  "the studio opens only on this machine's loopback address (127.0.0.1) until an account exists again";

function usage(message: string, fix: string): CliError {
  return new CliError("usage", message, fix, EXIT_USAGE);
}

function actionOf(word: string | undefined): Action {
  const action = ACTIONS.find((candidate) => candidate === word);
  if (action === undefined) {
    throw usage(
      word === undefined
        ? "facetdb users needs an action"
        : `facetdb users has no action "${word}"`,
      "run facetdb users add <name>, facetdb users list or facetdb users remove <name>",
    );
  }
  return action;
}

/** The account name the invocation names, checked before anything connects. */
function nameOf(action: "add" | "remove", given: string | undefined): string {
  if (given === undefined) {
    throw usage(
      `facetdb users ${action} needs the account's name`,
      `run facetdb users ${action} <name>`,
    );
  }
  if (!isUserName(given)) {
    throw usage(
      `"${given}" is not a name an account can have: it is ${USER_NAME_RULE}`,
      `choose a name like maya or review-team, and run facetdb users ${action} <name>`,
    );
  }
  return given;
}

/** Runs `use` on the store and lets go of it; a login that cannot write the table is told what to use. */
async function withStore<T>(
  deps: CliDeps,
  options: UsersOptions,
  use: (store: OpenStore) => Promise<T>,
): Promise<T> {
  const store = await deps.store({ allowInsecure: options.allowInsecure === true });
  try {
    return await use(store);
  } catch (error) {
    if (error instanceof UsersNotWritableError) {
      throw new CliError(
        "users-not-writable",
        "the login in DATABASE_URL may read the reviewer accounts but not change them, which is how the worker login is made; nothing was changed",
        "run this command with DATABASE_URL set to the store's owner login (the one facetdb migrate ran as; with a separate store database, the store's own login), for example DATABASE_URL=<that url> facetdb users add <name>",
      );
    }
    throw error;
  } finally {
    await store.close();
  }
}

/**
 * The new account's password: with `--password-stdin` one line of standard input (a script, a
 * password manager), else asked twice with the echo off. Whatever it is, it is never echoed back.
 */
async function passwordFor(deps: CliDeps, name: string, options: UsersOptions): Promise<string> {
  let password: string;
  if (options.passwordStdin === true) {
    password = await deps.io.prompt("Password: ", { secret: true });
  } else {
    if (!(await deps.io.answerable())) {
      throw new CliError(
        "no-answer",
        "there is no terminal to ask the password on, and no line of standard input was given for it",
        `pass the password as one line of standard input with --password-stdin, for example: printf '%s\\n' "$PASSWORD" | facetdb users add ${name} --password-stdin`,
      );
    }
    password = await deps.io.prompt(`Password for ${name}: `, { secret: true });
    const again = await deps.io.prompt("Type it again: ", { secret: true });
    if (again !== password) {
      throw new CliError(
        "password-mismatch",
        "the two passwords are not the same; nothing was changed",
        `run facetdb users add ${name} again and type the same password twice`,
      );
    }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(
      "weak-password",
      `the password is shorter than ${MIN_PASSWORD_LENGTH} characters; nothing was changed`,
      `choose a password of at least ${MIN_PASSWORD_LENGTH} characters, and run facetdb users add ${name} again`,
    );
  }
  return password;
}

function exists(name: string): CliError {
  return new CliError(
    "user-exists",
    `a reviewer account named "${name}" already exists; nothing was changed`,
    `choose another name, or to change its password run facetdb users remove ${name} and then facetdb users add ${name}`,
  );
}

function missing(name: string): CliError {
  return new CliError(
    "no-such-user",
    `there is no reviewer account named "${name}"; nothing was changed`,
    "facetdb users list shows the accounts that exist",
  );
}

export const usersCommand = defineCommand<UsersOptions>("users", {
  description:
    "Manage the reviewer accounts of the studio: facetdb users add <name>, list, remove <name>",
  arguments: ["<action>", "[name]"],
  options: [
    {
      flags: "--password-stdin",
      description: "add: read the password from one line of standard input instead of asking",
    },
    ALLOW_INSECURE_OPTION,
  ],
  async run({ options, args, deps, print }) {
    const action = actionOf(args[0]);
    const given = args[1];
    if (action === "list" && given !== undefined) {
      throw usage("facetdb users list takes no name", "run facetdb users list");
    }

    if (action === "list") {
      const accounts = await withStore(deps, options, (store) => store.users.list());
      if (accounts.length === 0) {
        print(
          `No reviewer accounts yet, so ${LOOPBACK_ONLY}. Make one with facetdb users add <name>.`,
        );
      }
      for (const account of accounts) {
        print(`${account.name}  added ${account.createdAt.toISOString().slice(0, 10)}`);
      }
      return {
        ok: true,
        users: accounts.map((account) => ({
          name: account.name,
          createdAt: account.createdAt.toISOString(),
        })),
      };
    }

    const name = nameOf(action, given);

    if (action === "add") {
      if (options.dryRun) {
        print(
          `Dry run: would ask for a password for the reviewer account "${name}" and store only its scrypt hash in the FacetDB store. A dry run does not open the store, so it cannot say whether the name is taken. Nothing was asked and nothing was changed.`,
        );
        return { ok: true, dryRun: true, name };
      }
      await withStore(deps, options, async (store) => {
        // Refused before the password is asked; the insert below settles a name taken meanwhile.
        if ((await store.users.list()).some((account) => account.name === name)) {
          throw exists(name);
        }
        const password = await passwordFor(deps, name, options);
        if (!(await store.users.add(name, await hashPassword(password)))) {
          throw exists(name);
        }
      });
      print(
        `Added the reviewer account "${name}". Reviewers sign in with this name and password when the studio is opened on any address but this machine's.`,
      );
      return { ok: true, name, added: true };
    }

    if (options.dryRun) {
      print(
        `Dry run: would remove the reviewer account "${name}" after asking you to type its name back. A dry run does not open the store. Nothing was asked and nothing was changed.`,
      );
      return { ok: true, dryRun: true, name };
    }
    const lastAccount = await withStore(deps, options, async (store) => {
      if (!(await store.users.list()).some((account) => account.name === name)) {
        throw missing(name);
      }
      const typed = await deps.io.prompt(`Type the account name (${name}) to remove it: `);
      if (typed.trim() !== name) {
        throw new CliError(
          "not-confirmed",
          `the name typed is not "${name}"; nothing was changed`,
          `run facetdb users remove ${name} again and type the name exactly`,
        );
      }
      if (!(await store.users.remove(name))) {
        throw missing(name);
      }
      return (await store.users.list()).length === 0;
    });
    print(`Removed the reviewer account "${name}".`);
    if (lastAccount) {
      print(`That was the last account: ${LOOPBACK_ONLY}. Make one with facetdb users add <name>.`);
    }
    return { ok: true, name, removed: true, lastAccount };
  },
});
