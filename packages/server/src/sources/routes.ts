import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { isOperator, type OperatorRefusal, operatorRefusal } from "../auth/operator.ts";
import { ApiError } from "../errors.ts";
import { readJson } from "../request.ts";
import {
  MIGRATE_NO_OPERATOR,
  MIGRATE_OPERATOR_ONLY,
  NO_OPERATOR,
  type SetupAccess,
  type SetupAnswer,
  type SetupService,
} from "./service.ts";

/**
 * The setup flow's endpoints: `GET /v1/sources/setup` says whether this browser may add a source
 * here; `POST /v1/sources/inspect`, `/preview`, `/plan` and `/install` do it, each with the admin
 * connection string in its body for that one call. Parse, one service call, map; the reviewer was
 * checked by the middleware, and the four POSTs are the operator's on this machine alone
 * (`requireOperator`).
 *
 * The admin string is read from the body and handed to the service, and nothing here repeats it: a
 * body that fails its schema is answered in fixed words naming its fields, never the zod issue's
 * text, which may quote what was sent.
 */

/** Long enough for any connection string with its parameters; the body is a boundary. */
const MAX_ADMIN_LENGTH = 4_096;

const admin = z.string().trim().min(1).max(MAX_ADMIN_LENGTH);
const draftSource = z.looseObject({ name: z.string().min(1).max(200) });

const inspectBody = z.strictObject({ admin, table: z.string().min(1).max(300).optional() });
const draftBody = z.strictObject({ admin, source: draftSource });
const installBody = z.strictObject({
  admin,
  source: draftSource,
  // The token `/plan` answered with: it names the script and the diff that were shown.
  token: z.string().min(1).max(200),
  // Replace a config file git keeps no copy of: only by the operator's choice.
  force: z.boolean().default(false),
});

/** A source's name in the path, as the config allows it. */
const sourceName = z.string().min(1).max(200);
const migratePlanBody = z.strictObject({ admin });
const migrateRunBody = z.strictObject({
  admin,
  // The token `/migrate/plan` answered with: it names the script that was shown.
  token: z.string().min(1).max(200),
});

const SHAPES = {
  migratePlan: '{"admin": "<the admin connection string>"}',
  migrateRun: '{"admin": "<the admin connection string>", "token": "<the plan\'s token>"}',
  inspect:
    '{"admin": "<the admin connection string>", "table": "<a table it listed>"} (table optional)',
  draft:
    '{"admin": "<the admin connection string>", "source": {"name", "table", "database": {"env"}, "read", "questions", "thresholds"}}',
  install:
    '{"admin": "<the admin connection string>", "source": <the draft that was planned>, "token": "<the plan\'s token>", "force": false}',
} as const;

/**
 * A body read against its schema. A failure names the fields at fault and nothing they held: a
 * zod message may quote the value, and the value may be the admin connection string.
 */
async function parsed<Schema extends z.ZodType>(
  schema: Schema,
  request: { json(): Promise<unknown> },
  shape: string,
): Promise<z.output<Schema>> {
  const body = schema.safeParse(await readJson(request));
  if (!body.success) {
    const fields = [
      ...new Set(
        body.error.issues.map((issue) =>
          issue.path.length === 0 ? "the body" : issue.path.map(String).join("."),
        ),
      ),
    ];
    throw new ApiError(
      400,
      "invalid_request",
      `The request body is not valid: check ${fields.join(", ")}.`,
      `Send ${shape}.`,
    );
  }
  return body.data;
}

/**
 * The words of a refusal: to a request that is not the operator (undefined: the service's own), and
 * to every request where no address makes the operator.
 */
type Refusals = {
  readonly notOperator: OperatorRefusal | undefined;
  readonly noOperator: OperatorRefusal;
};

const SETUP_REFUSALS: Refusals = { notOperator: undefined, noOperator: NO_OPERATOR };
const MIGRATE_REFUSALS: Refusals = {
  notOperator: MIGRATE_OPERATOR_ONLY,
  noOperator: MIGRATE_NO_OPERATOR,
};

