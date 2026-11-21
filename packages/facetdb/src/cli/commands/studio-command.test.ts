import type { Clock } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import type { StudioFiles } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { browserCommand } from "../browser.ts";
import { studioUrl } from "../links.ts";
import type { HttpHandler, StudioInstall } from "../program.ts";
import { runInProcess } from "../program.ts";
import { hashPassword } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";
import { DEFAULT_HOST, DEFAULT_PORT, parseHost, WORKER_CONNECTIONS } from "./worker.ts";

/**
 * `facetdb studio` and `facetdb worker --studio-dir` through the in-process runner: the worker's
 * composition on PGlite with one API source (no table to install), the studio's build as a map
 * behind the install's door, the browser as a recording opener, and the HTTP surface as the handler
 * the fake `serve` was given. The stop signal is aborted before the run, so the worker stops the
 * moment its loops start: no real port, browser or timer.
 */

const PROJECT_DIR = "/work/marketplace";
const BUILD_DIR = "/install/apps/studio/dist";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const INDEX = '<!doctype html><title>FacetDB studio</title><div id="root"></div>';

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "tickets",
      api: true,
      read: ["subject"],
      questions: { urgent: noul("Is this ticket urgent?") },
    },
  ],
});

/** A clock whose sleeps never end: the stop signal ends the run. */
const clock: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };

/**
 * A studio build as a map of absolute paths to text, every directory the door is opened on noted;
 * `defaultDir` null is an install with no studio package.
 */
function install(files: Readonly<Record<string, string>>, defaultDir: string | null = BUILD_DIR) {
  const opened: string[] = [];
  const studio: StudioInstall = {
    defaultDir: defaultDir ?? undefined,
    files: (dir): StudioFiles => {
      opened.push(dir);
      return {
        read: (names) => {
          const text = files[[dir, ...names].join("/")];
          return Promise.resolve(text === undefined ? undefined : new TextEncoder().encode(text));
        },
      };
    },
  };
  return { studio, opened };
}

const BUILT = {
  [`${BUILD_DIR}/index.html`]: INDEX,
  [`${BUILD_DIR}/routes.json`]: JSON.stringify({ routes: ["/", "/review", "/sign-in"] }),
  [`${BUILD_DIR}/assets/index-a1b2c3.js`]: "console.log('studio')",
};

let world: PgliteWorld;
let store: Store;
let served: { readonly handler: HttpHandler; readonly port: number; readonly host: string }[];
let opened: string[];
let storeAsked: number;
let poolsAsked: (number | undefined)[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  served = [];
  opened = [];
  storeAsked = 0;
  poolsAsked = [];
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  options: {
    readonly studio?: StudioInstall;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly openBrowser?: (url: string) => Promise<void>;
  } = {},
) {
  const stop = new AbortController();
  stop.abort();
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: options.env ?? {
        FACETDB_SECRET: TEST_SECRET,
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        TYPESAFE_API_KEY: "ts-test-key",
      },
      osUser: () => "alex",
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url, connectOptions) => {
        poolsAsked.push(connectOptions?.max);
        return world.connect(url, connectOptions);
      },
      store: () => {
        storeAsked += 1;
        return Promise.resolve({ ...store, close: () => Promise.resolve() });
      },
      // Nothing is queued, so it is never asked.
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: (handler, port, host) => {
        served.push({ handler, port, host });
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      stopSignal: () => stop.signal,
      studio: options.studio ?? install(BUILT).studio,
      openBrowser:
        options.openBrowser ??
        ((url) => {
          opened.push(url);
          return Promise.resolve();
        }),
    },
    COMMANDS,
  );
}

/** Asks the surface the command bound, from this machine. */
async function get(path: string): Promise<Response> {
  const [listener] = served;
  if (listener === undefined) {
    throw new Error("the command bound no HTTP surface");
  }
  return listener.handler(new Request(`http://127.0.0.1:4040${path}`), THIS_MACHINE);
}

