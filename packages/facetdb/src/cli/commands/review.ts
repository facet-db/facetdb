import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ActionStep,
  type Connector,
  contentHash,
  createReviewService,
  type DecisionLog,
  likelyYes,
  type OpenConnector,
  parseQuestionSet,
  percent,
  type Question,
  type QuestionSet,
  type ReviewCard,
  type ReviewFilter,
  type ReviewQuestions,
  type ReviewQueue,
  type ReviewService,
} from "@facetdb/core";
import { OS_REVIEWER_PREFIX } from "@facetdb/server";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import { keyWords, openConnector, tableKeyText } from "../engines.ts";
import {
  CliError,
  type CommandContext,
  defineCommand,
  EXIT_USAGE,
  type OpenStore,
  type RegisteredCommand,
} from "../program.ts";
import {
  isUserName,
  requireUsableStoreUrl,
  storeSharedFor,
  storeSourceId,
  USER_NAME_RULE,
} from "../store-door.ts";
import { ALLOW_INSECURE_OPTION, loadProjectConfig, projectRef, questionSetOf } from "./database.ts";
import { type TableRead, tableRead } from "./explain.ts";
import { COLORED, PLAIN, waitingWords, wrap } from "./review-card.ts";
import { reviewFromFile } from "./review-from.ts";
import { reviewSession, type SourceView } from "./review-session.ts";

/**
 * `facetdb review`: the review screen for people who live in a terminal. One card at a time from
 * the same queue, the same lock and the same review service as the studio, so a card open here is
 * shown to nobody else and every decision is logged and written exactly as a studio decision is.
 * `--json` prints the queue instead and needs no terminal.
 *
 * Who decides: `os:<your user name>`, or `--user <name>` for a `facetdb users` account, whose
 * password is asked first (echo off) and checked against the store's accounts. The password is a
 * keyboard question, so `--user` needs the terminal the review needs anyway; with `--json` nothing
 * is decided and no password is asked, the name only has to be an account (it decides which cards
 * count as skipped, and which are another reviewer's).
 *
 * `--below <p>` is the queue's band filter as it is: a card matches when the model's figure for one
 * of its open questions is under p (with `--question`, for that question). `--limit <n>` is the
 * most cards one review opens, or the most the queue prints under `--json`.
 */

type ReviewOptions = {
  readonly config: string;
  readonly source?: string;
  readonly question?: string;
  readonly below?: string;
  readonly limit?: string;
  readonly user?: string;
  readonly from?: string;
  readonly yes?: boolean;
  readonly allowInsecure?: boolean;
};

/** What the invocation asks for, checked before anything connects. */
type ReviewPlan = {
  readonly below: number | undefined;
  readonly limit: number | undefined;
};

/** The sources a review covers, and what the command checked about them. */
export type ReviewInput = {
  readonly context: CommandContext<ReviewOptions>;
  readonly config: ProjectConfig;
  /** `--source`'s one source, else every source of the config. */
  readonly sources: readonly SourceConfig[];
};

/**
 * A source as the review shows it, with the id the store keeps its cards under and the question
 * set and version the store has in force for it: the cards are judged with these, never with the file.
 */
export type ReviewSource = SourceView & { readonly id: string; readonly version: number };

/** The queue read-only: what `--json` prints. */
export type QueueRead = {
  /** Who is asking: whose skips order the queue, and whose live locks hide a card. */
  readonly reviewer: string;
  readonly queue: Pick<ReviewQueue, "list">;
  readonly sources: readonly ReviewSource[];
  /** Each source's log by its store id, read-only here: `--from` reads a record's history to say who decided it. */
  readonly logs: ReadonlyMap<string, Pick<DecisionLog, "history">>;
  /** The saved question sets of a source's versions (one the store does not keep is absent): what an export row's words were made under. */
  versions(
    sourceId: string,
    versions: readonly number[],
  ): Promise<ReadonlyMap<number, QuestionSet>>;
  close(): Promise<void>;
};

/** The queue and the means to decide on it. */
export type CardsRead = QueueRead & { readonly service: ReviewService };

