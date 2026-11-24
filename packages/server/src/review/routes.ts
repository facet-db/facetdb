import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson } from "../request.ts";
import type { CardTarget, ReviewEndpointService } from "./service.ts";

/** The most cards one page of the queue lists, and how many it lists when `limit` is left out. */
export const QUEUE_MAX_LIMIT = 200;
export const QUEUE_DEFAULT_LIMIT = 50;

/** The probability band: a number strictly between 0 and 1 (the queue's filter, passed through). */
const below = z.number().gt(0).lt(1);

const queueQuery = z.strictObject({
  source: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  below: z.coerce.number().gt(0).lt(1).optional(),
  limit: z.coerce.number().int().min(1).max(QUEUE_MAX_LIMIT).default(QUEUE_DEFAULT_LIMIT),
});

const QUEUE_SHAPE = `source (a source name), question (a question name), below (a number above 0 and under 1, such as 0.6) and limit (1 to ${QUEUE_MAX_LIMIT}, ${QUEUE_DEFAULT_LIMIT} by default)`;

const openBody = z
  .strictObject({
    source: z.string().min(1).optional(),
    question: z.string().min(1).optional(),
    below: below.optional(),
    key: z.string().min(1).optional(),
  })
  .refine((body) => body.key === undefined || body.source !== undefined, {
    path: ["source"],
    message: "a named card needs its source",
  })
  .refine(
    (body) => body.key === undefined || (body.question === undefined && body.below === undefined),
    {
      path: ["key"],
      message: "a named card is opened as it is; question and below narrow the queue",
    },
  );

const OPEN_SHAPE =
  '{} for the next card, optionally with "source", "question" and "below" (a number above 0 and under 1), or {"source": "<source name>", "key": "<record key>"} for one card';

/** The card a body refers to: its source and the state hash it was opened at. */
const cardBody = {
  source: z.string().min(1),
  stateHash: z.string().min(1),
};

const letGoBody = z.strictObject(cardBody);
const LET_GO_SHAPE =
  '{"source": "<source name>", "stateHash": "<stateHash of the card>"}, both as the card said them';

const decideBody = z.strictObject({
  ...cardBody,
  question: z.string().min(1),
  value: z.union([z.boolean(), z.string().min(1)]),
  note: z
    .string()
    .trim()
    .max(2000)
    .transform((note) => (note === "" ? undefined : note))
    .optional(),
});
const DECIDE_SHAPE =
  '{"source", "stateHash", "question", "value", "note"} with source and stateHash as the card said them, value true or false for a yes-or-no question and an option or level name otherwise, and note optional';

/** The decision an undo takes back, as the card and the decision said it: the key rides in the body. */
const undoBody = z.strictObject({
  ...cardBody,
  key: z.string().min(1),
  question: z.string().min(1),
});
const UNDO_SHAPE =
  '{"source", "key", "stateHash", "question"}: the card and the question of your last decision, as the card said them';

async function parsed<Schema extends z.ZodType>(
  schema: Schema,
  request: { json(): Promise<unknown> },
  fix: string,
): Promise<z.output<Schema>> {
  const body = schema.safeParse(await readJson(request));
  if (!body.success) {
    throw new ApiError(400, "invalid_request", bodyProblems(body.error), `Send ${fix}.`);
  }
  return body.data;
}

const listOf = (names: readonly string[]) => (names.length === 0 ? "none" : names.join(", "));

function unknownSource(source: string, known: readonly string[]): ApiError {
  return new ApiError(
    404,
    "unknown_source",
    `This project has no source called "${source}".`,
    `Use one of: ${listOf(known)}.`,
  );
}

function unknownQuestion(
  source: string | undefined,
  question: string,
  known: readonly string[],
): ApiError {
  return new ApiError(
    404,
    "unknown_question",
    source === undefined
      ? `No source of this project has a question called "${question}".`
      : `The source "${source}" has no question called "${question}".`,
    `Use one of: ${listOf(known)}.`,
  );
}

const held = (by: string, until: string) =>
  new ApiError(
    409,
    "card_held",
    `${by} is reviewing this card until ${until}.`,
    "Open the next card with POST /v1/review/open; the card is yours again once their hold ends, 10 minutes after their last renewal.",
  );

const lost = () =>
  new ApiError(
    409,
    "lock_lost",
    "You no longer hold this card: it was released, skipped, replaced by a newer card, or its hold ended.",
    "Open a card again with POST /v1/review/open; renew every 60 seconds while a card stays open.",
  );

const gone = () =>
  new ApiError(
    404,
    "card_gone",
    "No card of this record waits in the review queue; it was decided, or it changed and will be asked again.",
    "Open the next card with POST /v1/review/open, or look at GET /v1/review/queue.",
  );

const stale = (reason: string) =>
  new ApiError(
    409,
    "card_stale",
    `Nothing was decided: ${reason}.`,
    "Open the next card with POST /v1/review/open; a record that changed comes back when the model has answered it again.",
  );

/** A card to act on, from its path and body. The key is the record's, URL-encoded in the path. */
function targetOf(key: string, body: { source: string; stateHash: string }): CardTarget {
  return { source: body.source, key, stateHash: body.stateHash };
}