describe("facetdb studio", () => {
  it("serves the build beside the API on 127.0.0.1:4040, prints the address and opens the browser once", async () => {
    const result = await run(["studio"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(served.map((one) => [one.host, one.port])).toEqual([[DEFAULT_HOST, DEFAULT_PORT]]);
    expect(result.stdout).toContain(
      "Serving the studio, its endpoints and the check API on http://127.0.0.1:4040.",
    );
    expect(result.stdout).toContain("Opened http://127.0.0.1:4040 in your browser.");
    expect(opened).toEqual(["http://127.0.0.1:4040"]);
    // The same process is the worker: it ran its loops and stopped with every claim settled.
    expect(result.stdout).toContain("Worker running for tickets.");
    expect(result.stdout).toContain("Stopped: every claim was settled.");

    const home = await get("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toBe(INDEX);
    expect((await get("/review")).status).toBe(200);
    const script = await get("/assets/index-a1b2c3.js");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // The API beside it: the studio's data for this machine, and an unknown endpoint stays JSON.
    expect(await (await get("/v1/project")).json()).toEqual({
      project: "marketplace",
      reviewer: "os:alex",
    });
    const unknown = await get("/v1/nothing-here");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("prints the address and opens nothing under --no-open", async () => {
    const result = await run(["studio", "--no-open", "--port", "4141"]);

    expect(result.code).toBe(0);
    expect(opened).toEqual([]);
    expect(result.stdout).toContain(
      "The studio is at http://127.0.0.1:4141: open it in your browser.",
    );
  });

  it("takes --connections as the worker does: the store's pool holds that many", async () => {
    // A Supabase session pooler: 15 sessions per login, filled by the studio's default of 10 plus
    // the LISTEN connection beside a process just closed.
    const result = await run(["studio", "--no-open", "--connections", "6"]);
    expect(result.code, result.stderr).toBe(0);
    expect(poolsAsked).toContain(6);
    expect(poolsAsked).not.toContain(WORKER_CONNECTIONS);
  });

  it("keeps running and says to open the address by hand when no browser starts", async () => {
    const result = await run(["studio"], {
      openBrowser: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Could not open a browser (spawn xdg-open ENOENT): open http://127.0.0.1:4040 yourself.",
    );
    expect(result.stdout).toContain("Stopped: every claim was settled.");
  });

  it("stops with no build, says to run pnpm build, and starts nothing", async () => {
    const empty = install({});
    const result = await run(["studio"], { studio: empty.studio });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`error: ${BUILD_DIR} holds no studio build`);
    expect(result.stderr).toContain("fix: run pnpm build");
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/studio-not-built");
    expect(served).toEqual([]);
    expect(opened).toEqual([]);
    expect(storeAsked).toBe(0);
  });

  it("stops in an install with no studio package, with the same fix", async () => {
    const result = await run(["studio"], { studio: install(BUILT, null).studio });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("this install of facetdb holds no studio to serve");
    expect(result.stderr).toContain("fix: run pnpm build");
    expect(served).toEqual([]);
  });

  it("serves the build --studio-dir names, relative to the project", async () => {
    const elsewhere = install({
      [`${PROJECT_DIR}/build/index.html`]: INDEX,
      [`${PROJECT_DIR}/build/routes.json`]: JSON.stringify({ routes: ["/"] }),
    });
    const result = await run(["studio", "--studio-dir", "build"], { studio: elsewhere.studio });

    expect(result.code).toBe(0);
    expect(elsewhere.opened).toEqual([`${PROJECT_DIR}/build`]);
    expect((await get("/")).status).toBe(200);
  });

  it("keeps the worker's rules: another address needs an account, and FACETDB_SECRET must be set", async () => {
    const open = await run(["studio", "--host", "0.0.0.0"]);
    expect(open.code).toBe(1);
    expect(open.stderr).toContain("facetdb users add");
    expect(opened).toEqual([]);

    await store.users.add("maya", await hashPassword("a long enough password"));
    const shared = await run(["studio", "--host", "0.0.0.0", "--port", "4242"]);
    expect(shared.code).toBe(0);
    // Every interface is bound; the browser here opens this machine's own address.
    expect(served.map((one) => one.host)).toEqual(["0.0.0.0"]);
    expect(opened).toEqual(["http://127.0.0.1:4242"]);

    const unset = await run(["studio"], {
      env: { DATABASE_URL: "postgres://localhost:5432/facetdb", TYPESAFE_API_KEY: "ts-test-key" },
    });
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain("FACETDB_SECRET");
  });

  it("--dry-run says what it would serve and open, and starts nothing", async () => {
    const result = await run(["studio", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Would answer tickets, serve the studio from ${BUILD_DIR} and the check API on 127.0.0.1, port 4040, and open it in your browser. Dry run: nothing was started.`,
    );
    expect(served).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe("facetdb worker and the studio", () => {
  it("serves the install's build beside the API unless told otherwise, and opens no browser", async () => {
    const result = await run(["worker", "--once"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Serving the studio, its endpoints and the check API on http://127.0.0.1:4040.",
    );
    expect((await get("/review")).status).toBe(200);
    expect(opened).toEqual([]);
  });

  it("serves the build --studio-dir names", async () => {
    const elsewhere = install({
      "/srv/studio/index.html": INDEX,
      "/srv/studio/routes.json": JSON.stringify({ routes: ["/", "/review"] }),
    });
    const result = await run(["worker", "--once", "--studio-dir", "/srv/studio"], {
      studio: elsewhere.studio,
    });

    expect(result.code).toBe(0);
    expect(elsewhere.opened).toEqual(["/srv/studio"]);
    expect(await (await get("/review")).text()).toBe(INDEX);
  });

  it("refuses a --studio-dir that holds no build, before anything starts", async () => {
    const result = await run(["worker", "--once", "--studio-dir", "/srv/missing"], {
      studio: install({}).studio,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: /srv/missing holds no studio build");
    expect(served).toEqual([]);
    expect(storeAsked).toBe(0);
  });

  it("serves the API alone when the install's studio is not built, and says so", async () => {
    const result = await run(["worker", "--once"], { studio: install({}).studio });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "note: the studio is not built, so only the API is served; run pnpm build in the FacetDB repository to serve it here too",
    );
    expect(result.stdout).toContain(
      "Serving the check API and the studio's endpoints on http://127.0.0.1:4040.",
    );
    const page = await get("/");
    expect(page.status).toBe(404);
    expect(await page.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("--no-http serves nothing: no surface bound and the build never opened", async () => {
    const installed = install(BUILT);
    const result = await run(["worker", "--once", "--no-http", "--studio-dir", BUILD_DIR], {
      studio: installed.studio,
    });

    expect(result.code).toBe(0);
    expect(served).toEqual([]);
    expect(installed.opened).toEqual([]);
    expect(result.stdout).not.toContain("Serving");
    expect(opened).toEqual([]);
    const unused = `note: --studio-dir ${BUILD_DIR} is unused under --no-http, which serves nothing\n`;
    expect(result.stderr).toBe(unused);

    // On stderr under --json as well, where stdout is the result alone.
    const piped = await run(
      ["worker", "--once", "--no-http", "--json", "--studio-dir", BUILD_DIR],
      {
        studio: installed.studio,
      },
    );
    expect(piped.code).toBe(0);
    expect(piped.stderr).toContain(unused);
    expect(JSON.parse(piped.stdout)).toMatchObject({ ok: true, http: null });
  });

  it("says --studio-dir is unused under facetdb dev --no-http too", async () => {
    const result = await run(["dev", "--dry-run", "--no-http", "--studio-dir", "build"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      "note: --studio-dir build is unused under --no-http, which serves nothing\n",
    );
    expect(result.stdout).toContain("Dry run: nothing was started.");
  });
});

describe("--host", () => {
  it("takes an IPv4 or IPv6 address or a plain host name", () => {
    for (const host of [
      "127.0.0.1",
      "0.0.0.0",
      "192.168.1.20",
      "::1",
      "::",
      "localhost",
      "studio.example.com",
      "my-box",
    ]) {
      expect(parseHost(host), host).toBe(host);
    }
  });

  it("refuses anything cmd or a URL could read as more than an address, a zone id included", () => {
    for (const host of [
      "a&calc",
      "a|b",
      "a^b",
      "50%",
      "fe80::1%eth0",
      "[::1]",
      "",
      "-leading",
      "trailing-",
      "two..dots",
      "a b",
      "host/path",
    ]) {
      expect(() => parseHost(host), host).toThrow(/--host is an IP address or a host name/);
    }
  });

  it("stops facetdb studio with a host holding & before anything starts or opens", async () => {
    const result = await run(["studio", "--host", "a&calc"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('error: --host is an IP address or a host name, not "a&calc"');
    expect(result.stderr).toContain("fix: pass --host 127.0.0.1 for this machine only");
    expect(served).toEqual([]);
    expect(opened).toEqual([]);
    expect(storeAsked).toBe(0);
  });

  it("stops facetdb worker with an IPv6 zone id", async () => {
    const result = await run(["worker", "--once", "--host", "fe80::1%eth0"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not "fe80::1%eth0"');
    expect(served).toEqual([]);
    expect(storeAsked).toBe(0);
  });
});

describe("the browser opener", () => {
  it("runs xdg-open on Linux, open on macOS and start on Windows, the address one argument", () => {
    const url = studioUrl("127.0.0.1", 4040);
    expect(url).toBe("http://127.0.0.1:4040");
    expect(browserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    expect(browserCommand("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(browserCommand("win32", url)).toEqual({
      command: "cmd",
      args: ["/c", "start", '""', url],
    });
  });

  it("opens this machine's address for a host that means every interface", () => {
    expect(studioUrl("0.0.0.0", 4040)).toBe("http://127.0.0.1:4040");
    expect(studioUrl("::", 4040)).toBe("http://[::1]:4040");
    expect(studioUrl("::1", 4040)).toBe("http://[::1]:4040");
    expect(studioUrl("192.168.1.20", 8080)).toBe("http://192.168.1.20:8080");
  });
});