/**
 * Whether the setup is open to this request, in the words for it: a studio whose `studioUrl`
 * names another host has no operator, and says so with the commands to run instead.
 */
function setupAccess(c: Context<AppEnv>, service: SetupService, refusals: Refusals): SetupAccess {
  const access = service.access(isOperator(c));
  if (access.open || access.code !== "operator_only") {
    return access;
  }
  const words = operatorRefusal(c, {
    notOperator: refusals.notOperator ?? access,
    noOperator: refusals.noOperator,
  });
  return { open: false, code: access.code, message: words.message, fix: words.fix };
}

/**
 * The setup's writing routes take the operator alone: a request from another machine, through a
 * proxy, under a foreign Host or Origin, or signed in with an account, is refused before its body
 * is read, and so is every request where no address makes the operator (a `studioUrl` on another
 * host). That only a page of the studio itself can send one is app.ts's `requireOwnPage`, ahead of
 * this. An added question's install is guarded the same way, in its own words.
 */
function requireOperator(service: SetupService, refusals: Refusals) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const access = setupAccess(c, service, refusals);
    if (!access.open && access.code === "operator_only") {
      throw new ApiError(403, access.code, access.message, access.fix);
    }
    await next();
  });
}

/** The source's name from the path, read against its schema; a bad one is named, never quoted. */
function pathName(raw: string): string {
  const name = sourceName.safeParse(raw);
  if (!name.success) {
    throw new ApiError(
      400,
      "invalid_request",
      "The source's name in the path is not valid.",
      "Send POST /v1/sources/<a source of facetdb.config.ts>/migrate/plan.",
    );
  }
  return name.data;
}

function answered(answer: SetupAnswer<unknown>) {
  if (answer.ok) {
    return answer.body;
  }
  const { status, code, message, fix, headers } = answer.failure;
  throw new ApiError(status, code, message, fix, headers);
}

export function setupRoutes(service: SetupService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // Readable by any reviewer: the page says before step one whether it can be done here.
  route.get("/sources/setup", (c) => c.json(setupAccess(c, service, SETUP_REFUSALS)));

  route.use("/sources/inspect", requireOperator(service, SETUP_REFUSALS));
  route.use("/sources/preview", requireOperator(service, SETUP_REFUSALS));
  route.use("/sources/plan", requireOperator(service, SETUP_REFUSALS));
  route.use("/sources/install", requireOperator(service, SETUP_REFUSALS));

  route.post("/sources/inspect", async (c) => {
    const body = await parsed(inspectBody, c.req, SHAPES.inspect);
    return c.json(answered(await service.inspect(body.admin, body.table)));
  });

  route.post("/sources/preview", async (c) => {
    const body = await parsed(draftBody, c.req, SHAPES.draft);
    return c.json(answered(await service.preview(body.admin, body.source)));
  });

  route.post("/sources/plan", async (c) => {
    const body = await parsed(draftBody, c.req, SHAPES.draft);
    return c.json(answered(await service.plan(body.admin, body.source)));
  });

  route.post("/sources/install", async (c) => {
    const body = await parsed(installBody, c.req, SHAPES.install);
    return c.json(
      answered(
        await service.install(body.admin, body.source, { token: body.token, force: body.force }),
      ),
    );
  });

  // An added question's install, shown then run, for a source the file has; the operator's alone,
  // as the setup's.
  route.use("/sources/:name/migrate/*", requireOperator(service, MIGRATE_REFUSALS));

  route.post("/sources/:name/migrate/plan", async (c) => {
    const name = pathName(c.req.param("name"));
    const body = await parsed(migratePlanBody, c.req, SHAPES.migratePlan);
    return c.json(answered(await service.migratePlan(body.admin, name)));
  });

  route.post("/sources/:name/migrate/run", async (c) => {
    const name = pathName(c.req.param("name"));
    const body = await parsed(migrateRunBody, c.req, SHAPES.migrateRun);
    return c.json(answered(await service.migrateRun(body.admin, name, { token: body.token })));
  });

  return route;
}
