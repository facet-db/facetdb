import { type ActionContext, type ActionDefinition, action, type Infer, z } from "facetdb/plugin";
import {
  COMMENT_MAX,
  carries,
  commentBody,
  markerOf,
  parseTemplate,
  render,
  type Template,
  UnknownQuestion,
} from "./comment-body.ts";
import { type IssueRef, issueOf, issuePath, readIssue, repoPath } from "./issue.ts";
import {
  GithubActionError,
  type GithubFetch,
  pages,
  rateLimited,
  refusal,
  type Session,
  send,
} from "./rest.ts";
import { apiBase, type GithubConfig, repoSetting } from "./settings.ts";

/**
 * The GitHub plugin's actions: `label`, `comment` and `assign`, each changing the one issue a
 * record's key names, as the decision's settings say.
 *
 * Delivered at least once, so each reads the issue, then writes only what differs: a second run
 * with the same settings finds nothing to change and writes nothing. None closes, locks, deletes or
 * transfers anything: a label, an assignee and a comment are all undone from the issue's page (an
 * action is never the only barrier before an irreversible effect).
 */

/** What the actions are given besides their context: the two side effects, wired in index.ts. */
export type ActionDeps = {
  readonly fetch: GithubFetch;
  /** Milliseconds since the epoch: the clock a rate limit's reset time is read against. */
  readonly now: () => number;
};

/**
 * A label's name as GitHub takes one: one line, at most 50 characters, not blank, and never only
 * dots: `.` or `..` is a step in the URL's path, so `labels/..` would reach the repository and
 * `issues/7/labels/.` GitHub's route that removes every label (`urlOf` refuses them too).
 */
const labelName = z
  .string()
  .trim()
  .min(1, { error: "a label's name is not blank" })
  .max(50, { error: "a label's name is at most 50 characters, as GitHub allows" })
  .refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name), {
    error: "a label's name holds no line breaks or invisible characters",
  })
  .refine((name) => !/^\.+$/.test(name), {
    error: "a label's name is not only dots (. and .. are steps in a URL's path)",
  });

/** A login as GitHub writes one: letters, digits and single dashes, at most 39 (never a dot). */
const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, {
  error: "a GitHub login is letters, digits and single dashes (at most 39), without the @",
});

/** Refuses a use that names neither list: it would do nothing on every decision. */
function addOrRemove(settings: { readonly add?: unknown; readonly remove?: unknown }): boolean {
  return settings.add !== undefined || settings.remove !== undefined;
}

const labelSettings = z
  .object({
    /** `owner/name`, the record's key the issue number; required (settings.ts, `repoSetting`). */
    repo: repoSetting("label"),
    add: z.array(labelName).max(100).optional(),
    remove: z.array(labelName).max(100).optional(),
  })
  .refine(addOrRemove, { error: "name the labels to add, to remove, or both" });

const assignSettings = z
  .object({
    repo: repoSetting("assign"),
    // GitHub takes at most 10 assignees on an issue.
    add: z.array(login).max(10).optional(),
    remove: z.array(login).max(10).optional(),
  })
  .refine(addOrRemove, { error: "name the logins to assign, to unassign, or both" });

/** A comment's id: lowercase letters and digits, words joined by single dashes. */
const COMMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `id` is asked for, said when it is missing or refused. */
const COMMENT_ID_WHY =
  'the comment action needs an id, a short name of lowercase letters, digits and single dashes such as id: "triage": it names this comment in its hidden marker so the action finds it again on the issue, so it must stay the same when the actions are reordered, and each comment action of a source needs its own';

/** The help the settings form and a reader of the schema see: what the comment action needs. */
const COMMENT_HELP =
  "One comment per record on the issue the record's key names, kept up to date with the decision. Needs a token tied to an account (a personal access token, classic or fine-grained): a GitHub App's installation token cannot say whose comments are the action's own (GitHub answers 403 on /user).";

