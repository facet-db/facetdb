import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";

/**
 * A SQLite file of a test's own, in a directory of its own under the system's temporary directory:
 * SQLite runs in-process, so the unit tests run their SQL on a real file, with no server and no
 * container.
 */
export type TemporaryDatabase = {
  /** The file's path; nothing is there until a handle opens it. */
  readonly path: string;
  /** A handle on the file, as the application or the worker holds one; `remove` closes it. */
  open(options?: DatabaseSyncOptions): DatabaseSync;
  /** Closes every handle `open` gave that is still open, and deletes the file, its -wal and -shm. */
  remove(): void;
};

export function temporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "facetdb-sqlite-"));
  const path = join(directory, "source.db");
  const handles: DatabaseSync[] = [];
  return {
    path,
    open(options = {}) {
      const handle = new DatabaseSync(path, options);
      handles.push(handle);
      return handle;
    },
    remove() {
      for (const handle of handles) {
        if (handle.isOpen) {
          handle.close();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
