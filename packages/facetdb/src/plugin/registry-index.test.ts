import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../index.ts";
import {
  buildRegistryIndex,
  formatRegistryIndex,
  MAX_DESCRIPTION,
  RegistryError,
  type RegistryIndex,
  readRegistryIndex,
} from "./registry.ts";
import { type Fetch, npmDownloads, writeRegistryIndex } from "./registry-build.ts";
import { satisfies } from "./semver.ts";

const NOW = new Date("2026-11-13T09:00:00.000Z");

/** An entry file's text with a field changed or removed (`undefined` removes it). */
function entryText(changes: Readonly<Record<string, unknown>> = {}): string {
  const entry: Record<string, unknown> = {
    name: "acme",
    package: "facetdb-plugin-acme",
    description: "Send record notifications to Acme.",
    kinds: ["channel"],
    facetdb: "^1.0.0",
    verified: false,
    ...changes,
  };
  return JSON.stringify(entry);
}

/** A `downloadsOf` that counts as many downloads as the package name has characters, and remembers what it was asked about. */
function countingDownloads() {
  const asked: string[] = [];
  return {
    asked,
    downloadsOf: async (packageName: string) => {
      asked.push(packageName);
      return packageName.length;
    },
  };
}

/** What the generator says about one bad file, or fails the test if it generates. */
async function refusal(
  files: readonly { readonly file: string; readonly text: string }[],
): Promise<{ readonly message: string; readonly asked: readonly string[] }> {
  const { asked, downloadsOf } = countingDownloads();
  try {
    await buildRegistryIndex(files, { downloadsOf, now: () => NOW });
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    return { message: (error as Error).message, asked };
  }
  throw new Error("the generator accepted a bad entry");
}

describe("buildRegistryIndex", () => {
  it("lists every entry with its downloads, sorted by name, with the time it was generated", async () => {
    const { asked, downloadsOf } = countingDownloads();
    const index = await buildRegistryIndex(
      [
        { file: "plugins/zeta.json", text: entryText({ name: "zeta", package: "@facetdb/zeta" }) },
        {
          file: "plugins/acme.json",
          text: entryText({
            kinds: ["source", "action"],
            homepage: "https://example.com/acme",
            verified: true,
          }),
        },
        { file: "plugins/mid.json", text: entryText({ name: "mid", package: "@facetdb/mid" }) },
      ],
      { downloadsOf, now: () => NOW },
    );
    expect(index.generatedAt).toBe("2026-11-13T09:00:00.000Z");
    expect(index.plugins.map((plugin) => plugin.name)).toEqual(["acme", "mid", "zeta"]);
    expect(index.plugins[0]).toEqual({
      name: "acme",
      package: "facetdb-plugin-acme",
      description: "Send record notifications to Acme.",
      kinds: ["action", "source"],
      facetdb: "^1.0.0",
      verified: true,
      homepage: "https://example.com/acme",
      downloads: "facetdb-plugin-acme".length,
    });
    expect(index.plugins[1]?.downloads).toBe("@facetdb/mid".length);
    expect(asked.toSorted()).toEqual(["@facetdb/mid", "@facetdb/zeta", "facetdb-plugin-acme"]);
  });

  it("gives the same index whatever order the files come in", async () => {
    const files = [
      { file: "plugins/b.json", text: entryText({ name: "b", package: "@facetdb/b" }) },
      { file: "plugins/a.json", text: entryText({ name: "a", package: "@facetdb/a" }) },
    ];
    const options = { downloadsOf: async () => 3, now: () => NOW };
    const one = await buildRegistryIndex(files, options);
    const other = await buildRegistryIndex([...files].reverse(), options);
    expect(formatRegistryIndex(one)).toBe(formatRegistryIndex(other));
  });

  it("an empty folder is an empty index", async () => {
    const index = await buildRegistryIndex([], { downloadsOf: async () => 0, now: () => NOW });
    expect(index.plugins).toEqual([]);
    expect(readRegistryIndex(formatRegistryIndex(index))).toEqual(index);
  });
});