const commentSettings = z
  .object({
    repo: repoSetting("comment"),
    /**
     * The comment's text, in Markdown: `{{name}}` is a question's decided value, `{{name.probability}}`
     * its probability (a choice's or a score's confidence), `{{status}}` the record's status.
     */
    body: z.string().superRefine((body, context) => {
      const parsed = parseTemplate(body);
      if (!parsed.ok) {
        for (const problem of parsed.problems) {
          context.addIssue({ code: "custom", message: `the comment's body ${problem}` });
        }
      }
    }),
    /**
     * Which comment of the source this action keeps, named in its hidden marker; required.
     *
     * The marker names an id, not the action's position: the SDK does not tell an action its
     * position, and an id is sturdier than one, since moving an action in the list would change its
     * position and orphan its comment, while the id stays. Required, because two comment actions on
     * one source with the same id would rewrite one comment in turn on every delivery, and an
     * action's schema cannot see its siblings to refuse that.
     */
    id: z
      .string({ error: COMMENT_ID_WHY })
      .max(40, { error: COMMENT_ID_WHY })
      .regex(COMMENT_ID, { error: COMMENT_ID_WHY }),
  })
  .describe(COMMENT_HELP);

type LabelSettings = Infer<typeof labelSettings>;
type AssignSettings = Infer<typeof assignSettings>;
type CommentSettings = Infer<typeof commentSettings>;
type Context = ActionContext<GithubConfig>;

/** The session one action's requests share, and the issue they may touch. */
function begin(
  deps: ActionDeps,
  ctx: Context,
  name: string,
  repo: string | undefined,
  key: string,
): { readonly session: Session; readonly issue: IssueRef } {
  const issue = issueOf(name, ctx.source, repo, key);
  return {
    issue,
    session: {
      fetch: deps.fetch,
      now: deps.now,
      token: ctx.config.token,
      base: apiBase(ctx.config.apiUrl),
      signal: ctx.signal,
      subject: `github ${name} on ${issue.label}`,
    },
  };
}

/**
 * What a list setting asks for against what the issue holds, by GitHub's case-insensitive names: to
 * add, what is missing (once each); to remove, what is there, as the issue spells it. A name in
 * both lists is removed: `else: { remove }` is laid over the action's own `add` (the worked
 * example), so a name in both is the condition not holding.
 */
function changes(
  present: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): { readonly toAdd: string[]; readonly toRemove: string[] } {
  const removing = new Set(remove.map((name) => name.toLowerCase()));
  const there = new Set(present.map((name) => name.toLowerCase()));
  const toAdd: string[] = [];
  for (const name of add) {
    const lower = name.toLowerCase();
    if (!removing.has(lower) && !there.has(lower)) {
      toAdd.push(name);
      there.add(lower);
    }
  }
  const toRemove = present.filter((name) => removing.has(name.toLowerCase()));
  return { toAdd, toRemove };
}

/** GitHub's validation failure: only each error's `resource` and `code` are read, never its words. */
const validation = z.object({
  errors: z.array(z.object({ resource: z.string().optional(), code: z.string() })),
});

/** Whether a 422's body says the thing to create exists already. */
function alreadyExists(body: unknown): boolean {
  const parsed = validation.safeParse(body);
  return parsed.success && parsed.data.errors.some((error) => error.code === "already_exists");
}

/** Whether a 422's body names a label the repository lacks (a `Label` resource, or `missing`). */
function missingLabel(body: unknown): boolean {
  const parsed = validation.safeParse(body);
  return (
    parsed.success &&
    parsed.data.errors.some((error) => error.resource === "Label" || error.code === "missing")
  );
}

const LABEL_NAMES_FIX =
  "check the label names in the action's add (GitHub allows at most 50 characters)";

/**
 * `label`: adds what is missing and removes what is there. A label the repository lacks is created
 * by GitHub itself when it is added to an issue, as GitHub's REST API is understood to do (a live
 * run proves which path GitHub takes). Only when GitHub refuses the addition with a 422 naming a
 * missing label are the labels created in the repository, then added again: the one write outside
 * the issue.
 */
