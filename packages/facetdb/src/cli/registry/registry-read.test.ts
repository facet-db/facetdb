import { describe, expect, it } from "vitest";
import {
  checkRegistryAddress,
  DEFAULT_REGISTRY,
  MAX_INDEX_CHARS,
  mayCarryRegistry,
  plain,
  type RegistryDeps,
  readRegistry,
  registryAddress,
} from "./index.ts";

/**
 * The one reader of the plugin registry on its own: how the address is resolved and judged, and how
 * a body is read with its limits enforced while it is read. The door's and `facetdb add`'s tests
 * cover the two callers; nothing here reaches a network or the disk.
 */

const INDEX = JSON.stringify({ format: 1, generatedAt: "2026-11-13T09:00:00.000Z", plugins: [] });

function usable(address: string) {
  const checked = checkRegistryAddress(address);
  if (!checked.usable) {
    throw new Error(`expected ${address} to be usable`);
  }
  return checked;
}

function deps(over: Partial<RegistryDeps> = {}): RegistryDeps {
  return {
    fetch: () => Promise.reject(new Error("this test reads no network")),
    abortAfter: () => new AbortController().signal,
    workspace: {
      peek: () => Promise.resolve({ kind: "none" }),
      lines: async function* () {},
    },
    ...over,
  };
}

describe("the registry's address", () => {
  it("is the flag, else FACETDB_REGISTRY, else the default, trimmed, an empty one counting as unset", () => {
    expect(registryAddress({})).toBe(DEFAULT_REGISTRY);
    expect(registryAddress({ FACETDB_REGISTRY: "  " })).toBe(DEFAULT_REGISTRY);
    expect(registryAddress({ FACETDB_REGISTRY: " registry/index.json " })).toBe(
      "registry/index.json",
    );
    expect(registryAddress({ FACETDB_REGISTRY: "env.json" }, "flag.json")).toBe("flag.json");
  });

  it("is a web address to fetch or a file to read, and anything else is refused without being echoed", () => {
    expect(checkRegistryAddress("https://r.example.com/i.json?token=abc#frag")).toEqual({
      usable: true,
      kind: "web",
      address: "https://r.example.com/i.json?token=abc#frag",
      shown: "https://r.example.com/i.json",
      public: "https://r.example.com/i.json",
    });
    expect(checkRegistryAddress("http://localhost:8080/i.json")).toMatchObject({ kind: "web" });
    // A file's path is the operator's to see; any other reader is told it is a file, not which.
    for (const file of [
      "registry/index.json",
      "/srv/index.json",
      "C:\\registry\\index.json",
      "C:/registry/index.json",
      "a b.json",
      "not a url hunter2.json",
    ]) {
      expect(checkRegistryAddress(file), file).toEqual({
        usable: true,
        kind: "file",
        address: file,
        shown: file,
        public: "a file in the project directory",
      });
    }
  });

  it("refuses what is neither, mistyped web addresses included, in words that name where it was set and never echo it", () => {
    for (const bad of [
      "",
      "https://alice:hunter2@r.example.com/i.json",
      "http://r.example.com/hunter2.json",
      "ftp://r.example.com/hunter2.json",
      "file:///etc/hunter2",
      "javascript:alert('hunter2')",
      "https://",
      "a\u001b[2Jhunter2.json",
      // A web address with a slip of the keys is not taken for a file.
      "https//ops:hunter2@r.example.com/index.json",
      "http//ops:hunter2@r.example.com/index.json",
      "https:/ops:hunter2@r.example.com/index.json",
      "https:/r.example.com/hunter2.json",
      "//ops:hunter2@r.example.com/x",
      "r.example.com/index.json?token=hunter2",
      "r.example.com/index.json#hunter2",
      "ops:hunter2@r.example.com/index.json",
      // A network share, with or without a credential.
      "\\\\ops:hunter2@r.example.com\\share\\index.json",
      "\\\\server\\share\\hunter2.json",
    ]) {
      for (const source of ["env", "flag"] as const) {
        const checked = checkRegistryAddress(bad, source);
        expect(checked, bad).toMatchObject({ usable: false });
        const why = (checked as { why: string }).why;
        expect(why, bad).toContain(
          source === "flag" ? "the --registry of facetdb add" : "FACETDB_REGISTRY is not",
        );
        expect(why, bad).not.toMatch(/hunter2|alice|r\.example\.com|server/);
      }
    }
    // Where it was set decides which name is the one to change.
    const fromFlag = checkRegistryAddress("//x@y", "flag") as { why: string };
    expect(fromFlag.why).not.toContain("FACETDB_REGISTRY");
    expect(fromFlag.why).toContain("leave it out");
    const fromEnv = checkRegistryAddress("//x@y", "env") as { why: string };
    expect(fromEnv.why).toContain("unset it");
  });

  it("lets plain http carry the index on this machine only", () => {
    expect(mayCarryRegistry("https://r.example.com/i.json")).toBe(true);
    expect(mayCarryRegistry("http://127.0.0.1/i.json")).toBe(true);
    expect(mayCarryRegistry("http://[::1]:80/i.json")).toBe(true);
    expect(mayCarryRegistry("http://r.example.com/i.json")).toBe(false);
    expect(mayCarryRegistry("nonsense")).toBe(false);
  });

  it("makes control characters and direction marks harmless in text it prints", () => {
    expect(plain("a\u001b[2Jb\u202Ec\nd")).toBe("a?[2Jb?c\nd");
  });
});

