import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zod from "zod";
import {
  buildRegistryIndex,
  formatRegistryIndex,
  RegistryError,
  type RegistryIndex,
  readRegistryIndex,
} from "./registry.ts";
import { PAGE_FONT_LICENSES, PAGE_FONTS, renderRegistryPage } from "./registry-page.ts";

/**
 * `pnpm --filter facetdb run registry:build`: reads the entry files of the registry folder, asks
 * npm for each package's downloads and writes `index.json` beside them, then the page over it,
 * `index.html`, and the page's fonts in `fonts/`. `registry:build:offline` (`--offline`) takes the
 * counts from the committed `index.json` instead and asks the network nothing. The only side effects
 * are the folder and the `fetch` handed in; `main` at the bottom is this process's composition root.
 */

/** What the build needs of `fetch`: a GET by address. The global `fetch` fits; tests pass a fake. */
export type Fetch = (url: string) => Promise<Response>;

/** The period npm's figure covers: the last 30 days, steadier than a week for a small package. */
const DOWNLOADS_PERIOD = "last-month";

/** How long one request to npm may take, in the real `fetch` `main` wires; a stalled build fails instead of hanging. */
const REQUEST_TIMEOUT_MS = 15_000;

const downloadsResponse = zod.object({ downloads: zod.number().int().nonnegative() });

/**
 * `downloadsOf` over npm's downloads API (`/downloads/point/last-month/<package>`). A package npm
 * does not know (a 404) counts 0; any other failure is an error, never a 0, so an outage cannot
 * wipe the figures out of the index.
 */
export function npmDownloads(fetch: Fetch): (packageName: string) => Promise<number> {
  return async (packageName) => {
    const url = `https://api.npmjs.org/downloads/point/${DOWNLOADS_PERIOD}/${packageName}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(
        `Could not reach npm's downloads API for "${packageName}" (${error instanceof Error ? error.message : String(error)}); check the network and run the build again`,
      );
    }
    if (response.status === 404) {
      return 0;
    }
    if (!response.ok) {
      throw new Error(
        `npm's downloads API answered ${response.status} for "${packageName}"; run the build again later`,
      );
    }
    const notAFigure = new Error(
      `npm's downloads API answered "${packageName}" with something other than a download figure; run the build again later`,
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // Text that is not JSON (an error page answered with a 200) is not a figure; a body that
      // stopped arriving (the request's timeout) is a network failure, in the same words as above.
      if (error instanceof SyntaxError) {
        throw notAFigure;
      }
      throw new Error(
        `Could not reach npm's downloads API for "${packageName}" (${error instanceof Error ? error.message : String(error)}); check the network and run the build again`,
      );
    }
    const parsed = downloadsResponse.safeParse(body);
    if (!parsed.success) {
      throw notAFigure;
    }
    return parsed.data.downloads;
  };
}

export type WriteRegistryOptions = {
  /** The registry folder: `plugins/*.json` in; `index.json`, `index.html` and `fonts/` out. */
  readonly folder: string;
  /** The `packages/ui` folder: the page's tokens (`src/tokens/tokens.css`) and fonts (`fonts/`). */
  readonly ui: string;
  readonly fetch: Fetch;
  /**
   * True for the offline build: each package's count is the committed `index.json`'s, and `fetch`
   * is never called. A package the committed index does not list is listed at 0, and named.
   */
  readonly offline: boolean;
  readonly now: () => Date;
};

export type WriteRegistryResult = {
  readonly index: RegistryIndex;
  /** The files written, relative to the folder, in the order written; empty when every one already said the same. */
  readonly written: readonly string[];
  /** The offline build's packages with no committed count, listed at 0; always empty with npm's counts. */
  readonly uncounted: readonly string[];
};

/** The files the build writes besides `index.json`, relative to the registry folder. */
export const REGISTRY_PAGE_FILES = [
  "index.html",
  ...[...PAGE_FONTS, ...PAGE_FONT_LICENSES].map((file) => `fonts/${file}`),
] as const;

