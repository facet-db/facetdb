import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { StudioFiles } from "@facetdb/server";

/**
 * The studio build's door on the real disk: the HTTP surface reads apps/studio's `dist/` through it
 * and never touches the disk itself. The surface hands it plain names only; this door checks again,
 * and follows a link only to where it really leads: a file that resolves outside the build
 * directory (a link to /etc, to the project's .env) is not there.
 */

/** Errors that mean "nothing readable at that path"; anything else is a fault the caller reports. */
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function absent(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" && ABSENT.has(code);
}

/** A name the build cannot hold under the surface's rule; the door refuses it without looking. */
function unsafe(name: string): boolean {
  return (
    name === "" ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  );
}

export function diskStudioFiles(directory: string): StudioFiles {
  return {
    async read(names) {
      if (names.length === 0 || names.some(unsafe)) {
        return undefined;
      }
      try {
        // Both resolved on every read: a rebuild may replace the directory while the worker runs.
        const root = await realpath(directory);
        const file = await realpath(join(root, ...names));
        if (!file.startsWith(`${root}${sep}`)) {
          return undefined;
        }
        if (!(await stat(file)).isFile()) {
          return undefined;
        }
        const bytes = await readFile(file);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (error) {
        if (absent(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
