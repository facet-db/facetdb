import {
  hashPassword,
  isUserName,
  MIN_PASSWORD_LENGTH,
  type ReviewerAccount,
  USER_NAME_RULE,
  UsersNotWritableError,
  type UsersStore,
} from "@facetdb/postgres";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson } from "../request.ts";
import type { AppEnv } from "./middleware.ts";
import { MAX_PASSWORD_LENGTH } from "./sessions.ts";

/**
 * The reviewer accounts for the Settings page (`GET` and `POST /v1/reviewers`). The rules and the
 * words are `facetdb users add`'s (packages/facetdb/src/cli/commands/users.ts): a name is checked
 * by `isUserName`, a password has at least `MIN_PASSWORD_LENGTH` characters, and only its scrypt
 * hash is stored. Removing an account stays a terminal act (`facetdb users remove`), which asks
 * for the name back.
 */

export type AddOutcome =
  | { readonly kind: "added" }
  | { readonly kind: "invalid-name" }
  | { readonly kind: "weak-password" }
  | { readonly kind: "exists" };

export type Reviewers = {
  list(): Promise<readonly ReviewerAccount[]>;
  /**
   * Whether `add` can succeed at all: false under the worker login, which may read the accounts
   * and not write them, so the Settings page shows the terminal command instead of the form.
   */
  canAdd(): Promise<boolean>;
  /** Makes the account unless the name or password is not allowed or the name is taken. */
  add(name: string, password: string, addedBy: string): Promise<AddOutcome>;
};

export type ReviewersDeps = {
  readonly users: Pick<UsersStore, "list" | "add" | "writable">;
  /** One line per account made: its name and who made it, never a password or a hash. */
  readonly log: (line: string) => void;
};

export function createReviewers({ users, log }: ReviewersDeps): Reviewers {
  return {
    list: () => users.list(),
    canAdd: () => users.writable(),

    async add(name, password, addedBy) {
      if (!isUserName(name)) {
        return { kind: "invalid-name" };
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return { kind: "weak-password" };
      }
      // Refused before the hash is made, as `add` refuses before it asks; the insert below
      // settles a name taken meanwhile.
      if ((await users.list()).some((account) => account.name === name)) {
        return { kind: "exists" };
      }
      if (!(await users.add(name, await hashPassword(password)))) {
        return { kind: "exists" };
      }
      log(`reviewers: ${addedBy} added the account ${name}`);
      return { kind: "added" };
    },
  };
}

const addBody = z.strictObject({
  name: z.string().min(1).max(200),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

/** Behind `requireReviewer`: the reviewer on record is `c.get("reviewer")`. */
export function reviewersRoutes(reviewers: Reviewers): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/", async (c) =>
    c.json({
      reviewers: (await reviewers.list()).map((account) => ({
        name: account.name,
        createdAt: account.createdAt.toISOString(),
      })),
    }),
  );

  route.post("/", async (c) => {
    const body = addBody.safeParse(await readJson(c.req));
    if (!body.success) {
      throw new ApiError(
        400,
        "invalid_request",
        bodyProblems(body.error),
        'Send {"name": "<account name>", "password": "<password>"}.',
      );
    }
    const { name, password } = body.data;
    let outcome: AddOutcome;
    try {
      outcome = await reviewers.add(name, password, c.get("reviewer"));
    } catch (error) {
      if (error instanceof UsersNotWritableError) {
        throw new ApiError(
          403,
          "users-not-writable",
          "The login in DATABASE_URL may read the reviewer accounts but not change them, which is how the worker login is made; nothing was changed.",
          "Make the account from a terminal with DATABASE_URL set to the store's owner login (the one facetdb migrate ran as; with a separate store database, the store's own login), for example DATABASE_URL=<that url> facetdb users add <name>.",
        );
      }
      throw error;
    }
    switch (outcome.kind) {
      case "added":
        return c.json({ name, added: true }, 201);
      case "invalid-name":
        throw new ApiError(
          400,
          "invalid-name",
          `"${name}" is not a name an account can have: it is ${USER_NAME_RULE}.`,
          "Choose a name like maya or review-team, and send it again.",
        );
      case "weak-password":
        throw new ApiError(
          400,
          "weak-password",
          `The password is shorter than ${MIN_PASSWORD_LENGTH} characters; nothing was changed.`,
          `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters, and send it again.`,
        );
      case "exists":
        throw new ApiError(
          409,
          "user-exists",
          `A reviewer account named "${name}" already exists; nothing was changed.`,
          `Choose another name, or to change its password run facetdb users remove ${name} and then facetdb users add ${name}.`,
        );
    }
  });

  return route;
}
