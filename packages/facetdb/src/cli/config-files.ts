import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ConfigFileRead, ConfigFiles, GitState } from "../config/index.ts";
import type { Workspace } from "./program.ts";

/**
 * The config file's door on the real disk: read without following a link, replaced through the
 * workspace's aside-and-rename (`Workspace.writeParts`, export's pattern), and judged by `git
 * status`. The composition root (`main.ts`) wires it with the `git` command; a test hands in its
 * own `git`.
 */

/** How `git` ended: its exit code and output, or `missing` when there is no `git` to run. */
export type GitRun =
  | {
      readonly kind: "ran";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "missing" };

/** Runs `git <args>` in a directory. */
export type GitCommand = (args: readonly string[], cwd: string) => Promise<GitRun>;

/** A `git status` that has not answered by then is stuck (a lock, a network mount): it is unreadable. */
const GIT_TIMEOUT_MS = 10_000;

function codeOf(error: unknown): unknown {
  return (error as { readonly code?: unknown } | undefined)?.code;
}

/**
 * The `git` on the PATH of `env`, in the C locale so its refusals read the same everywhere, with
 * optional locks off so a status taken while the operator works never blocks their own git.
 */
export function gitCommand(env: Readonly<Record<string, string | undefined>>): GitCommand {
  return (args, cwd) =>
    new Promise((settle) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          if (error !== null && codeOf(error) === "ENOENT") {
            settle({ kind: "missing" });
            return;
          }
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          settle({ kind: "ran", code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/**
 * What `git status` says of one file: nothing for a committed, unmodified file; `??` untracked;
 * `!!` ignored; any other line a change git has not committed (staged or not, added, renamed).
 */
export async function gitStateOf(git: GitCommand, file: string): Promise<GitState> {
  const run = await git(
    ["status", "--porcelain=v1", "--ignored=matching", "-z", "--", basename(file)],
    dirname(file),
  );
  if (run.kind === "missing") {
    return { kind: "no-git" };
  }
  if (run.code !== 0) {
    if (/not a git repository/i.test(run.stderr)) {
      return { kind: "no-repository" };
    }
    const reason = run.stderr.trim().split("\n")[0] ?? "";
    return { kind: "unreadable", reason: reason === "" ? `git exited with ${run.code}` : reason };
  }
  const entry = run.stdout.split("\u0000")[0] ?? "";
  if (entry === "") {
    return { kind: "clean" };
  }
  if (entry.startsWith("??")) {
    return { kind: "untracked" };
  }
  if (entry.startsWith("!!")) {
    return { kind: "ignored" };
  }
  return { kind: "modified" };
}

export function diskConfigFiles(
  projectDir: string,
  workspace: Pick<Workspace, "writeParts">,
  git: GitCommand,
): ConfigFiles {
  return {
    read: async (path): Promise<ConfigFileRead> => {
      try {
        // O_NOFOLLOW: a link is never read through, and Apply never writes over one.
        const handle = await open(
          resolve(projectDir, path),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if (!(await handle.stat()).isFile()) {
            return { kind: "not-a-file" };
          }
          return { kind: "file", text: await handle.readFile("utf8") };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (codeOf(error) === "ENOENT") {
          return { kind: "missing" };
        }
        if (codeOf(error) === "ELOOP" || codeOf(error) === "EISDIR") {
          return { kind: "not-a-file" };
        }
        throw error;
      }
    },
    replace: async (path, text) => {
      const parts = (async function* () {
        yield text;
      })();
      await workspace.writeParts(path, parts, { overwrite: true });
    },
    gitState: (path) => gitStateOf(git, resolve(projectDir, path)),
  };
}