/**
 * What the command opens, so a test hands it a fake service and queue through the same command:
 * `projectDoor` is the real one (the store of `DATABASE_URL` and each source's connector).
 */
export type ReviewDoor = {
  queue(input: ReviewInput): Promise<QueueRead>;
  cards(input: ReviewInput): Promise<CardsRead>;
};

function usage(code: string, message: string, fix: string): CliError {
  return new CliError(code, message, fix, EXIT_USAGE);
}

function planOf(options: ReviewOptions): ReviewPlan {
  let below: number | undefined;
  if (options.below !== undefined) {
    const figure = options.below.trim() === "" ? Number.NaN : Number(options.below);
    if (!(figure > 0 && figure < 1)) {
      throw usage(
        "review-below",
        `--below takes a number between 0 and 1, not "${options.below}": 0.6 means 60%`,
        "pass --below 0.6 to see only the cards where the model is under 60% sure of an open question",
      );
    }
    below = figure;
  }
  let limit: number | undefined;
  if (options.limit !== undefined) {
    const count = Number(options.limit);
    if (!Number.isInteger(count) || count < 1) {
      throw usage(
        "review-limit",
        `--limit takes a whole number of cards, 1 or more, not "${options.limit}"`,
        "pass --limit 50 to review at most 50 cards",
      );
    }
    limit = count;
  }
  if (options.from !== undefined) {
    // The file names its records; these narrow a walk through the queue.
    const walking = (
      [
        ["--question", options.question],
        ["--below", options.below],
        ["--limit", options.limit],
      ] as const
    )
      .filter(([, given]) => given !== undefined)
      .map(([flag]) => flag);
    if (walking.length > 0) {
      throw usage(
        "review-from-flags",
        `${walking.join(" and ")} narrow${walking.length === 1 ? "s" : ""} the cards a person walks through, and --from names its records in the file`,
        "leave them out; --source keeps --from to the rows of one source",
      );
    }
  } else if (options.yes === true) {
    throw usage(
      "review-yes",
      "--yes confirms the decisions --from is about to apply, and there is no --from",
      "add --from <file>, or leave --yes out",
    );
  }
  if (options.user !== undefined && !isUserName(options.user)) {
    throw usage(
      "review-user",
      `"${options.user}" is not a name a reviewer account can have: it is ${USER_NAME_RULE}`,
      "pass --user with the name of an account (facetdb users list shows them), or leave it out to review as os:<your user name>",
    );
  }
  return { below, limit };
}

/** How a figure reads in the queue's JSON: words beside the number, whatever the question's type. */
function figureWords(question: Question | undefined, figure: number): string {
  return question?.type === "noul" ? likelyYes(figure) : `${percent(figure)} sure`;
}

function queueDocument(
  cards: readonly ReviewCard[],
  sources: ReadonlyMap<string, ReviewSource>,
  nowMs: number,
) {
  return cards.map((card) => {
    const source = sources.get(card.source);
    const questions = source?.questionSet.questions ?? [];
    return {
      source: source?.name ?? card.source,
      key: keyWords(source?.keyText, card.key),
      waitingSince: card.since.toISOString(),
      waiting: waitingWords(nowMs - card.since.getTime()),
      skippedByYou: card.skipped,
      open: card.openQuestions.map((name) => {
        const question = questions.find((candidate) => candidate.name === name);
        const figure = card.numbers[name];
        return {
          question: name,
          ...(figure === undefined ? {} : { says: figureWords(question, figure), figure }),
        };
      }),
    };
  });
}

function filterOf(
  options: ReviewOptions,
  plan: ReviewPlan,
  sources: ReadonlyMap<string, ReviewSource>,
): ReviewFilter {
  const only = [...sources.values()].find((source) => source.name === options.source);
  return {
    ...(only === undefined ? {} : { source: only.id }),
    ...(options.question === undefined ? {} : { question: options.question }),
    ...(plan.below === undefined ? {} : { below: plan.below }),
  };
}

