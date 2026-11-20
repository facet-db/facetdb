import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskConfigFiles, type GitCommand, type GitRun, gitStateOf } from "./config-files.ts";
import { diskWorkspace } from "./main.ts";

/**
 * The config file's door on the disk: read never through a link, replaced aside and renamed, and
 * judged by what `git status` prints for the one file. `git` is the test's own.
 */

/** A `git` that answers with `run` and records how it was asked. */
function git(run: GitRun) {
  const asked: { readonly args: readonly string[]; readonly cwd: string }[] = [];
  const command: GitCommand = (args, cwd) => {
    asked.push({ args, cwd });
    return Promise.resolve(run);
  };
  return { asked, command };
}

const ran = (stdout: string, code = 0, stderr = ""): GitRun => ({
  kind: "ran",
  code,
  stdout,
  stderr,
});

describe("what git says of the config file", () => {
  it("asks for that one file's status from its directory, ignored files included", async () => {
    const g = git(ran(""));
    expect(await gitStateOf(g.command, "/work/app/facetdb.config.ts")).toEqual({ kind: "clean" });
    expect(g.asked).toEqual([
      {
        args: ["status", "--porcelain=v1", "--ignored=matching", "-z", "--", "facetdb.config.ts"],
        cwd: "/work/app",
      },
    ]);
  });

  it.each([
    [" M facetdb.config.ts\u0000", "modified"],
    ["M  facetdb.config.ts\u0000", "modified"],
    ["A  facetdb.config.ts\u0000", "modified"],
    ["?? facetdb.config.ts\u0000", "untracked"],
    ["!! facetdb.config.ts\u0000", "ignored"],
  ])("reads %j as %s", async (stdout, kind) => {
    expect(await gitStateOf(git(ran(stdout)).command, "/work/app/facetdb.config.ts")).toEqual({
      kind,
    });
  });

  it("tells no repository, no git, and any other refusal apart", async () => {
    const file = "/work/app/facetdb.config.ts";
    expect(
      await gitStateOf(
        git(ran("", 128, "fatal: not a git repository (or any of the parent directories): .git\n"))
          .command,
        file,
      ),
    ).toEqual({ kind: "no-repository" });
    expect(await gitStateOf(git({ kind: "missing" }).command, file)).toEqual({ kind: "no-git" });
    expect(
      await gitStateOf(
        git(ran("", 128, "fatal: detected dubious ownership in repository at '/work/app'\nmore\n"))
          .command,
        file,
      ),
    ).toEqual({
      kind: "unreadable",
      reason: "fatal: detected dubious ownership in repository at '/work/app'",
    });
    expect(await gitStateOf(git(ran("", 1)).command, file)).toEqual({
      kind: "unreadable",
      reason: "git exited with 1",
    });
  });
});

describe("the config file on the disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "facetdb-config-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const door = () => diskConfigFiles(dir, diskWorkspace(dir, {}), git(ran("")).command);

  it("reads the file, and replaces it whole through a file beside it, keeping its mode", async () => {
    await writeFile(join(dir, "facetdb.config.ts"), "old\n", { mode: 0o640 });

    expect(await door().read("facetdb.config.ts")).toEqual({ kind: "file", text: "old\n" });
    await door().replace("facetdb.config.ts", "new\n");

    expect(await readFile(join(dir, "facetdb.config.ts"), "utf8")).toBe("new\n");
    expect((await stat(join(dir, "facetdb.config.ts"))).mode & 0o777).toBe(0o640);
    // No temporary file is left beside it.
    expect(await readdir(dir)).toEqual(["facetdb.config.ts"]);
  });

  it("never reads through a link nor a directory, and says when there is no file", async () => {
    await writeFile(join(dir, "elsewhere.ts"), "export default {};\n");
    await symlink(join(dir, "elsewhere.ts"), join(dir, "facetdb.config.ts"));
    await mkdir(join(dir, "folder.ts"));

    expect(await door().read("facetdb.config.ts")).toEqual({ kind: "not-a-file" });
    expect(await door().read("folder.ts")).toEqual({ kind: "not-a-file" });
    expect(await door().read("missing.ts")).toEqual({ kind: "missing" });
  });
});