/**
 * The review endpoints: parse, one service call, map the result. The reviewer was checked by the
 * middleware, and its name from the session goes to the service as the viewer, so locks, skips, the
 * undo memory and the log entry's reviewer are that name's, never anything the request says. Only a
 * card the reviewer holds carries a record's state; the queue lists what waits without it.
 */
export function reviewRoutes(service: ReviewEndpointService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/review/queue", async (c) => {
    const query = queueQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiError(
        400,
        "invalid_request",
        `The query is not valid: ${query.error.issues
          .map(
            (issue) =>
              `${issue.path.length === 0 ? "query" : issue.path.join(".")}: ${issue.message}`,
          )
          .join("; ")}.`,
        `Pass ${QUEUE_SHAPE}.`,
      );
    }
    const { limit, ...filter } = query.data;
    const outcome = await service.queue(c.get("reviewer"), filter, limit);
    switch (outcome.kind) {
      case "queue": {
        const { kind: _kind, ...queue } = outcome;
        return c.json(queue);
      }
      case "unknown_source":
        throw unknownSource(outcome.source, outcome.known);
      case "unknown_question":
        throw unknownQuestion(outcome.source, outcome.question, outcome.known);
    }
  });

  route.post("/review/open", async (c) => {
    const body = await parsed(openBody, c.req, OPEN_SHAPE);
    const { key, ...filter } = body;
    const outcome = await service.open(c.get("reviewer"), filter, key);
    switch (outcome.kind) {
      case "opened":
        return c.json({ card: outcome.card });
      case "empty":
        // Nothing left under the filter is an answer, not a failure.
        return c.json({ card: null });
      case "held":
        throw held(outcome.by, outcome.until);
      case "gone":
        throw gone();
      case "unknown_source":
        throw unknownSource(outcome.source, outcome.known);
      case "unknown_question":
        throw unknownQuestion(outcome.source, outcome.question, outcome.known);
    }
  });

  // The undo names the decision it takes back: every tab of a reviewer, and the OS user, share one
  // name, so only the page or terminal that made the decision can name it.
  route.post("/review/undo", async (c) => {
    const body = await parsed(undoBody, c.req, UNDO_SHAPE);
    const outcome = await service.undo(
      c.get("reviewer"),
      { source: body.source, key: body.key, stateHash: body.stateHash },
      body.question,
    );
    switch (outcome.kind) {
      case "undone": {
        const { kind: _kind, ...undone } = outcome;
        return c.json(undone);
      }
      case "held":
        throw held(outcome.by, outcome.until);
      case "nothing":
        throw new ApiError(
          409,
          "nothing_to_undo",
          "You have no decision of this session left to undo.",
          "Only your last decision can be taken back, once; decide a card first.",
        );
      case "stale":
        throw new ApiError(
          409,
          "cannot_undo",
          `Nothing was undone: ${outcome.reason}.`,
          "Open the next card with POST /v1/review/open; to change a decision after that, decide the record again from its card.",
        );
      case "unknown_source":
        throw unknownSource(outcome.source, outcome.known);
    }
  });

  route.post("/review/:key/renew", async (c) => {
    const body = await parsed(letGoBody, c.req, LET_GO_SHAPE);
    const outcome = await service.renew(c.get("reviewer"), targetOf(c.req.param("key"), body));
    switch (outcome.kind) {
      case "renewed":
        return c.json({ lockedUntil: outcome.lockedUntil });
      case "held":
        throw held(outcome.by, outcome.until);
      case "lost":
        throw lost();
      case "gone":
        throw gone();
      case "unknown_source":
        throw unknownSource(outcome.source, outcome.known);
    }
  });

  route.post("/review/:key/decide", async (c) => {
    const body = await parsed(decideBody, c.req, DECIDE_SHAPE);
    const { question, value, note } = body;
    const outcome = await service.decide(c.get("reviewer"), targetOf(c.req.param("key"), body), {
      question,
      value,
      ...(note === undefined ? {} : { note }),
    });
    switch (outcome.kind) {
      case "decided": {
        const { kind: _kind, ...decided } = outcome;
        return c.json(decided);
      }
      case "held":
        throw held(outcome.by, outcome.until);
      case "lost":
        throw lost();
      case "stale":
        throw stale(outcome.reason);
      case "refused":
        throw new ApiError(
          422,
          "decision_refused",
          `The decision was not taken: ${outcome.reason}.`,
          "Decide one of the card's open questions with a value it takes: true or false for a yes-or-no question, an option or level name otherwise.",
        );
      case "unknown_source":
        throw unknownSource(outcome.source, outcome.known);
      case "unknown_question":
        throw unknownQuestion(outcome.source, outcome.question, outcome.known);
    }
  });

  route.post("/review/:key/skip", async (c) => {
    const body = await parsed(letGoBody, c.req, LET_GO_SHAPE);
    const outcome = await service.skip(c.get("reviewer"), targetOf(c.req.param("key"), body));
    if (outcome.kind === "unknown_source") {
      throw unknownSource(outcome.source, outcome.known);
    }
    return c.json({ skipped: true });
  });

  route.post("/review/:key/release", async (c) => {
    const body = await parsed(letGoBody, c.req, LET_GO_SHAPE);
    const outcome = await service.release(c.get("reviewer"), targetOf(c.req.param("key"), body));
    if (outcome.kind === "unknown_source") {
      throw unknownSource(outcome.source, outcome.known);
    }
    return c.json({ released: true });
  });

  return route;
}