/** What a filter that matches nothing was asking for, so "nothing to review" says why. */
function filterWords(options: ReviewOptions, plan: ReviewPlan): string {
  const parts = [
    options.source === undefined ? "" : ` in ${options.source}`,
    options.question === undefined ? "" : ` with ${options.question} open`,
    plan.below === undefined ? "" : ` where the model is under ${percent(plan.below)} sure`,
  ];
  return parts.join("");
}

export function createReviewCommand(door: ReviewDoor): RegisteredCommand {
  return defineCommand<ReviewOptions>("review", {
    description:
      "Reviews the records that need a person, one card at a time in the terminal, with the same locks, log and actions as the studio",
    options: [
      {
        flags: "--config <path>",
        description: "the config file",
        defaultValue: "facetdb.config.ts",
      },
      { flags: "--source <name>", description: "only cards of this source" },
      {
        flags: "--question <name>",
        description: "only cards on which this question is still open",
      },
      {
        flags: "--below <p>",
        description:
          "only cards where the model's figure for an open question is under p, a number between 0 and 1 (0.6 means 60%): how likely yes for a yes-or-no question, how confident it is in its top answer for a choice or score; with --question, that question's figure",
      },
      {
        flags: "--limit <n>",
        description: "review at most n cards; with --json, print at most n",
      },
      {
        flags: "--user <name>",
        description:
          "decide as this reviewer account (facetdb users list) after its password is asked; by default as os:<your user name>",
      },
      {
        flags: "--from <file>",
        description:
          "apply the decisions in a JSONL file (the rows facetdb export writes, or {source, key, question, value, note?} rows) as the reviewer, after showing what it will do and asking; no card is walked through",
      },
      { flags: "--yes", description: "with --from, apply without asking, after showing the plan" },
      ALLOW_INSECURE_OPTION,
    ],
    run: async (context) => {
      const { options, deps, print } = context;
      const plan = planOf(options);
      const config = await loadProjectConfig(deps, options.config);
      const names = config.sources.map((source) => source.name).join(", ");
      const sources =
        options.source === undefined
          ? config.sources
          : config.sources.filter((source) => source.name === options.source);
      if (sources.length === 0) {
        throw usage(
          "unknown-source",
          `the config has no source named "${options.source}"`,
          `pass one of: ${names}`,
        );
      }
      if (options.question !== undefined) {
        const known = sources.flatMap((source) => source.questions.map((q) => q.name));
        if (!known.includes(options.question)) {
          throw usage(
            "unknown-question",
            options.source === undefined
              ? `no source of the config has a question named "${options.question}"`
              : `the source "${options.source}" has no question named "${options.question}"`,
            `pass one of: ${[...new Set(known)].join(", ")}`,
          );
        }
      }
      if (options.from !== undefined) {
        return reviewFromFile({ context, config, sources }, door, options.from);
      }
      const reviewer = options.user ?? `${OS_REVIEWER_PREFIX}${deps.osUser()}`;
      if (options.dryRun) {
        print(
          options.json
            ? `Dry run: would print the queue of ${sources.map((source) => source.name).join(", ")}${filterWords(options, plan)} for ${reviewer}. Nothing was opened or locked.`
            : `Dry run: would show the cards of ${sources.map((source) => source.name).join(", ")}${filterWords(options, plan)} one at a time as ${reviewer}${options.user === undefined ? "" : ", after asking for the account's password"}, locking each while it is open. Nothing was opened, locked or decided.`,
        );
        return { ok: true, dryRun: true, reviewer };
      }
      const input: ReviewInput = { context, config, sources };

      if (options.json) {
        const read = await door.queue(input);
        try {
          const byId = new Map(read.sources.map((source) => [source.id, source]));
          const listed = await read.queue.list(
            filterOf(options, plan, byId),
            read.reviewer,
            deps.clock.now(),
          );
          // The queue spans the store; a card of a source this config does not have is not ours.
          const cards = listed
            .filter((card) => byId.has(card.source))
            .slice(0, plan.limit ?? listed.length);
          return {
            ok: true,
            reviewer: read.reviewer,
            count: cards.length,
            cards: queueDocument(cards, byId, deps.clock.now()),
          };
        } finally {
          await read.close();
        }
      }

      if (!deps.terminal.interactive()) {
        throw new CliError(
          "no-terminal",
          "facetdb review needs a terminal: it reads single keys and draws one card at a time",
          "run facetdb review at a terminal, or add --json to print the queue for another tool",
        );
      }
      const review = await door.cards(input);
      try {
        const byId = new Map(review.sources.map((source) => [source.id, source]));
        const keys = deps.terminal.open();
        try {
          const result = await reviewSession({
            service: review.service,
            keys,
            clock: deps.clock,
            stop: deps.stopSignal(),
            reviewer: review.reviewer,
            filter: filterOf(options, plan, byId),
            limit: plan.limit,
            sources: byId,
            out: print,
            width: deps.terminal.columns(),
            style: deps.terminal.color() ? COLORED : PLAIN,
          });
          const say = (text: string) => print(wrap(text, deps.terminal.columns()).join("\n"));
          if (result.cards === 0) {
            say(
              `Nothing to review${filterWords(options, plan)}: no card is waiting for you. Cards another reviewer has open are not listed until their lock ends.`,
            );
          } else {
            const undone = result.undone === 0 ? "" : `, ${result.undone} taken back`;
            say(
              `Done: ${result.decisions} ${result.decisions === 1 ? "question" : "questions"} decided on ${result.cards} ${result.cards === 1 ? "card" : "cards"}, ${result.skipped} skipped${undone}. Every card you held is released.`,
            );
          }
          return { ok: true, reviewer: review.reviewer, ...result };
        } finally {
          keys.close();
        }
      } finally {
        await review.close();
      }
    },
  });
}