async function runLabel(
  deps: ActionDeps,
  ctx: Context,
  key: string,
  settings: LabelSettings,
): Promise<void> {
  const { session, issue } = begin(deps, ctx, "label", settings.repo, key);
  const state = await readIssue(session, issue);
  if (state === undefined) {
    return;
  }
  const { toAdd, toRemove } = changes(state.labels, settings.add ?? [], settings.remove ?? []);
  if (toAdd.length > 0) {
    const adding = {
      method: "POST",
      path: issuePath(issue, "labels"),
      body: { labels: toAdd },
      step: "adding the labels",
      invalid: LABEL_NAMES_FIX,
      accept: [422],
    } as const;
    const added = await send(session, adding);
    if (added.status === 422) {
      if (!missingLabel(added.body)) {
        throw refusal(session, adding, added);
      }
      for (const name of toAdd) {
        const creating = {
          method: "POST",
          path: repoPath(issue, "labels"),
          body: { name },
          step: `creating the label "${name}"`,
          accept: [422],
          invalid: LABEL_NAMES_FIX,
        } as const;
        const created = await send(session, creating);
        // A 422 `already_exists` is a label that is there (it was not the missing one, or another
        // run made it since): as wanted. Any other 422 is GitHub refusing the name.
        if (created.status === 422 && !alreadyExists(created.body)) {
          throw refusal(session, creating, created);
        }
      }
      await send(session, { ...adding, accept: [] });
    }
  }
  for (const name of toRemove) {
    // A 404: a person or another run removed it since the read, which is what was wanted.
    await send(session, {
      method: "DELETE",
      path: issuePath(issue, "labels", name),
      step: `removing the label "${name}"`,
      accept: [404],
    });
  }
}

/** An issue's assignees as GitHub answers an assignment: only the logins are read. */
const assigned = z.object({ assignees: z.array(z.object({ login: z.string() })) });

/** `assign`: assigns the logins not assigned yet and unassigns those that are. */
async function runAssign(
  deps: ActionDeps,
  ctx: Context,
  key: string,
  settings: AssignSettings,
): Promise<void> {
  const { session, issue } = begin(deps, ctx, "assign", settings.repo, key);
  const state = await readIssue(session, issue);
  if (state === undefined) {
    return;
  }
  const { toAdd, toRemove } = changes(state.assignees, settings.add ?? [], settings.remove ?? []);
  if (toAdd.length > 0) {
    const reply = await send(session, {
      method: "POST",
      path: issuePath(issue, "assignees"),
      body: { assignees: toAdd },
      step: "assigning the issue",
      invalid: "check the logins in the action's add",
    });
    // GitHub skips a login it cannot assign (no access to the repository) without saying so.
    const parsed = assigned.safeParse(reply.body);
    const now = new Set((parsed.data?.assignees ?? []).map((one) => one.login.toLowerCase()));
    const skipped = parsed.success ? toAdd.filter((one) => !now.has(one.toLowerCase())) : [];
    if (skipped.length > 0) {
      throw new GithubActionError(
        `${session.subject}: GitHub did not assign ${skipped.join(", ")}`,
        "a login is assigned only when it can see the repository (a collaborator, or a member of its organisation), and an issue takes at most 10 assignees",
        reply.status,
      );
    }
  }
  if (toRemove.length > 0) {
    await send(session, {
      method: "DELETE",
      path: issuePath(issue, "assignees"),
      body: { assignees: toRemove },
      step: "unassigning the issue",
    });
  }
}

/** The token's own account, read to tell the action's comments from anyone else's. */
const viewer = z.object({ login: z.string().min(1) });

/** A comment as the action reads it: an id, a body, and its author when GitHub still has one. */
const commentShape = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

/** The fix when GitHub cannot say whose token it is. */
const ACCOUNT_TOKEN_FIX =
  "the comment action needs a token GitHub ties to an account (a personal access token, classic or fine-grained), to tell its own comments from anyone else's; a GitHub App's installation token is not one";

