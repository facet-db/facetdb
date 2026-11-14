import { fileURLToPath } from "node:url";
import type { EngineTarget, Refusal } from "@facetdb/core";

/**
 * Where a SQLite source's connection string points: `sqlite:///var/lib/app.db` and
 * `sqlite:./app.db`, `file:///var/lib/app.db` and `file:./app.db`, or a bare path ending in `.db`,
 * `.sqlite` or `.sqlite3`. A relative path is the process's working directory's, as SQLite reads
 * it. A query string (`?mode=ro`) is not a part of the path, and is dropped. Nothing here touches
 * the disk.
 */

const SCHEME = /^(sqlite|file):/i;

/** The file a connection string names, or undefined when it names none. */
export function sqlitePath(url: string): string | undefined {
  const text = url.trim();
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return text === "" ? undefined : text;
  }
  const rest = text.slice(scheme.length + 1).split("?")[0] ?? "";
  if (scheme === "file" && rest.startsWith("//")) {
    // A file URL with an authority (`file:///abs`, `file://localhost/abs`): Node decodes it.
    try {
      return fileURLToPath(`file:${rest}`);
    } catch {
      return undefined;
    }
  }
  // `sqlite:///abs` is `/abs`, `sqlite://./app.db` is `./app.db`; `sqlite:app.db` is `app.db`.
  const path = rest.startsWith("//") ? rest.slice(2) : rest;
  return path === "" ? undefined : path;
}

/** Why a connection string names no file: refused before anything opens. */
export function pathRefusal(target: EngineTarget): Refusal {
  const subject = target.urlVariable ?? "the source's connection string";
  return {
    code: "sqlite-path",
    message: `${subject} names no SQLite file`,
    fix: `set ${subject} to the file's path: sqlite:///absolute/path/app.db, file:./app.db, or a path ending in .db, .sqlite or .sqlite3`,
  };
}