describe("reading the index", () => {
  it("stops reading a body once it passes the limit, without buffering the rest", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(" ".repeat(500_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Never ends: only the limit can stop the read.
        controller.enqueue(chunk);
      },
    });
    const read = await readRegistry(
      usable("https://r.example.com/i.json"),
      deps({ fetch: () => Promise.resolve(new Response(body)) }),
    );
    expect(read).toEqual({
      why: `the registry's index is larger than ${MAX_INDEX_CHARS} characters`,
    });
    // The limit is four chunks; the stream is asked a handful of times, never to its end.
    expect(pulled).toBeLessThan(10);
  });

  it("never follows a redirect: it asks with redirect error, and says so in fixed words when the platform refuses one", async () => {
    const asked: unknown[] = [];
    const refusing = deps({
      fetch: (_url, init) => {
        asked.push(init.redirect);
        // What the platform's fetch throws for `redirect: "error"`, quoting the address it was sent to.
        return Promise.reject(
          new TypeError("fetch failed", {
            cause: new Error("unexpected redirect to http://elsewhere.example.com/i.json?t=abc123"),
          }),
        );
      },
    });
    const read = await readRegistry(usable("https://r.example.com/i.json"), refusing);
    expect(asked).toEqual(["error"]);
    expect(read).toEqual({
      why: "the registry answered with a redirect, which is not followed: set FACETDB_REGISTRY (or --registry for facetdb add) to the address it redirects to",
    });
    expect(JSON.stringify(read)).not.toMatch(/elsewhere|abc123/);
  });

  it("refuses a file past the cap by its size, before reading any of it", async () => {
    let read = false;
    const big = deps({
      workspace: {
        peek: () => Promise.resolve({ kind: "file", firstLine: "{", bytes: MAX_INDEX_CHARS + 1 }),
        lines: async function* () {
          read = true;
          yield "{}";
        },
      },
    });
    expect(await readRegistry(usable("registry/index.json"), big)).toEqual({
      why: `the registry's index is larger than ${MAX_INDEX_CHARS} characters`,
    });
    expect(read).toBe(false);
  });

  it("shows a file registry as fixed words in a reason, never its path", async () => {
    const path = "secrets/hunter2/index.json";
    const quoting = JSON.stringify({
      format: 1,
      generatedAt: "2026-11-13T09:00:00.000Z",
      plugins: [],
      [path]: 1,
    });
    const read = await readRegistry(
      usable(path),
      deps({
        workspace: {
          peek: () => Promise.resolve({ kind: "file", firstLine: "{" }),
          lines: async function* () {
            yield quoting;
          },
        },
      }),
    );
    const why = (read as { why: string }).why;
    expect(why).toContain('unknown field "a file in the project directory"');
    expect(why).not.toContain("hunter2");
  });

  it("reads a file line by line from the project's directory, with the same limit", async () => {
    const files = deps({
      workspace: {
        peek: () => Promise.resolve({ kind: "file", firstLine: "{" }),
        lines: async function* () {
          yield* INDEX.split("\n");
        },
      },
    });
    expect(await readRegistry(usable("registry/index.json"), files)).toMatchObject({
      index: { format: 1 },
    });
    const huge = deps({
      workspace: {
        peek: () => Promise.resolve({ kind: "file", firstLine: "{" }),
        lines: async function* () {
          for (;;) {
            yield " ".repeat(500_000);
          }
        },
      },
    });
    expect(await readRegistry(usable("registry/index.json"), huge)).toMatchObject({
      why: expect.stringContaining("larger than"),
    });
    const link = deps({
      workspace: {
        peek: () => Promise.resolve({ kind: "other" }),
        lines: async function* () {},
      },
    });
    expect(await readRegistry(usable("registry/index.json"), link)).toEqual({
      why: "the registry path is not a regular file",
    });
  });

  it("replaces the raw address in a reason by the shown one, and a dollar sign in it is not a pattern", async () => {
    const address = "https://r.example.com/i$&.json?token=abc123";
    const quoting = JSON.stringify({
      format: 1,
      generatedAt: "2026-11-13T09:00:00.000Z",
      plugins: [],
      [address]: 1,
    });
    const read = await readRegistry(
      usable(address),
      deps({ fetch: () => Promise.resolve(new Response(quoting)) }),
    );
    const why = (read as { why: string }).why;
    expect(why).toContain('unknown field "https://r.example.com/i$&.json"');
    expect(why).not.toContain("abc123");
  });
});