/** The login the token belongs to; a 403 that is not a rate limit is a token tied to no account. */
async function whoAmI(session: Session): Promise<string> {
  const request = {
    method: "GET",
    path: ["user"],
    step: "reading whose token it is",
    accept: [403],
  } as const;
  const reply = await send(session, request);
  if (reply.status === 403) {
    if (rateLimited(reply)) {
      throw refusal(session, request, reply);
    }
    throw new GithubActionError(
      `${session.subject}: GitHub answered 403 to reading whose token it is`,
      ACCOUNT_TOKEN_FIX,
      reply.status,
    );
  }
  const parsed = viewer.safeParse(reply.body);
  if (!parsed.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading whose token it is is not an account FacetDB can read`,
      ACCOUNT_TOKEN_FIX,
      reply.status,
    );
  }
  return parsed.data.login;
}

/**
 * Runs `work` after every earlier run holding the same key has finished, within this plugin (one
 * worker): two deliveries of one comment action on one issue (a row queued again, a person's
 * decision beside the worker's) read and write one after the other, so the second finds the
 * first's comment instead of posting its own.
 */
function serialised(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async (key, work) => {
    const before = tails.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const tail = mine.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await mine;
    } finally {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}

/**
 * A body as GitHub may give it back: line endings as `\n`, no trailing whitespace on a line or at
 * the end, so a stored body that differs only so is not edited on every run.
 */
function normalised(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/**
 * `comment`: one comment per record and action, found again by its hidden marker among the issue's
 * comments by the token's own account, edited when its text differs and left alone when it does
 * not; posted when there is none. A comment by anyone else is never edited, whatever it holds.
 *
 * The token must be tied to an account (a personal access token, classic or fine-grained): the
 * author of a comment holding the marker is compared with the token's own login, read from
 * `GET /user` only when such a comment exists. A GitHub App's installation token is answered 403
 * there, and the action fails in fixed words that say so.
 */
async function runComment(
  deps: ActionDeps,
  ctx: Context,
  record: { readonly key: string; readonly status: string },
  decisions: Parameters<typeof render>[2],
  settings: CommentSettings,
  queue: ReturnType<typeof serialised>,
): Promise<void> {
  const { session, issue } = begin(deps, ctx, "comment", settings.repo, record.key);
  // The schema refused any template this cannot read.
  const template = (parseTemplate(settings.body) as { readonly template: Template }).template;
  let text: string;
  try {
    text = render(template, record.status, decisions);
  } catch (error) {
    if (error instanceof UnknownQuestion) {
      throw new GithubActionError(
        `${session.subject}: the comment's body names {{${error.question}}}, but the record has no decision for a question named ${error.question}`,
        "write a question of the source in each placeholder of the comment's body",
      );
    }
    throw error;
  }
  const marker = markerOf(ctx.source.name, settings.id);
  const body = commentBody(marker, text);
  if (body.length > COMMENT_MAX) {
    throw new GithubActionError(
      `${session.subject}: the comment would be longer than GitHub's ${COMMENT_MAX} characters`,
      "shorten the comment's body",
    );
  }
  const state = await readIssue(session, issue);
  if (state === undefined) {
    return;
  }
  await queue(`${session.base.href} ${issue.label} ${marker}`, async () => {
    const listed = await pages(session, {
      method: "GET",
      path: issuePath(issue, "comments"),
      step: "reading the issue's comments",
    });
    // An item of another shape is no comment of the action's: skipped, never trusted.
    const marked = listed
      .map((item) => commentShape.safeParse(item).data)
      .filter((comment) => comment !== undefined && carries(comment.body, marker)) as Infer<
      typeof commentShape
    >[];
    // Whose token it is matters only when a comment holds the marker: only then is there an
    // author to compare.
    const me = marked.length === 0 ? undefined : (await whoAmI(session)).toLowerCase();
    const mine =
      me === undefined
        ? []
        : marked.filter(
            (comment) => comment.user !== null && comment.user.login.toLowerCase() === me,
          );
    // More than one is left by two workers that raced (open): each is kept at the same text.
    let kept = 0;
    for (const comment of mine) {
      if (normalised(comment.body) === normalised(body)) {
        kept += 1;
        continue;
      }
      const edited = await send(session, {
        method: "PATCH",
        path: repoPath(issue, "issues", "comments", String(comment.id)),
        body: { body },
        step: "editing the comment",
        invalid: "check the comment's body",
        // Deleted since the list was read (by a person): it is written again below.
        accept: [404],
      });
      if (edited.status !== 404) {
        kept += 1;
      }
    }
    if (kept === 0) {
      await send(session, {
        method: "POST",
        path: issuePath(issue, "comments"),
        body: { body },
        step: "posting the comment",
        invalid: "check the comment's body",
      });
    }
  });
}

/** The three actions, each over the `fetch` and the clock it is given. */
export function githubActions(
  deps: ActionDeps,
): Readonly<Record<"label" | "comment" | "assign", ActionDefinition<GithubConfig>>> {
  const queue = serialised();
  return {
    label: action<GithubConfig, typeof labelSettings>({
      config: labelSettings,
      run: (ctx, record, _decisions, settings) => runLabel(deps, ctx, record.key, settings),
    }),
    comment: action<GithubConfig, typeof commentSettings>({
      config: commentSettings,
      run: (ctx, record, decisions, settings) =>
        runComment(deps, ctx, record, decisions, settings, queue),
    }),
    assign: action<GithubConfig, typeof assignSettings>({
      config: assignSettings,
      run: (ctx, record, _decisions, settings) => runAssign(deps, ctx, record.key, settings),
    }),
  };
}
