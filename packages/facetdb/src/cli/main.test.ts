import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskWorkspace, projectDirOf } from "./main.ts";

/**
 * The composition root's own pieces: the project directory of a run, found from where pnpm was
 * called up to where the script runs, and the disk's write in parts, which leaves the file as it
 * was until the last part is in and never replaces one without being told to.
 */

/** Directories that hold a `facetdb.config.ts`, as the composition root's check would find them. */
const withConfigIn =
  (...directories: string[]) =>
  (directory: string) =>
    directories.includes(directory);

describe("the project directory", () => {
  it("is where pnpm was called from, when that holds the config and lies inside the working directory", () => {
    const at = "/repo/examples/listings-postgres";
    expect(projectDirOf({ INIT_CWD: at }, "/repo", withConfigIn(at))).toBe(at);
    expect(projectDirOf({ INIT_CWD: "/repo" }, "/repo", withConfigIn())).toBe("/repo");
  });

  it("is the nearest directory above it that holds the config, the working directory included (pnpm run worker from src/)", () => {
    expect(
      projectDirOf({ INIT_CWD: "/work/app/src/jobs" }, "/work", withConfigIn("/work/app")),
    ).toBe("/work/app");
    expect(
      projectDirOf({ INIT_CWD: "/work/app/src" }, "/work/app", withConfigIn("/work/app")),
    ).toBe("/work/app");
  });

  it("is where pnpm was called from when no directory up to the working one holds a config (pnpm facetdb init)", () => {
    expect(projectDirOf({ INIT_CWD: "/repo/new-project" }, "/repo", withConfigIn())).toBe(
      "/repo/new-project",
    );
    // A config further up than the working directory is not the project's.
    expect(projectDirOf({ INIT_CWD: "/repo/new-project" }, "/repo", withConfigIn("/"))).toBe(
      "/repo/new-project",
    );
  });

  it("is the working directory without INIT_CWD, or with an empty one", () => {
    expect(projectDirOf({}, "/work/app", withConfigIn("/work/app"))).toBe("/work/app");
    expect(projectDirOf({ INIT_CWD: "" }, "/work/app", withConfigIn())).toBe("/work/app");
  });

  it("is the working directory when a script went deeper than where pnpm was called (cd db && facetdb …)", () => {
    const anywhere = () => true;
    expect(projectDirOf({ INIT_CWD: "/work/app" }, "/work/app/db", anywhere)).toBe("/work/app/db");
    expect(projectDirOf({ INIT_CWD: "/elsewhere" }, "/work/app", anywhere)).toBe("/work/app");
  });

  it("reads a directory named ..foo as inside, not as a step out", () => {
    expect(projectDirOf({ INIT_CWD: "/work/..foo" }, "/work", withConfigIn("/work/..foo"))).toBe(
      "/work/..foo",
    );
  });
});

describe("a file written in parts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "facetdb-parts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function* parts(...texts: string[]): AsyncGenerator<string> {
    for (const text of texts) {
      yield text;
    }
  }

  async function* failing(): AsyncGenerator<string> {
    yield "page one\n";
    throw new Error("the store went away");
  }

  const workspace = () => diskWorkspace(dir, {});

  it("writes every part, and only the file is left", async () => {
    expect(
      await workspace().writeParts("out/log.jsonl", parts("a\n", "b\n"), { overwrite: false }),
    ).toBe("written");
    expect(await readFile(join(dir, "out/log.jsonl"), "utf8")).toBe("a\nb\n");
    expect(await readdir(join(dir, "out"))).toEqual(["log.jsonl"]);
  });

  it("leaves the file as it was, and no temporary file, when a part fails", async () => {
    await writeFile(join(dir, "log.jsonl"), "last week's export\n");
    for (const overwrite of [false, true]) {
      await expect(workspace().writeParts("log.jsonl", failing(), { overwrite })).rejects.toThrow(
        "the store went away",
      );
      expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("last week's export\n");
      expect(await readdir(dir)).toEqual(["log.jsonl"]);
    }
  });

  it("says exists, writing nothing, without overwrite, and replaces the file whole with it", async () => {
    await writeFile(join(dir, "log.jsonl"), "another run's export\n");
    expect(await workspace().writeParts("log.jsonl", parts("new\n"), { overwrite: false })).toBe(
      "exists",
    );
    expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("another run's export\n");
    expect(await readdir(dir)).toEqual(["log.jsonl"]);
    expect(await workspace().writeParts("log.jsonl", parts("new\n"), { overwrite: true })).toBe(
      "written",
    );
    expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("new\n");
    expect(await readdir(dir)).toEqual(["log.jsonl"]);
  });

  it("keeps the replaced file's mode under overwrite (a 0600 export stays 0600)", async () => {
    await writeFile(join(dir, "log.jsonl"), "private\n", { mode: 0o600 });
    await chmod(join(dir, "log.jsonl"), 0o600);
    expect(await workspace().writeParts("log.jsonl", parts("new\n"), { overwrite: true })).toBe(
      "written",
    );
    expect((await stat(join(dir, "log.jsonl"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("new\n");
  });

  it.each(["EPERM", "ENOTSUP", "EXDEV"])(
    "copies exclusively where the filesystem has no hard links (link fails with %s)",
    async (code) => {
      const noLinks = diskWorkspace(
        dir,
        {},
        {
          link: () =>
            Promise.reject(Object.assign(new Error(`${code}: operation not permitted`), { code })),
        },
      );
      expect(await noLinks.writeParts("log.jsonl", parts("a\n", "b\n"), { overwrite: false })).toBe(
        "written",
      );
      expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("a\nb\n");
      expect(await readdir(dir)).toEqual(["log.jsonl"]);
      // An existing name is reported as the link reports it, and kept.
      expect(await noLinks.writeParts("log.jsonl", parts("c\n"), { overwrite: false })).toBe(
        "exists",
      );
      expect(await readFile(join(dir, "log.jsonl"), "utf8")).toBe("a\nb\n");
      expect(await readdir(dir)).toEqual(["log.jsonl"]);
    },
  );

  it("lets any other link failure through, and removes the temporary file", async () => {
    const broken = diskWorkspace(
      dir,
      {},
      { link: () => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })) },
    );
    await expect(
      broken.writeParts("log.jsonl", parts("a\n"), { overwrite: false }),
    ).rejects.toThrow("EIO");
    expect(await readdir(dir)).toEqual([]);
  });
});