/** Asks for the account's password and checks it against the store's accounts. */
async function reviewerOf(
  context: CommandContext<ReviewOptions>,
  users: {
    verify(name: string, password: string): Promise<boolean>;
    list(): Promise<readonly { readonly name: string }[]>;
  },
  asksPassword: boolean,
): Promise<string> {
  const { options, deps } = context;
  if (options.user === undefined) {
    return `${OS_REVIEWER_PREFIX}${deps.osUser()}`;
  }
  const name = options.user;
  if (!asksPassword) {
    if (!(await users.list()).some((account) => account.name === name)) {
      throw new CliError(
        "no-such-user",
        `there is no reviewer account named "${name}"`,
        "facetdb users list shows the accounts that exist, or leave out --user to use os:<your user name>",
      );
    }
    return name;
  }
  const password = await deps.io.prompt(`Password for ${name}: `, { secret: true });
  if (!(await users.verify(name, password))) {
    throw new CliError(
      "wrong-login",
      `that is not the password of the reviewer account "${name}", or there is no such account`,
      "type the password again; facetdb users list shows the accounts, and leaving out --user reviews as os:<your user name>",
    );
  }
  return name;
}

/** The store of `DATABASE_URL` and each source's connector under the worker login, as the worker opens them. */
export const projectDoor: ReviewDoor = {
  async queue(input) {
    const { store, reviewer, sources } = await openStore(input, false);
    return {
      reviewer,
      queue: store.reviews,
      sources,
      logs: new Map(sources.map((source) => [source.id, store.log(source.id)])),
      versions: (sourceId, versions) => store.questionSets.versions(sourceId, versions),
      close: () => store.close(),
    };
  },

  async cards(input) {
    const opened = await openStore(input, true);
    const { store } = opened;
    const { context } = input;
    const { deps } = context;
    const allowInsecure = context.options.allowInsecure === true;
    const workerId = `review-${randomUUID()}`;
    const connectors: OpenConnector[] = [];
    const close = async () => {
      try {
        for (const connector of connectors) {
          await connector.close();
        }
      } finally {
        await store.close();
      }
    };
    try {
      // Nothing is written to the store before a decision: the project, the sources and their
      // question sets are what the worker left (see `versionsInForce`).
      const logs = new Map<string, DecisionLog>();
      const reading = new Map<string, Connector>();
      const actions = new Map<string, readonly ActionStep[]>();
      const questionSets = new Map<string, ReviewQuestions>();
      for (const view of opened.sources) {
        const source = input.sources.find((candidate) => candidate.name === view.name);
        if (source === undefined) {
          throw new Error(`the source ${view.name} is not one this review covers`);
        }
        // The version in force, as the store holds it: what the worker runs, and what a human decision carries.
        questionSets.set(view.id, { questionSet: view.questionSet, version: view.version });
        logs.set(view.id, store.log(view.id));
        // Plugin actions are not resolved yet: the worker runs none (its `actions: []`), so neither does a review.
        actions.set(view.id, []);
        const table = opened.tables.get(source.name);
        if (table === undefined) {
          reading.set(
            view.id,
            store.connector({ sourceId: view.id, fields: source.read, workerId }),
          );
          continue;
        }
        const connector = await openConnector(table.engine, table.target, table.url, {
          clock: deps.clock,
          allowInsecure,
          storeShared: storeSharedFor(deps.env, source),
          workerId,
        });
        connectors.push(connector);
        reading.set(view.id, connector);
      }
      const service = createReviewService({
        queue: store.reviews,
        log: logs,
        connectors: reading,
        actions,
        questionSets,
        clock: deps.clock,
      });
      return {
        reviewer: opened.reviewer,
        queue: store.reviews,
        sources: opened.sources,
        logs,
        versions: (sourceId, versions) => store.questionSets.versions(sourceId, versions),
        service,
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
};

/** A question set as the store keeps it: through JSON and the boundary's parser, so two compare equal. */
function stored(questionSet: QuestionSet): QuestionSet {
  const parsed = parseQuestionSet(JSON.parse(JSON.stringify(questionSet)));
  if (!parsed.ok) {
    throw new Error(
      `a question set the config produced does not parse: ${parsed.errors.join("; ")}`,
    );
  }
  return parsed.questionSet;
}

/**
 * In what ways two question sets differ, in the words of the config. `covered` are the differences
 * the version's content hash sees (the model, the fields read, a question's type, name, wording,
 * criteria, options or levels): a worker restarted with the file records a new version, so the
 * store shows the change. `uncovered` are the rest (thresholds, the where filter, stakes, the
 * probability columns, the order of the questions): the store writes a version's set only once,
 * so it keeps these as they were when the version was made, and a restarted worker leaves no trace.
 */
function differences(
  inStore: QuestionSet,
  inFile: QuestionSet,
): { covered: string[]; uncovered: string[] } {
  const same = isDeepStrictEqual;
  const hashed = contentHash(inStore) !== contentHash(inFile);
  const covered: string[] = [];
  const uncovered: string[] = [];
  if (inStore.model !== inFile.model) {
    covered.push("the model");
  }
  if (!same(inStore.read, inFile.read)) {
    covered.push("the fields it reads");
  }
  if (!same(inStore.questions, inFile.questions)) {
    // Whether the hash saw it: wording and options do, stakes and the order of the questions do not.
    (hashed ? covered : uncovered).push(
      hashed ? "the questions" : "the stakes or the order of the questions",
    );
  }
  if (!same(inStore.thresholds, inFile.thresholds)) {
    uncovered.push("the thresholds");
  }
  if (inStore.where !== inFile.where) {
    uncovered.push("the where filter");
  }
  return { covered, uncovered };
}

/** A source with the question set and version the store has in force for it. */
type InForce = {
  readonly source: SourceConfig;
  readonly questionSet: QuestionSet;
  readonly version: number;
};

/**
 * The question set and version the store holds for each source: what the worker last recorded, and
 * what the cards in the queue were judged by. The review writes nothing before a decision and
 * judges with these, never with the file. A source with no version has never run a worker, so it is
 * said so and left out; one whose file differs from its version in anything that changes how a
 * card reads (the questions, the fields read, the model, the thresholds, the where filter) stops
 * the review before any lock, because the worker is not running what the file says.
 */
async function versionsInForce(
  store: Pick<OpenStore, "questionSets">,
  input: ReviewInput,
  projectId: string,
  print: (text: string) => void,
): Promise<readonly InForce[]> {
  const kept: InForce[] = [];
  const drifted: string[] = [];
  // Whether any difference is one the version's content hash sees (a restart then clears it).
  let hashedChange = false;
  for (const source of input.sources) {
    const id = storeSourceId(projectId, source.name);
    const latest = await store.questionSets.latest(id);
    if (latest === undefined) {
      print(
        `${source.name} has never run a worker, so it has no cards to review; run facetdb worker, then review it.`,
      );
      continue;
    }
    const inStore = (await store.questionSets.versions(id, [latest.version])).get(latest.version);
    if (inStore === undefined) {
      throw new Error(`the store lists version ${latest.version} of "${id}" but does not keep it`);
    }
    const apart = differences(inStore, stored(questionSetOf(input.config, source)));
    const all = [...apart.covered, ...apart.uncovered];
    if (all.length > 0) {
      hashedChange ||= apart.covered.length > 0;
      drifted.push(
        `${source.name} runs version ${latest.version}, and the file differs in ${all.join(" and ")}`,
      );
      continue;
    }
    kept.push({ source, questionSet: inStore, version: latest.version });
  }
  if (drifted.length > 0 && !hashedChange) {
    // Only values the store keeps as they were when the version was made: it cannot tell whether
    // the worker already runs the file, so nothing here may tell the user to restart or to put the
    // file back (either could leave the check passing while the worker runs something else).
    throw new CliError(
      "config-may-differ",
      `this check cannot tell whether the worker already runs ${input.context.options.config} (${drifted.join("; ")}), because the store keeps those values as they were when that version was made; nothing was locked or written`,
      "review in the studio, which judges cards by what the worker runs",
    );
  }
  if (drifted.length > 0) {
    throw new CliError(
      "config-differs",
      `the worker is not running what ${input.context.options.config} says (${drifted.join("; ")}), and cards judged by one set of rules cannot be decided under another; nothing was locked or written`,
      "restart facetdb worker with this file so it runs these changes, or review in the studio, which judges by what the worker runs",
    );
  }
  if (kept.length === 0) {
    throw new CliError(
      "no-worker-yet",
      "no worker has run for the sources of the config, so the store has no cards to review",
      "run facetdb worker, let it answer some records, then run facetdb review",
    );
  }
  return kept;
}

/**
 * The store, who is reviewing, and the sources as the review shows them. The tables are checked
 * (their URLs refused before anything connects, as `worker` and `explain` do) before the store
 * opens; with `asksPassword`, the account's password is asked and checked here.
 */
async function openStore(input: ReviewInput, asksPassword: boolean) {
  const { context, config, sources } = input;
  const { options, deps } = context;
  const url = deps.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new CliError(
      "database-url",
      "DATABASE_URL is not set, so FacetDB has no store to take cards from",
      "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
    );
  }
  const allowInsecure = options.allowInsecure === true;
  requireUsableStoreUrl(url, allowInsecure, deps.env["PGHOST"]);
  const project = projectRef(deps.projectDir);
  const tables = new Map<string, TableRead>();
  for (const source of sources) {
    if (source.table !== undefined) {
      tables.set(source.name, await tableRead(deps, config, source, allowInsecure));
    }
  }
  const store = await deps.store({
    allowInsecure,
    warn: (message) => deps.io.stderr(`warning: ${message}\n`),
  });
  try {
    // Before a password is asked, a lock taken or anything written: the rules the cards are judged by.
    const inForce = await versionsInForce(store, input, project.id, context.print);
    const reviewer = await reviewerOf(context, store.users, asksPassword);
    const views: ReviewSource[] = [];
    for (const { source, questionSet, version } of inForce) {
      const table = tables.get(source.name);
      views.push({
        id: storeSourceId(project.id, source.name),
        name: source.name,
        version,
        questionSet,
        keyText:
          table === undefined
            ? undefined
            : await tableKeyText(table.engine, table.target, table.url, allowInsecure),
      });
    }
    return { store, project, reviewer, sources: views, tables };
  } catch (error) {
    await store.close();
    throw error;
  }
}

export const reviewCommand = createReviewCommand(projectDoor);
