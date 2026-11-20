import { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { STUDIO_INDEX_FILE, type StudioBuild } from "./build.ts";

/**
 * The studio's own surface: `GET /v1/project` for the rail, behind the reviewer like every studio
 * route, and the built app's files, public (the sign-in page must load before anyone has signed in)
 * and holding nothing but the build: no secret, no project data, which arrives through `/v1` alone.
 */

/** `GET /v1/project`: the one project this worker serves, and who is asking (the rail's listbox). */
export function projectRoutes(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/project", (c) =>
    c.json({ project: c.get("projectId"), reviewer: c.get("reviewer") }),
  );
  return route;
}

/**
 * The types of what a build holds, by extension; a file of any other type is not served. Text is
 * UTF-8, which Vite writes.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  woff: "font/woff",
};

/** Vite's hashed output: a new build gives a changed file a new name, so it may be kept a year. */
const HASHED_DIRECTORY = "assets";
const HASHED_CACHE = "public, max-age=31536000, immutable";
/** index.html and the unhashed files: asked again each time, so a new build shows on reload. */
const FRESH_CACHE = "no-cache";

/**
 * The page's policy: its own scripts, styles, fonts and API only; `unsafe-inline` for styles alone,
 * since React and Radix set style attributes (the dither's size, a popover's position). No frame may
 * hold the studio, so no other page can lay its buttons under a visitor's click.
 */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every other file's policy: a script or a stylesheet the page loads ignores it (a policy binds
 * the document it arrives with), but a file opened on its own, an SVG above all, runs nothing,
 * loads nothing and gets an opaque origin.
 */
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** A file or directory name a build may hold: no dotfile, no `..`, no separator, no `%`. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

/** The path's names, decoded, or undefined when one of them is not a plain name. */
function plainNames(segments: readonly string[]): readonly string[] | undefined {
  const names: string[] = [];
  for (const segment of segments) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!PLAIN_NAME.test(name)) {
      return undefined;
    }
    names.push(name);
  }
  return names.length === 0 ? undefined : names;
}

function isAppRoute(routes: StudioBuild["routes"], segments: readonly string[]): boolean {
  return routes.some(
    (route) =>
      route.length === segments.length &&
      route.every((part, i) => {
        const segment = segments[i] ?? "";
        return part.startsWith("$") ? segment !== "" : part === segment;
      }),
  );
}

function contentTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : CONTENT_TYPES[name.slice(dot + 1).toLowerCase()];
}

function served(bytes: Uint8Array<ArrayBuffer>, type: string, cache: string): Response {
  const headers = new Headers({
    "content-type": type,
    "content-length": String(bytes.byteLength),
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  });
  if (type.startsWith("text/html")) {
    headers.set("content-security-policy", PAGE_POLICY);
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "no-referrer");
  } else {
    headers.set("content-security-policy", FILE_POLICY);
  }
  return new Response(bytes, { headers });
}

/**
 * The built app, mounted after every `/v1` route: GET (and HEAD, which Hono answers as a GET without
 * the body) only. A path the app routes (routes.json) answers index.html; any other path is a file of
 * the build by its plain names, or the API's 404. Nothing under `/v1` is ever answered here, so an
 * unknown endpoint stays the API's JSON error.
 */
export function studioAppRoutes(build: StudioBuild, apiPrefix: string): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("*", async (c) => {
    // WHATWG's parse has already resolved `.` and `..` segments, encoded ones included.
    const path = new URL(c.req.url).pathname;
    if (path === apiPrefix || path.startsWith(`${apiPrefix}/`)) {
      return c.notFound();
    }
    const segments = path.split("/").slice(1);
    // One trailing slash is the same page: `/review/` is `/review`.
    if (segments.length > 0 && segments.at(-1) === "") {
      segments.pop();
    }
    if (isAppRoute(build.routes, segments)) {
      const page = await build.files.read([STUDIO_INDEX_FILE]);
      return page === undefined
        ? c.notFound()
        : served(page, "text/html; charset=utf-8", FRESH_CACHE);
    }
    const names = plainNames(segments);
    const type = names === undefined ? undefined : contentTypeOf(names.at(-1) ?? "");
    if (names === undefined || type === undefined) {
      return c.notFound();
    }
    const bytes = await build.files.read(names);
    if (bytes === undefined) {
      return c.notFound();
    }
    return served(bytes, type, names[0] === HASHED_DIRECTORY ? HASHED_CACHE : FRESH_CACHE);
  });
  return route;
}
