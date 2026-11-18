import { PREVIEW_DEFAULT_LIMIT, TEST_DEFAULT_SAMPLE, TEST_MAX_SAMPLE } from "@facetdb/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson } from "../request.ts";
import type { ConfigService, DraftIssue } from "./service.ts";

/** The most rows one preview answers, as `facetdb preview --limit` allows. */
export const PREVIEW_MAX_LIMIT = 100;

/**
 * A draft source as the project JSON writes one: its name, and any fields to change. Only the shape
 * is checked here; every rule of a source is the loader's, behind the service.
 */
const draftSource = z.looseObject({ name: z.string().min(1) });

const validateBody = z.strictObject({ source: draftSource });

const previewBody = z.strictObject({
  source: draftSource,
  limit: z.number().int().min(1).max(PREVIEW_MAX_LIMIT).default(PREVIEW_DEFAULT_LIMIT),
});

const testBody = z.strictObject({
  source: draftSource,
  sample: z.number().int().min(1).max(TEST_MAX_SAMPLE).default(TEST_DEFAULT_SAMPLE),
  // The cost first: true reads the records and answers with the estimate alone.
  estimate: z.boolean().default(false),
});

const DRAFT_SHAPE =
  '{"source": {"name": "<source name>", "questions": {…}, "thresholds": {…}}} in the project JSON\'s shape (GET /v1/config)';

async function parsed<Schema extends z.ZodType>(
  schema: Schema,
  request: { json(): Promise<unknown> },
  fix: string,
): Promise<z.output<Schema>> {
  const body = schema.safeParse(await readJson(request));
  if (!body.success) {
    throw new ApiError(400, "invalid_request", bodyProblems(body.error), fix);
  }
  return body.data;
}

const unknownProject = () =>
  new ApiError(
    404,
    "unknown_project",
    "This API key belongs to a project this worker does not serve.",
    "Use a key made by `facetdb keys add` in this project's directory.",
  );

function issuesInWords(issues: readonly DraftIssue[]): string {
  return issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ");
}

/**
 * `GET /v1/config`, `POST /v1/config/validate`, `POST /v1/preview` and `POST /v1/test`: parse, one
 * service call, map the result; the API key was checked by the middleware. Nothing here reads a
 * file, a database or the model.
 */
export function configRoutes(service: ConfigService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/config", (c) => {
    const outcome = service.json(c.get("projectId"));
    if (outcome.kind === "unknown_project") {
      throw unknownProject();
    }
    return c.json(outcome.value as object);
  });

  // A draft that breaks a rule is still a 200: the issues are the answer the editor shows.
  route.post("/config/validate", async (c) => {
    const body = await parsed(validateBody, c.req, `Send ${DRAFT_SHAPE}.`);
    const outcome = service.validate(c.get("projectId"), body.source);
    if (outcome.kind === "unknown_project") {
      throw unknownProject();
    }
    return c.json(outcome.value);
  });

  route.post("/preview", async (c) => {
    const body = await parsed(
      previewBody,
      c.req,
      `Send ${DRAFT_SHAPE}, and "limit" (1 to ${PREVIEW_MAX_LIMIT} rows) if not ${PREVIEW_DEFAULT_LIMIT}.`,
    );
    const outcome = await service.preview(c.get("projectId"), body.source, body.limit);
    switch (outcome.kind) {
      case "previewed": {
        const { kind: _kind, ...result } = outcome;
        return c.json(result);
      }
      case "unknown_project":
        throw unknownProject();
      case "invalid":
        throw new ApiError(
          400,
          "invalid_draft",
          `The draft has problems: ${issuesInWords(outcome.issues)}.`,
          "Fix each field named (POST /v1/config/validate lists them by path), then preview again.",
        );
      case "unknown_source":
        throw new ApiError(
          404,
          "unknown_source",
          `This worker runs no source called "${outcome.source}", so there are no rows to preview.`,
          "Preview a source listed by GET /v1/config, or add the source to facetdb.config.ts and restart facetdb worker.",
        );
      case "fields_differ":
        throw new ApiError(
          400,
          "fields_differ",
          `The draft reads other fields of "${outcome.source}" (read or where) than the worker reads, so its rows cannot be shown as the model would see them.`,
          "Preview with the source's current read and where; to try other fields, edit facetdb.config.ts and run facetdb preview.",
        );
      case "capped":
        // The cap holds until the month resets: that is when another preview can be asked.
        throw new ApiError(429, "spending_cap_reached", outcome.message, outcome.fix, {
          "retry-after": String(outcome.retryAfterSeconds),
        });
      case "model_failed":
        throw new ApiError(
          503,
          "model_unavailable",
          `The model did not answer for row ${outcome.key}: ${outcome.reason}. Nothing was written.`,
          "Preview again in a minute; if it keeps failing, run facetdb doctor to check the model key and the connection.",
        );
    }
  });

  // The draft against the version in force: the newest records and every record a person decided.
  // `"estimate": true` is the cost first: it reads the records and answers with the estimate, the
  // model not called.
  route.post("/test", async (c) => {
    const body = await parsed(
      testBody,
      c.req,
      `Send ${DRAFT_SHAPE}, "sample" (1 to ${TEST_MAX_SAMPLE} records) if not ${TEST_DEFAULT_SAMPLE}, and "estimate": true to price the test without running it.`,
    );
    const outcome = await service.test(c.get("projectId"), body.source, {
      sample: body.sample,
      estimateOnly: body.estimate,
    });
    switch (outcome.kind) {
      case "estimated":
        return c.json({ estimate: outcome.estimate, warnings: outcome.warnings });
      case "tested": {
        const { kind: _kind, ...result } = outcome.result;
        return c.json({ ...result, warnings: outcome.warnings });
      }
      case "unknown_project":
        throw unknownProject();
      case "invalid":
        throw new ApiError(
          400,
          "invalid_draft",
          `The draft has problems: ${issuesInWords(outcome.issues)}.`,
          "Fix each field named (POST /v1/config/validate lists them by path), then test again.",
        );
      case "unknown_source":
        throw new ApiError(
          404,
          "unknown_source",
          `This worker runs no source called "${outcome.source}", so there are no records to test.`,
          "Test a source listed by GET /v1/config, or add the source to facetdb.config.ts and restart facetdb worker.",
        );
      case "fields_differ":
        throw new ApiError(
          400,
          "fields_differ",
          `The draft reads state fields of "${outcome.source}" that the worker does not read, or filters with another where, so its records cannot be shown to the model as it would see them.`,
          "Test with fields the source already reads and its current where; to try others, edit facetdb.config.ts and run facetdb test.",
        );
      case "capped":
        throw new ApiError(429, "spending_cap_reached", outcome.message, outcome.fix, {
          "retry-after": String(outcome.retryAfterSeconds),
        });
      case "model_failed":
        throw new ApiError(
          503,
          "model_unavailable",
          `The model did not answer for record ${outcome.key}: ${outcome.reason}. Nothing was written, and the test has no result.`,
          "Test again in a minute; if it keeps failing, run facetdb doctor to check the model key and the connection.",
        );
    }
  });

  return route;
}
