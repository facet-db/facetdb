import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import type { PluginsDoor } from "./door.ts";

/**
 * The studio's plugin endpoints: `GET /v1/plugins`, `GET /v1/plugins/gallery?q=` and `GET
 * /v1/packs`. Parse, one door call, map; the reviewer was checked by app.ts's middleware. Nothing
 * is installed from a page: the gallery shows the command, and a variable is shown by its name,
 * never its value.
 */

/** A search is a few words; the registry is searched, never a database. */
const MAX_SEARCH = 100;

const galleryQuery = z.strictObject({ q: z.string().trim().max(MAX_SEARCH).optional() });

export function pluginsRoutes(door: PluginsDoor): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // The plugins the config names: their settings as a schema, the values, each variable's state.
  route.get("/plugins", (c) => c.json({ plugins: door.installed() }));

  // The registry's entries, searched. A registry that cannot be read is an answer, not an error:
  // the page says so beside the installed plugins, which do not need it.
  route.get("/plugins/gallery", async (c) => {
    const query = galleryQuery.safeParse(c.req.query());
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
        `Ask GET /v1/plugins/gallery, with ?q=<up to ${MAX_SEARCH} characters> to search.`,
      );
    }
    const search = query.data.q === "" ? undefined : query.data.q;
    return c.json(await door.gallery(search));
  });

  // The question packs of the plugins the config names, as a Questions draft takes them.
  route.get("/packs", (c) => c.json({ packs: door.packs() }));

  return route;
}
