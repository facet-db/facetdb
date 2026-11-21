import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson, requireOwnPage } from "../request.ts";
import type { BackfillJobStatus, BackfillJobsDoor } from "./backfill-door.ts";

/**
 * The studio's backfill endpoints: `POST /v1/sources/:name/backfill/estimate`, `/backfill/start`
 * and `/backfill/stop`, and `GET /v1/sources/:name/backfill`. Parse, one door call, map; the
 * reviewer was checked by the middleware, and the three POSTs, which spend model budget and write
 * answers into the customer's table, take only a page of the studio itself, as Apply does
 * (`requireOwnPage`). Nothing is asked until a start carries the token its estimate gave.
 */

/** A question's name as the config writes one; the body is a boundary. */
const questionName = z.string().min(1).max(200);

const estimateBody = z.strictObject({
  // Absent: the whole question set. Present: these questions alone, merged into the answers kept.
  questions: z.array(questionName).min(1).max(100).optional(),
});

const startBody = z.strictObject({ token: z.string().min(1).max(200) });

const stopBody = z.strictObject({});

const sourceName = z.string().min(1).max(200);

const SHAPES = {
  estimate:
    '{} for the whole question set, or {"questions": ["<question name>", …]} for questions just added',
  start: '{"token": "<the token the estimate answered with>"}',
  stop: "{}",
} as const;

/** `requireOwnPage`'s words: these routes ask the model and write into the source's table. */
const BACKFILL_PAGE = {
  what: "A backfill",
  does: "a backfill asks the model and writes answers into your database",
  from: "Start and stop backfills from the studio this worker serves, or from a program on a machine you trust.",
} as const;

async function parsed<Schema extends z.ZodType>(
  schema: Schema,
  request: { json(): Promise<unknown> },
  shape: string,
): Promise<z.output<Schema>> {
  const body = schema.safeParse(await readJson(request));
  if (!body.success) {
    throw new ApiError(400, "invalid_request", bodyProblems(body.error), `Send ${shape}.`);
  }
  return body.data;
}

function nameOf(param: string | undefined): string {
  const name = sourceName.safeParse(param);
  if (!name.success) {
    throw new ApiError(
      400,
      "invalid_request",
      "The source's name in the path is not valid.",
      "Name a source listed by GET /v1/sources.",
    );
  }
  return name.data;
}

const unavailable = () =>
  new ApiError(
    409,
    "backfill_unavailable",
    "This worker runs no backfill from the studio: facetdb worker --once answers what is queued and exits.",
    "Run facetdb worker, then backfill from the studio; or run facetdb backfill --source <name> on this machine.",
  );

const unknownSource = (name: string) =>
  new ApiError(
    404,
    "unknown_source",
    `This worker runs no source called "${name}", so it has nothing to backfill.`,
    "Backfill a source listed by GET /v1/sources; a source added to facetdb.config.ts runs once facetdb worker restarts.",
  );

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

/** What the job is doing, as the refusal of a second one says it. */
function busyWords(status: BackfillJobStatus): string {
  switch (status.state) {
    case "estimating":
      return "being estimated";
    case "waiting":
      return "estimated and waiting to be started";
    case "stopping":
      return "stopping after the page in hand";
    default:
      return "running";
  }
}