describe("a bad entry stops the generation with its file and the reason", () => {
  const cases: readonly {
    readonly rule: string;
    readonly text: string;
    readonly reason: RegExp;
  }[] = [
    { rule: "text that is not JSON", text: "{ nope", reason: /is not valid JSON/ },
    { rule: "an entry that is not an object", text: "[]", reason: /plugins\/bad\.json: / },
    {
      rule: "a field that is missing",
      text: entryText({ description: undefined }),
      reason: /plugins\/bad\.json: description is missing/,
    },
    {
      rule: "a field of the wrong type",
      text: entryText({ verified: "yes" }),
      reason: /plugins\/bad\.json: verified must be true or false/,
    },
    {
      rule: "an unknown field",
      text: entryText({ stars: 5 }),
      reason: /plugins\/bad\.json: unknown field "stars"/,
    },
    {
      rule: "a name with a prefix",
      text: entryText({ name: "@facetdb/acme" }),
      reason: /plugins\/bad\.json: name must be the short name/,
    },
    {
      rule: "a name with capitals",
      text: entryText({ name: "Acme" }),
      reason: /plugins\/bad\.json: name must be the short name/,
    },
    {
      rule: "a package that is not the loader's for the name",
      text: entryText({ package: "acme-plugin" }),
      reason:
        /plugins\/bad\.json: package must be "@facetdb\/acme" or "facetdb-plugin-acme" for the name "acme"/,
    },
    {
      rule: "a package of another name",
      text: entryText({ package: "@facetdb/other" }),
      reason: /plugins\/bad\.json: package must be/,
    },
    {
      rule: "a description over the limit",
      text: entryText({ description: "x".repeat(MAX_DESCRIPTION + 1) }),
      reason: /plugins\/bad\.json: description must be at most 160 characters/,
    },
    {
      rule: "an empty description",
      text: entryText({ description: "   " }),
      reason: /plugins\/bad\.json: description is empty/,
    },
    {
      rule: "a description with a terminal escape",
      text: entryText({ description: "Looks fine\u001b[2J" }),
      reason: /plugins\/bad\.json: description must not contain control characters/,
    },
    {
      rule: "a description with a line break inside",
      text: entryText({ description: "Two\nlines" }),
      reason: /plugins\/bad\.json: description must not contain control characters/,
    },
    {
      rule: "a description with a text direction override",
      text: entryText({ description: "Safe ‮enilnu" }),
      reason: /plugins\/bad\.json: description must not contain .* change the direction/,
    },
    {
      rule: "a description with a direction isolate",
      text: entryText({ description: "Safe ⁦text" }),
      reason: /plugins\/bad\.json: description must not contain .* change the direction/,
    },
    {
      rule: "a homepage with a control character",
      text: entryText({ homepage: "https://example.com/\u001b[2J" }),
      reason: /plugins\/bad\.json: homepage must not contain control characters/,
    },
    {
      rule: "no kind",
      text: entryText({ kinds: [] }),
      reason: /plugins\/bad\.json: kinds must name at least one kind/,
    },
    {
      rule: "a kind core does not have",
      text: entryText({ kinds: ["channel", "widget"] }),
      reason:
        /plugins\/bad\.json: kinds\[1\] must be one of source, action, channel, provider, pack/,
    },
    {
      rule: "a kind named twice",
      text: entryText({ kinds: ["channel", "channel"] }),
      reason: /plugins\/bad\.json: kinds names a kind twice/,
    },
    {
      rule: "a core range that does not parse",
      text: entryText({ facetdb: "latest" }),
      reason: /plugins\/bad\.json: facetdb must be a semver range of FacetDB core versions/,
    },
    {
      rule: "a hyphen range, which the loader's grammar does not read",
      text: entryText({ facetdb: "1.0.0 - 2.0.0" }),
      reason: /plugins\/bad\.json: facetdb must be a semver range/,
    },
    {
      rule: "a homepage that is not a web address",
      text: entryText({ homepage: "javascript:alert(1)" }),
      reason: /plugins\/bad\.json: homepage must be a web address/,
    },
  ];

  for (const { rule, text, reason } of cases) {
    it(`refuses ${rule}, and asks npm nothing`, async () => {
      const { message, asked } = await refusal([
        { file: "plugins/good.json", text: entryText({ name: "good", package: "@facetdb/good" }) },
        { file: "plugins/bad.json", text },
      ]);
      expect(message).toMatch(reason);
      expect(message).not.toContain("plugins/good.json");
      expect(asked).toEqual([]);
    });
  }

  it("keeps an emoji in a description", async () => {
    const index = await buildRegistryIndex(
      [
        {
          file: "plugins/acme.json",
          text: entryText({ description: "Notify the team \u{1F44D}" }),
        },
      ],
      { downloadsOf: async () => 0, now: () => NOW },
    );
    expect(index.plugins[0]?.description).toBe("Notify the team \u{1F44D}");
  });

  it("refuses a file that is not named after the entry, naming the file and the name", async () => {
    const { message, asked } = await refusal([
      { file: "registry/plugins/other.json", text: entryText() },
    ]);
    expect(message).toContain(
      'registry/plugins/other.json: the file must be named acme.json, after the entry\'s name "acme" (plugins/acme.json)',
    );
    expect(asked).toEqual([]);
  });

  it("refuses a file with no .json ending, and a file named for another entry", async () => {
    const { message } = await refusal([
      { file: "plugins/acme", text: entryText() },
      { file: "plugins/acme.JSON", text: entryText() },
      { file: "plugins/beta.json", text: entryText({ name: "gamma", package: "@facetdb/gamma" }) },
    ]);
    expect(message).toContain("plugins/acme: the file must be named acme.json");
    expect(message).toContain("plugins/acme.JSON: the file must be named acme.json");
    expect(message).toContain("plugins/beta.json: the file must be named gamma.json");
  });

  it("refuses a name listed by two files, naming the second file and the first", async () => {
    const { message } = await refusal([
      { file: "one/acme.json", text: entryText() },
      { file: "two/acme.json", text: entryText() },
    ]);
    expect(message).toContain('two/acme.json: name "acme" is already listed by one/acme.json');
  });

  it("reports every bad file at once, in the order given", async () => {
    const { message } = await refusal([
      { file: "plugins/a.json", text: "{" },
      { file: "plugins/b.json", text: entryText({ kinds: [] }) },
      { file: "plugins/c.json", text: entryText({ name: "c", package: "@facetdb/c" }) },
      { file: "plugins/d.json", text: entryText({ verified: 1, facetdb: "x y z" }) },
    ]);
    const lines = message.split("\n").slice(1);
    expect(lines.map((line) => line.match(/plugins\/(\w)\.json/)?.[1])).toEqual([
      "a",
      "b",
      "d",
      "d",
    ]);
  });
});

