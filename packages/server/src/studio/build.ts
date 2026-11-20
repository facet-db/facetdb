import { z } from "zod";

/**
 * The studio's build as the HTTP surface serves it: apps/studio's `vite build` output, a directory
 * holding `index.html`, the hashed files under `assets/`, and `routes.json`, the app's own routes,
 * so the server answers `index.html` for those paths and for nothing else. The surface never reads
 * the disk itself: it reads through `StudioFiles`, which the composition root opens on the
 * directory (the CLI's `diskStudioFiles`) and a test fakes with a map.
 */
export type StudioFiles = {
  /**
   * The bytes of the regular file at `names` under the build directory, one file or directory name
   * per element, or undefined when there is none there: missing, a directory, a link that leads out
   * of the build directory, anything but a regular file. The caller passes plain names only (no
   * `..`, no separator, no dotfile); the door checks again where the file really is.
   */
  read(names: readonly string[]): Promise<Uint8Array<ArrayBuffer> | undefined>;
};

/** The file a build lists its routes in, beside index.html (apps/studio/vite.config.ts writes it). */
export const STUDIO_ROUTES_FILE = "routes.json";

/** The page every route of the app answers with. */
export const STUDIO_INDEX_FILE = "index.html";

/**
 * A route as the app's router writes it: `/`, `/review`, `/decisions/$source/$key`. A segment is
 * lowercase letters, digits and hyphens, or a `$name` that stands for any one non-empty segment.
 */
const routePattern = /^\/(?:(?:[a-z0-9-]+|\$[A-Za-z]+)(?:\/(?:[a-z0-9-]+|\$[A-Za-z]+))*)?$/;

const routesFile = z.object({
  routes: z
    .array(
      z
        .string()
        .regex(routePattern, "a route is /, or /segment with segments of a-z, 0-9 and -, or $name"),
    )
    .min(1),
});

/** A build that can be served: its files, and the app's routes split into their segments. */
export type StudioBuild = {
  readonly files: StudioFiles;
  /** Each route's segments: `[]` for `/`, `["decisions", "$source", "$key"]`. */
  readonly routes: readonly (readonly string[])[];
};

/**
 * The build in a directory, or undefined when it holds none: no index.html, or no routes.json the
 * app's build would have written (a file is read at a boundary, so it is checked like one).
 */
export async function openStudioBuild(files: StudioFiles): Promise<StudioBuild | undefined> {
  const [index, routes] = await Promise.all([
    files.read([STUDIO_INDEX_FILE]),
    files.read([STUDIO_ROUTES_FILE]),
  ]);
  if (index === undefined || routes === undefined) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(routes));
  } catch {
    return undefined;
  }
  const parsed = routesFile.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  return {
    files,
    routes: parsed.data.routes.map((route) => route.split("/").filter((segment) => segment !== "")),
  };
}