export function backfillRoutes(door: BackfillJobsDoor): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  const guard = (request: Parameters<typeof requireOwnPage>[0]) => {
    if (!door.available) {
      throw unavailable();
    }
    requireOwnPage(request, BACKFILL_PAGE);
  };

  // Where the source's job stands: its state, the estimate, the counts so far, and why it ended.
  route.get("/sources/:name/backfill", async (c) => {
    const name = nameOf(c.req.param("name"));
    if (!door.available) {
      throw unavailable();
    }
    const outcome = await door.status(name);
    if (outcome.kind === "unknown_source") {
      throw unknownSource(name);
    }
    return c.json(outcome.status);
  });

  // The cost first: the job reads the source to count and price it, then waits. 202: the count runs
  // on, and GET .../backfill shows it, then the estimate and the token a start takes.
  route.post("/sources/:name/backfill/estimate", async (c) => {
    const name = nameOf(c.req.param("name"));
    guard(c.req);
    const body = await parsed(estimateBody, c.req, SHAPES.estimate);
    const outcome = await door.estimate(name, body.questions);
    switch (outcome.kind) {
      case "estimating":
        return c.json(outcome.status, 202);
      case "unknown_source":
        throw unknownSource(name);
      case "not_a_table":
        throw new ApiError(
          409,
          "not_a_table",
          `"${name}" reads no table: an API source's records arrive one by one through the check API, so there is nothing to backfill.`,
          "Backfill a source that reads a table.",
        );
      case "busy":
        throw new ApiError(
          409,
          "backfill_busy",
          `A backfill of "${name}" is ${busyWords(outcome.status)}; a source runs one backfill at a time.`,
          `Wait for it to end, or stop it (POST /v1/sources/${name}/backfill/stop), then estimate again.`,
        );
      case "not_installed":
        throw new ApiError(
          409,
          "question_not_installed",
          `"${name}" does not run ${quoted(outcome.questions)} yet, so a backfill cannot ask ${outcome.questions.length === 1 ? "it" : "them"}.`,
          `Install ${outcome.questions.length === 1 ? "the question" : "the questions"} first: apply ${outcome.questions.length === 1 ? "it" : "them"} from the studio (and run facetdb migrate --source ${name} when it says to), so the worker runs ${outcome.questions.length === 1 ? "it" : "them"}; then estimate again.`,
        );
    }
  });

  // The start carries the estimate's token: nothing is asked or queued on an estimate nobody saw.
  route.post("/sources/:name/backfill/start", async (c) => {
    const name = nameOf(c.req.param("name"));
    guard(c.req);
    const body = await parsed(startBody, c.req, SHAPES.start);
    const outcome = await door.start(name, body.token);
    const again = `Ask for a new estimate (POST /v1/sources/${name}/backfill/estimate), look at the cost, then start it with the token it gives.`;
    switch (outcome.kind) {
      case "started":
        return c.json(outcome.status);
      case "unknown_source":
        throw unknownSource(name);
      case "no_estimate":
        throw new ApiError(
          409,
          "no_estimate",
          `No estimate of a backfill of "${name}" is waiting to be started, so nothing was started.`,
          again,
        );
      case "wrong_token":
        throw new ApiError(
          409,
          "estimate_changed",
          `The token is not the one of the estimate waiting for "${name}", so nothing was started.`,
          `Start with the token of the estimate shown (GET /v1/sources/${name}/backfill gives it), or ask for a new estimate and start that one.`,
        );
      case "expired":
        throw new ApiError(
          409,
          "estimate_expired",
          `The estimate of "${name}" was not started in time, so it was dropped; nothing was asked.`,
          again,
        );
      case "restarted":
        throw new ApiError(
          409,
          "source_restarted",
          // The job's own words say which: restarted under the same version, a new one, or removed.
          outcome.status.why ??
            `A reload changed "${name}" since the estimate, so the estimate no longer prices what would run; nothing was asked.`,
          again,
        );
    }
  });

  route.post("/sources/:name/backfill/stop", async (c) => {
    const name = nameOf(c.req.param("name"));
    guard(c.req);
    await parsed(stopBody, c.req, SHAPES.stop);
    const outcome = await door.stop(name);
    switch (outcome.kind) {
      case "stopping":
        return c.json(outcome.status);
      case "unknown_source":
        throw unknownSource(name);
      case "nothing_to_stop":
        throw new ApiError(
          409,
          "nothing_to_stop",
          `No backfill of "${name}" is being estimated, waiting or running, so there is nothing to stop.`,
          `GET /v1/sources/${name}/backfill says where its last backfill stands.`,
        );
    }
  });

  return route;
}
