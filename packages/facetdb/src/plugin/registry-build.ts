import { readdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * `pnpm --filter facetdb run registry:build`: reads the entry files of the registry folder, asks
 * npm for each package's downloads and writes `index.json` beside them. The only side effects are
 * the folder and the `fetch` handed in; `main` at the bottom is this process's composition root.
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
  /** The registry folder: `plugins/*.json` in, `index.json` out. */
  readonly folder: string;
  readonly fetch: Fetch;
  readonly now: () => Date;
};

export type WriteRegistryResult = {
  readonly index: RegistryIndex;
  /** False when the index on disk already says the same, so the file was left alone. */
  readonly written: boolean;
};

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

/**
 * Generates `<folder>/index.json` from `<folder>/plugins/*.json`. When the plugins and their
 * figures are what the index on disk already holds, the file is not rewritten (its `generatedAt`
 * stays), so a regeneration with no change is no diff.
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
  const fresh = await buildRegistryIndex(files, {
    downloadsOf: npmDownloads(options.fetch),
    now: options.now,
  });

  const indexPath = join(options.folder, "index.json");
  const old = await readIfThere(indexPath);
  if (old !== undefined) {
    // A committed index that no longer reads is replaced, not an error: it is generated output.
    try {
      const { generatedAt } = readRegistryIndex(old);
      if (formatRegistryIndex({ ...fresh, generatedAt }) === old) {
        return { index: readRegistryIndex(old), written: false };
      }
    } catch (error) {
      if (!(error instanceof RegistryError)) {
        throw error;
      }
    }
  }
  await writeFile(indexPath, formatRegistryIndex(fresh));
  return { index: fresh, written: true };
}

/** This process's composition root: the repository's `registry/` folder, the real `fetch` and the clock. */
async function main(): Promise<void> {
  const folder = fileURLToPath(new URL("../../../../registry", import.meta.url));
  try {
    const { index, written } = await writeRegistryIndex({
      folder,
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      now: () => new Date(),
    });
    process.stdout.write(
      written
        ? `Wrote registry/index.json: ${index.plugins.length} plugins.\n`
        : `registry/index.json is already up to date (${index.plugins.length} plugins).\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
