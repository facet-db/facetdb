import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { fromThisMachine } from "../auth/loopback.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { SESSION_COOKIE } from "../auth/sessions.ts";
import { ApiError } from "../errors.ts";
import { readJson, requireOwnPage } from "../request.ts";
import { MIGRATE_OPERATOR_ONLY, type SetupAnswer, type SetupService } from "./service.ts";

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

/** `requireOwnPage`'s words for the setup's routes, which connect to a database and write a file. */
const SETUP_PAGE = {
  what: "Adding a source",
  does: "adding a source connects to a database and writes facetdb.config.ts on this machine",
  from: "Add the source from the studio this worker serves, on this machine.",
} as const;

/** `requireOwnPage`'s words for installing an added question. */
const MIGRATE_PAGE = {
  what: "Installing a question",
  does: "installing a question connects to a database with an admin connection string on this machine",
  from: "Install the question from the studio this worker serves, on this machine.",
} as const;

/** Whether the request is this machine's operator: loopback, and no session cookie. */
function isOperator(c: Context<AppEnv>): boolean {
  return fromThisMachine(c.req.raw, c.env) && getCookie(c, SESSION_COOKIE) === undefined;
}

/**
 * The setup's writing routes take the operator alone: a request from another machine, through a
 * proxy, under a foreign Host or Origin, or signed in with an account, is refused before its body
 * is read; and only a page of the studio itself can send one (`requireOwnPage`, as Apply). An added
 * question's install is guarded the same way, in its own words.
 */
function requireOperator(
  service: SetupService,
  page: Parameters<typeof requireOwnPage>[1] = SETUP_PAGE,
  refusal?: { readonly message: string; readonly fix: string },
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const access = service.access(isOperator(c));
    if (!access.open && access.code === "operator_only") {
      const words = refusal ?? access;
      throw new ApiError(403, access.code, words.message, words.fix);
    }
    requireOwnPage(c.req, page);
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
  route.get("/sources/setup", (c) => c.json(service.access(isOperator(c))));

  route.use("/sources/inspect", requireOperator(service));
  route.use("/sources/preview", requireOperator(service));
  route.use("/sources/plan", requireOperator(service));
  route.use("/sources/install", requireOperator(service));

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
  route.use(
    "/sources/:name/migrate/*",
    requireOperator(service, MIGRATE_PAGE, MIGRATE_OPERATOR_ONLY),
  );

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
