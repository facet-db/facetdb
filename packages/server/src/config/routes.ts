import { PREVIEW_DEFAULT_LIMIT, TEST_DEFAULT_SAMPLE, TEST_MAX_SAMPLE } from "@facetdb/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson } from "../request.ts";
import type { ConfigDraft, ConfigService, DraftIssue } from "./service.ts";

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

/**
 * The project's own settings a draft may change: Settings' spending section (the monthly cap in
 * billable input tokens, `null` removing it, and what happens at 100%), and the Alerts page's
 * `alerts` (`null` taking it out) and the Plugins page's `plugins`, a plugin's settings by its key.
 * Nothing else of the project is a draft's: `modelUrl` decides where every record's state is sent,
 * so it stays the operator's, edited by hand. Only the shape of `alerts` and `plugins` is checked
 * here: their rules (a channel's address and quiet hours, a plugin's schema, a secret's variable)
 * are the loader's and the worker's plugins', behind the door, which refuses a draft that would not
 * load before any diff.
 */
const draftProject = z.strictObject({
  spendingCap: z.number().int().positive().nullable().exactOptional(),
  onCapReached: z.enum(["pause", "continue"]).exactOptional(),
  alerts: z.looseObject({}).nullable().exactOptional(),
  plugins: z.record(z.string(), z.looseObject({})).exactOptional(),
});

const applyBody = z
  .strictObject({
    source: draftSource.exactOptional(),
    project: draftProject.exactOptional(),
    // Absent: the dry run, which answers with the diff and its plan. Present: the plan that diff
    // named, so what is written is what was shown.
    confirm: z.string().min(1).optional(),
    // Replace a file git keeps no copy of (uncommitted changes, untracked, no repository).
    force: z.boolean().default(false),
  })
  .transform(({ source, project, confirm, force }, context) => {
    // One draft per Apply: a source, or the project's own settings, so one diff shows one change.
    const draft: ConfigDraft | undefined =
      source !== undefined && project === undefined
        ? { source }
        : project !== undefined && source === undefined
          ? { project }
          : undefined;
    if (draft === undefined) {
      context.addIssue({
        code: "custom",
        message:
          source === undefined
            ? 'the body carries no draft: send "source" or "project"'
            : 'the body carries both "source" and "project": send one draft per apply',
      });
      return z.NEVER;
    }
    return { draft, confirm, force };
  });

const DRAFT_SHAPE =
  '{"source": {"name": "<source name>", "questions": {…}, "thresholds": {…}}} in the project JSON\'s shape (GET /v1/config)';

const PROJECT_DRAFT_SHAPE =
  '{"project": {…}} with any of "spendingCap" (billable input tokens a month, or null for no cap), "onCapReached" ("pause" or "continue"), "alerts" ({"channels": […]}, or null for none) and "plugins" ({"<plugin>": {…its settings}})';

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
    "This request belongs to a project this worker does not serve.",
    "Open the studio of the worker that serves this project.",
  );

function issuesInWords(issues: readonly DraftIssue[]): string {
  return issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ");
}

/**
 * `GET /v1/config`, `POST /v1/config/validate`, `POST /v1/preview`, `POST /v1/test` and `POST
 * /v1/apply`: parse, one service call, map the result; the reviewer was checked by the middleware.
 * Nothing here reads a file, a database or the model.
 */
export function configRoutes(service: ConfigService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // The project JSON as the loader exports it, and beside its sources (never inside one, so a
  // source sent back as a draft carries no key the loader does not know) each source's version
  // history by name: number, when it was made, what changed in words; and `pending`, the sources
  // whose loop does not run the file as last loaded, with the reload's words.
  route.get("/config", async (c) => {
    const outcome = await service.json(c.get("projectId"));
    if (outcome.kind === "unknown_project") {
      throw unknownProject();
    }
    return c.json({
      ...(outcome.value.project as object),
      versions: outcome.value.versions,
      pending: outcome.value.pending,
    });
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

  // Apply: without `confirm`, the diff the draft makes to facetdb.config.ts and the plan that names
  // it; with the plan as `confirm`, the write, and the worker's reload. Show before doing: nothing
  // is written that was not shown. The draft is one source (the Questions page) or the project's
  // own settings (Settings' cap, the Alerts page's channels, the Plugins page's settings); any
  // reviewer who may Apply may send either, and the reload puts a written cap, channels and
  // settings in force at once.
  route.post("/apply", async (c) => {
    const body = await parsed(
      applyBody,
      c.req,
      `Send ${DRAFT_SHAPE}, or ${PROJECT_DRAFT_SHAPE} for the project's own settings, for the diff; to write it, send the same draft with "confirm": "<the plan the diff answered with>", and "force": true to replace a file git keeps no copy of.`,
    );
    const projectId = c.get("projectId");
    const outcome =
      body.confirm === undefined
        ? await service.diff(projectId, body.draft)
        : await service.apply(projectId, body.draft, {
            plan: body.confirm,
            force: body.force,
            by: c.get("reviewer"),
          });
    switch (outcome.kind) {
      case "planned": {
        const { kind: _kind, ...result } = outcome;
        return c.json({ written: false, ...result });
      }
      case "applied": {
        const { kind: _kind, ...result } = outcome;
        return c.json({ written: true, ...result });
      }
      case "unchanged":
        return c.json({ written: false, path: outcome.path, changed: false });
      case "unknown_project":
        throw unknownProject();
      case "unavailable":
        throw new ApiError(
          409,
          "apply_unavailable",
          "This worker does not write facetdb.config.ts: facetdb worker --once never does.",
          "Run facetdb worker to apply from the studio, or edit facetdb.config.ts and restart the worker.",
        );
      case "invalid":
        throw new ApiError(
          400,
          "invalid_draft",
          `The draft has problems: ${issuesInWords(outcome.issues)}. Nothing was written.`,
          "Fix each field named (POST /v1/config/validate lists them by path), then apply again.",
        );
      case "unreadable":
        throw new ApiError(409, "config_unreadable", outcome.message, outcome.fix);
      case "reverted":
        throw new ApiError(409, "apply_reverted", outcome.message, outcome.fix);
      case "uncommitted":
        throw new ApiError(
          409,
          "uncommitted_changes",
          `${outcome.message}. Nothing was written.`,
          outcome.fix,
        );
      case "stale":
        throw new ApiError(
          409,
          "plan_changed",
          "facetdb.config.ts or the draft changed since the diff that was confirmed, so nothing was written.",
          "Ask for the diff again (POST /v1/apply without confirm), look at it, and confirm the plan it answers with.",
        );
    }
  });

  // Check again: the worker reads facetdb.config.ts and its databases again, as after Apply, and
  // answers the reload. Whoever may Apply may ask; no body is read (the studio sends `{}` as JSON,
  // which is what app.ts's `requireOwnPage` asks of a write).
  route.post("/reload", async (c) => {
    const outcome = await service.reload(c.get("projectId"));
    switch (outcome.kind) {
      case "reloaded":
        return c.json(outcome.reload);
      case "unknown_project":
        throw unknownProject();
      case "unavailable":
        throw new ApiError(
          409,
          "reload_unavailable",
          "This worker does not reload facetdb.config.ts: facetdb worker --once never does.",
          "Restart the worker to run the file as it is, or run facetdb worker to check again from the studio.",
        );
    }
  });

  return route;
}
