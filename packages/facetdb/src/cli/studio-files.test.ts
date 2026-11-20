import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskStudioFiles } from "./studio-files.ts";

/**
 * The studio build's door on the disk, on a temporary directory: a build beside a secret, and links
 * that stay inside the build or lead out of it. The surface's own rules (plain names, the app's
 * routes, /v1) are proven over a fake door in packages/server.
 */

let base: string;
let build: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "facetdb-studio-"));
  build = join(base, "dist");
  await mkdir(join(build, "assets"), { recursive: true });
  await writeFile(join(build, "index.html"), "<!doctype html>");
  await writeFile(join(build, "assets", "index-a1b2c3.js"), "console.log('studio')");
  await writeFile(join(base, "secret.txt"), "DATABASE_URL=postgres://owner:password@db/app");
  await writeFile(join(build, ".env"), "FACETDB_SECRET=hidden");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe("the studio build on the disk", () => {
  it("reads a file of the build by its names", async () => {
    const files = diskStudioFiles(build);
    expect(text(await files.read(["index.html"]))).toBe("<!doctype html>");
    expect(text(await files.read(["assets", "index-a1b2c3.js"]))).toBe("console.log('studio')");
  });

  it("finds nothing where the build has nothing, nor a directory, nor a missing build", async () => {
    expect(await diskStudioFiles(build).read(["missing.js"])).toBeUndefined();
    expect(await diskStudioFiles(build).read(["assets"])).toBeUndefined();
    expect(await diskStudioFiles(build).read(["index.html", "more.js"])).toBeUndefined();
    expect(await diskStudioFiles(join(base, "never-built")).read(["index.html"])).toBeUndefined();
  });

  it("refuses names that climb, separate, hide or are empty, without looking", async () => {
    const files = diskStudioFiles(build);
    for (const names of [
      [],
      [".."],
      ["..", "secret.txt"],
      ["assets", "..", "..", "secret.txt"],
      ["../secret.txt"],
      ["..\\secret.txt"],
      [".env"],
      [""],
      ["index.html\0.js"],
      [join(base, "secret.txt")],
    ]) {
      expect(await files.read(names), JSON.stringify(names)).toBeUndefined();
    }
  });

  it("follows a link only while it stays inside the build", async () => {
    await symlink(join(build, "index.html"), join(build, "home.html"));
    await symlink(join(base, "secret.txt"), join(build, "leak.txt"));
    await symlink(base, join(build, "up"));
    const files = diskStudioFiles(build);
    expect(text(await files.read(["home.html"]))).toBe("<!doctype html>");
    expect(await files.read(["leak.txt"])).toBeUndefined();
    expect(await files.read(["up", "secret.txt"])).toBeUndefined();
  });

  it("serves a build that is itself reached through a link", async () => {
    await symlink(build, join(base, "current"));
    expect(text(await diskStudioFiles(join(base, "current")).read(["index.html"]))).toBe(
      "<!doctype html>",
    );
  });
});