describe("readRegistryIndex", () => {
  async function goodIndex(): Promise<RegistryIndex> {
    return buildRegistryIndex(
      [
        { file: "acme.json", text: entryText() },
        { file: "b.json", text: entryText({ name: "b", package: "@facetdb/b", kinds: ["pack"] }) },
      ],
      { downloadsOf: async () => 12, now: () => NOW },
    );
  }

  it("reads back what the generator writes", async () => {
    const index = await goodIndex();
    expect(readRegistryIndex(formatRegistryIndex(index))).toEqual(index);
  });

  it("refuses text that is not JSON", () => {
    expect(() => readRegistryIndex("{ nope")).toThrow(
      /The registry index cannot be read:\n {2}- it is not valid JSON/,
    );
  });

  it("refuses an unknown field at the top, within the format it knows", async () => {
    const text = JSON.stringify({ ...(await goodIndex()), extra: true });
    expect(() => readRegistryIndex(text)).toThrow(
      /index: unknown field "extra"; the fields are format, generatedAt, plugins/,
    );
  });

  it("writes the format first, and 1 today", async () => {
    const index = await goodIndex();
    expect(index.format).toBe(1);
    expect(formatRegistryIndex(index).startsWith('{\n  "format": 1,\n  "generatedAt"')).toBe(true);
  });

  it("refuses a format it does not know, saying this facetdb is too old, whatever else the file holds", async () => {
    const index = await goodIndex();
    const later = JSON.stringify({
      ...index,
      format: 2,
      plugins: [{ name: "new shape" }],
      more: 1,
    });
    expect(() => readRegistryIndex(later)).toThrow(
      /The registry index cannot be read:\n {2}- it is in format 2, and this facetdb reads format 1: this facetdb is too old for the registry; upgrade facetdb/,
    );
    expect(() => readRegistryIndex(JSON.stringify({ format: 10 }))).toThrow(
      /this facetdb is too old for the registry; upgrade facetdb/,
    );
  });

  it("refuses an index with no format as a malformed index, not as an old facetdb", async () => {
    const { format: _, ...without } = await goodIndex();
    const attempt = () => readRegistryIndex(JSON.stringify(without));
    expect(attempt).toThrow(/index: format is missing/);
    expect(attempt).not.toThrow(/too old/);
  });

  it("refuses a format that is not a known number as malformed", async () => {
    const index = await goodIndex();
    for (const format of [0, "1", null, 1.5]) {
      expect(() => readRegistryIndex(JSON.stringify({ ...index, format }))).toThrow(
        /index: format must be 1/,
      );
    }
  });

  it("refuses an unknown field in a listing", async () => {
    const index = await goodIndex();
    const text = JSON.stringify({
      ...index,
      plugins: [{ ...index.plugins[0], stars: 3 }, index.plugins[1]],
    });
    expect(() => readRegistryIndex(text)).toThrow(/index: plugins\[0\]: unknown field "stars"/);
  });

  it("refuses a listing with no downloads or a negative figure", async () => {
    const index = await goodIndex();
    const { downloads: _, ...without } = index.plugins[0] as RegistryIndex["plugins"][number];
    expect(() => readRegistryIndex(JSON.stringify({ ...index, plugins: [without] }))).toThrow(
      /plugins\[0\]\.downloads is missing/,
    );
    expect(() =>
      readRegistryIndex(
        JSON.stringify({ ...index, plugins: [{ ...index.plugins[0], downloads: -1 }] }),
      ),
    ).toThrow(/plugins\[0\]\.downloads must be zero or more/);
  });

  it("applies the entry rules to the listings too", async () => {
    const index = await goodIndex();
    const wrongPackage = { ...index.plugins[0], package: "somebody-else" };
    expect(() => readRegistryIndex(JSON.stringify({ ...index, plugins: [wrongPackage] }))).toThrow(
      /plugins\[0\]\.package must be "@facetdb\/acme" or "facetdb-plugin-acme"/,
    );
  });

  it("refuses a name listed twice and a time that is not a time", async () => {
    const index = await goodIndex();
    const twice = JSON.stringify({ ...index, plugins: [index.plugins[0], index.plugins[0]] });
    expect(() => readRegistryIndex(twice)).toThrow(/plugins\[1\]\.name "acme" is listed twice/);
    expect(() => readRegistryIndex(JSON.stringify({ ...index, generatedAt: "yesterday" }))).toThrow(
      /index: generatedAt must be an ISO 8601 date and time/,
    );
  });
});