async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Writes the bytes unless the file already holds exactly them; says whether it wrote. */
async function writeIfChanged(path: string, bytes: Uint8Array | string): Promise<boolean> {
  const wanted = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  try {
    if ((await readFile(path)).equals(wanted)) {
      return false;
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(path, wanted);
  return true;
}

/**
 * The offline build's counts: the committed index's, by package. No committed index counts nothing
 * (every package is then named as uncounted); a committed index that cannot be read stops the
 * build, since writing over it would replace counts nobody can read back.
 */
function committedCounts(folderName: string, text: string | undefined): Map<string, number> {
  if (text === undefined) {
    return new Map();
  }
  let committed: RegistryIndex;
  try {
    committed = readRegistryIndex(text);
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new RegistryError("The offline build cannot read the committed download counts", [
        ...error.problems.map((problem) => `${folderName}/index.json: ${problem}`),
        `restore ${folderName}/index.json from git, or run the build with the network (registry:build)`,
      ]);
    }
    throw error;
  }
  return new Map(committed.plugins.map((plugin) => [plugin.package, plugin.downloads]));
}

/**
 * Generates `<folder>/index.json` from `<folder>/plugins/*.json`, then the page over it
 * (`index.html`) and the page's fonts (`fonts/`). When the plugins and their figures are what the
 * index on disk already holds, the index keeps its `generatedAt`, and every file is written only
 * when its bytes differ, so a regeneration with no change is no diff.
 */
export async function writeRegistryIndex(
  options: WriteRegistryOptions,
): Promise<WriteRegistryResult> {
  const folderName = basename(options.folder);
  const names = (await readdir(join(options.folder, "plugins"))).sort();
  const notEntries = names.filter((name) => !name.endsWith(".json"));
  if (notEntries.length > 0) {
    throw new RegistryError(
      "The registry index cannot be generated",
      notEntries.map(
        (name) =>
          `${folderName}/plugins/${name}: is not an entry file; an entry file ends in .json`,
      ),
    );
  }
  const files = await Promise.all(
    names.map(async (name) => ({
      file: `${folderName}/plugins/${name}`,
      text: await readFile(join(options.folder, "plugins", name), "utf8"),
    })),
  );
  const indexPath = join(options.folder, "index.json");
  const old = await readIfThere(indexPath);
  const uncounted: string[] = [];
  let downloadsOf = npmDownloads(options.fetch);
  if (options.offline) {
    const counts = committedCounts(folderName, old);
    downloadsOf = async (packageName) => {
      const count = counts.get(packageName);
      if (count === undefined) {
        uncounted.push(packageName);
        return 0;
      }
      return count;
    };
  }
  const fresh = await buildRegistryIndex(files, { downloadsOf, now: options.now });

  // A committed index that no longer reads is replaced by the build with the network, not an
  // error: it is generated output. (The offline build stopped above on one.)
  let index = fresh;
  if (old !== undefined) {
    try {
      const kept = readRegistryIndex(old);
      if (formatRegistryIndex({ ...fresh, generatedAt: kept.generatedAt }) === old) {
        index = kept;
      }
    } catch (error) {
      if (!(error instanceof RegistryError)) {
        throw error;
      }
    }
  }

  const written: string[] = [];
  if (await writeIfChanged(indexPath, formatRegistryIndex(index))) {
    written.push("index.json");
  }
  const tokens = await readFile(join(options.ui, "src", "tokens", "tokens.css"), "utf8");
  if (await writeIfChanged(join(options.folder, "index.html"), renderRegistryPage(index, tokens))) {
    written.push("index.html");
  }
  await mkdir(join(options.folder, "fonts"), { recursive: true });
  for (const file of [...PAGE_FONTS, ...PAGE_FONT_LICENSES]) {
    const bytes = await readFile(join(options.ui, "fonts", file));
    if (await writeIfChanged(join(options.folder, "fonts", file), bytes)) {
      written.push(`fonts/${file}`);
    }
  }
  return { index, written, uncounted };
}

/** The build's closing line: what it wrote, how many plugins, whose counts, and any listed at 0 for want of one. */
export function closingLine(result: WriteRegistryResult, offline: boolean): string {
  const plugins =
    result.index.plugins.length === 1 ? "1 plugin" : `${result.index.plugins.length} plugins`;
  const counts = offline ? "the committed download counts" : "npm's download counts";
  const what =
    result.written.length === 0
      ? `registry/ is already up to date: ${plugins}, with ${counts}.`
      : `Wrote ${result.written.map((file) => `registry/${file}`).join(", ")}: ${plugins}, with ${counts}.`;
  if (result.uncounted.length === 0) {
    return what;
  }
  return `${what} No committed count for ${result.uncounted.join(", ")}, listed at 0 until the build with the network (registry:build) refreshes the counts.`;
}

/**
 * This process's composition root: the repository's `registry/` and `packages/ui/` folders, the
 * clock, and the real `fetch`, or with `--offline` a `fetch` that fails, since nothing may call it.
 */
async function main(): Promise<void> {
  const folder = fileURLToPath(new URL("../../../../registry", import.meta.url));
  const ui = fileURLToPath(new URL("../../../ui", import.meta.url));
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--offline");
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown argument ${unknown.join(", ")}: the build takes --offline or nothing\n`,
    );
    process.exitCode = 1;
    return;
  }
  const offline = args.includes("--offline");
  try {
    const result = await writeRegistryIndex({
      folder,
      ui,
      offline,
      fetch: offline
        ? async () => {
            throw new Error("the offline build asks the network nothing");
          }
        : (url) => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      now: () => new Date(),
    });
    process.stdout.write(`${closingLine(result, offline)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