describe("npmDownloads", () => {
  function fetchOf(answer: () => Response | Promise<Response>): { fetch: Fetch; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      fetch: async (url) => {
        asked.push(url);
        return answer();
      },
    };
  }

  it("reads the last month's figure from npm's downloads API, scoped names unescaped", async () => {
    const { fetch, asked } = fetchOf(() => new Response(JSON.stringify({ downloads: 4200 })));
    expect(await npmDownloads(fetch)("@facetdb/github")).toBe(4200);
    expect(asked).toEqual(["https://api.npmjs.org/downloads/point/last-month/@facetdb/github"]);
  });

  it("counts a package npm does not know as 0", async () => {
    const { fetch } = fetchOf(
      () => new Response(JSON.stringify({ error: "package not found" }), { status: 404 }),
    );
    expect(await npmDownloads(fetch)("@facetdb/github")).toBe(0);
  });

  it("fails on any other answer instead of counting 0", async () => {
    const down = fetchOf(() => new Response("", { status: 503 }));
    await expect(npmDownloads(down.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /answered 503 for "facetdb-plugin-acme"/,
    );
    const odd = fetchOf(() => new Response(JSON.stringify({ downloads: "many" })));
    await expect(npmDownloads(odd.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /something other than a download figure/,
    );
    const offline = fetchOf(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    await expect(npmDownloads(offline.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /Could not reach npm's downloads API for "facetdb-plugin-acme" \(getaddrinfo ENOTFOUND\)/,
    );
  });

  it("calls a 200 answer that is not JSON something other than a download figure", async () => {
    const page = fetchOf(() => new Response("<html>Bad gateway</html>", { status: 200 }));
    await expect(npmDownloads(page.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /npm's downloads API answered "facetdb-plugin-acme" with something other than a download figure; run the build again later/,
    );
    const empty = fetchOf(() => new Response("", { status: 200 }));
    await expect(npmDownloads(empty.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /something other than a download figure/,
    );
  });

  it("fails a request that timed out with the could-not-reach words, before or while the body arrives", async () => {
    const timeout = () =>
      new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const before = fetchOf(() => {
      throw timeout();
    });
    await expect(npmDownloads(before.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /Could not reach npm's downloads API for "facetdb-plugin-acme" \(The operation was aborted due to timeout\); check the network/,
    );
    // An answer whose body stops arriving: only `ok`, `status` and `json` are read from it.
    const during = fetchOf(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw timeout();
          },
        }) as unknown as Response,
    );
    await expect(npmDownloads(during.fetch)("facetdb-plugin-acme")).rejects.toThrow(
      /Could not reach npm's downloads API for "facetdb-plugin-acme" \(The operation was aborted due to timeout\)/,
    );
  });
});

describe("writeRegistryIndex", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });

  async function folderWith(files: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "registry-"));
    folders.push(root);
    const folder = join(root, "registry");
    await mkdir(join(folder, "plugins"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(folder, "plugins", name), text);
    }
    return folder;
  }

  const known: Fetch = async () => new Response(JSON.stringify({ downloads: 5 }));
  const ui = fileURLToPath(new URL("../../../ui", import.meta.url));

  /** The build with the network, through the given `fetch`, at the given time. */
  function build(folder: string, fetch: Fetch, now: Date) {
    return writeRegistryIndex({ folder, ui, fetch, offline: false, now: () => now });
  }

  it("writes the index, and a second run with nothing changed leaves the file alone", async () => {
    const folder = await folderWith({ "acme.json": entryText() });
    const first = await build(folder, known, NOW);
    expect(first.written).toContain("index.json");
    const text = await readFile(join(folder, "index.json"), "utf8");
    expect(readRegistryIndex(text).plugins[0]?.downloads).toBe(5);

    const later = new Date("2026-12-01T00:00:00.000Z");
    const second = await build(folder, known, later);
    expect(second.written).toEqual([]);
    expect(await readFile(join(folder, "index.json"), "utf8")).toBe(text);
  });

  it("rewrites it when a figure or an entry changed", async () => {
    const folder = await folderWith({ "acme.json": entryText() });
    await build(folder, known, NOW);
    const more: Fetch = async () => new Response(JSON.stringify({ downloads: 6 }));
    const later = new Date("2026-12-01T00:00:00.000Z");
    const result = await build(folder, more, later);
    expect(result.written).toEqual(["index.json", "index.html"]);
    expect(result.index.generatedAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("replaces an index that no longer reads", async () => {
    const folder = await folderWith({ "acme.json": entryText() });
    await writeFile(join(folder, "index.json"), '{ "old": true }');
    const result = await build(folder, known, NOW);
    expect(result.written).toContain("index.json");
  });

  it("names a file that is not an entry file, and writes nothing", async () => {
    const folder = await folderWith({ "acme.json": entryText(), "notes.txt": "hi" });
    await expect(build(folder, known, NOW)).rejects.toThrow(
      /registry\/plugins\/notes\.txt: is not an entry file; an entry file ends in \.json/,
    );
    expect(await readdir(folder)).toEqual(["plugins"]);
  });

  it("names the bad entry file by its path in the registry folder", async () => {
    const folder = await folderWith({ "acme.json": entryText({ kinds: [] }) });
    await expect(build(folder, known, NOW)).rejects.toThrow(
      /registry\/plugins\/acme\.json: kinds must name at least one kind/,
    );
  });
});

describe("the committed registry", () => {
  const folder = fileURLToPath(new URL("../../../../registry/", import.meta.url));

  async function committedEntries() {
    const names = (await readdir(join(folder, "plugins"))).sort();
    return Promise.all(
      names.map(async (name) => ({
        file: `registry/plugins/${name}`,
        text: await readFile(join(folder, "plugins", name), "utf8"),
      })),
    );
  }

  it("is what the generator makes of the committed entries with the committed counts", async () => {
    const committedText = await readFile(join(folder, "index.json"), "utf8");
    const committed = readRegistryIndex(committedText);
    const counts = new Map(committed.plugins.map((plugin) => [plugin.package, plugin.downloads]));
    const regenerated = await buildRegistryIndex(await committedEntries(), {
      downloadsOf: async (packageName) => {
        const count = counts.get(packageName);
        if (count === undefined) {
          throw new Error(`${packageName} has no committed count: run registry:build`);
        }
        return count;
      },
      now: () => new Date(committed.generatedAt),
    });
    expect(formatRegistryIndex(regenerated)).toBe(committedText);
  });

  it("lists the first-party plugins, each for a core range the present version satisfies", async () => {
    const committed = readRegistryIndex(await readFile(join(folder, "index.json"), "utf8"));
    expect(committed.plugins.map((plugin) => plugin.name)).toEqual([
      "email",
      "github",
      "packs",
      "slack",
      "telegram",
    ]);
    for (const plugin of committed.plugins) {
      expect(plugin.package, plugin.name).toBe(`@facetdb/${plugin.name}`);
      expect(satisfies(VERSION, plugin.facetdb), `${plugin.name} supports ${plugin.facetdb}`).toBe(
        true,
      );
    }
  });
});
