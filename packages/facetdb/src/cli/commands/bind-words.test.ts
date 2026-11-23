import type { Clock } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import type { StudioFiles } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
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
import { bindWords } from "./bind-words.ts";
import { COMMANDS } from "./index.ts";

/**
 * What `facetdb worker` and `facetdb studio` print at startup when the studio is reached from other
 * machines, and that the config's `studioUrl` reaches the server's rule. The worker's composition
 * on PGlite through the in-process runner, as studio-command.test.ts drives it: the stop signal is
 * aborted before the run, and the HTTP surface is the handler the fake `serve` got.
 */

const PROJECT_DIR = "/work/marketplace";
const BUILD_DIR = "/install/apps/studio/dist";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };

const TLS = "Sign-in needs https: put TLS in front of the studio (Caddy or nginx).";
const TLS_THEN_HTTPS =
  "Sign-in needs https: put TLS in front of the studio (Caddy or nginx), then set studioUrl to its https:// address.";
const BEHIND_PROXY =
  "Behind a proxy, set studioUrl in facetdb.config.ts to the address people open, or every visitor gets in as you. A proxy on this machine must also set X-Forwarded-For.";
const HEADER_ONLY =
  "A proxy on this machine must set X-Forwarded-For, or every visitor gets in as you without signing in.";
const everyoneSignsIn = (host: string) =>
  `studioUrl is ${host}, so everyone signs in, on this machine too. Add sources and questions with facetdb migrate; the studio cannot.`;

/** Every line `bindWords` can print, by a part no other worker line has. */
const ANY_BIND_WORD = /^Sign-in needs https|X-Forwarded-For|^studioUrl is /;

function configWith(studioUrl?: string): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(studioUrl === undefined ? {} : { studioUrl }),
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["subject"],
        questions: { urgent: noul("Is this ticket urgent?") },
      },
    ],
  });
}

/** A clock whose sleeps never end: the stop signal ends the run. */
const clock: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };

const studio: StudioInstall = {
  defaultDir: BUILD_DIR,
  files: (dir): StudioFiles => ({
    read: (names) => {
      const text =
        [dir, ...names].join("/") === `${BUILD_DIR}/index.html`
          ? "<!doctype html><title>FacetDB studio</title>"
          : [dir, ...names].join("/") === `${BUILD_DIR}/routes.json`
            ? JSON.stringify({ routes: ["/"] })
            : undefined;
      return Promise.resolve(text === undefined ? undefined : new TextEncoder().encode(text));
    },
  }),
};

let world: PgliteWorld;
let store: Store;
let served: { readonly handler: HttpHandler; readonly host: string }[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  served = [];
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(argv: readonly string[], config: ProjectConfig) {
  const stop = new AbortController();
  stop.abort();
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {
        FACETDB_SECRET: TEST_SECRET,
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        TYPESAFE_API_KEY: "ts-test-key",
      },
      osUser: () => "alex",
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url, options) => world.connect(url, options),
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      // Nothing is queued, so it is never asked.
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: (handler, port, host) => {
        served.push({ handler, host });
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      stopSignal: () => stop.signal,
      studio,
      openBrowser: () => Promise.resolve(),
    },
    COMMANDS,
  );
}

/** The lines `bindWords` printed, in order. */
function bindLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => ANY_BIND_WORD.test(line));
}

async function anAccount(): Promise<void> {
  await store.users.add("maya", await hashPassword("a long enough password"));
}

/** Who this machine's browser is to the surface the command bound, with no cookie. */
async function fromThisMachine(path = "/v1/project"): Promise<number> {
  return (await askedFromThisMachine(path)).status;
}

async function askedFromThisMachine(path: string): Promise<Response> {
  const [listener] = served;
  if (listener === undefined) {
    throw new Error("the command bound no HTTP surface");
  }
  return listener.handler(new Request(`http://127.0.0.1:4040${path}`), THIS_MACHINE);
}

describe("bind-words: the startup lines", () => {
  it("--host 0.0.0.0 with no studioUrl: TLS, then studioUrl and the forwarding header", async () => {
    await anAccount();
    const result = await run(["worker", "--host", "0.0.0.0"], configWith());

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([TLS, BEHIND_PROXY]);
    // The lines follow the address they are about.
    expect(result.stdout.indexOf("Serving the studio")).toBeLessThan(result.stdout.indexOf(TLS));
    // This machine's browser is still the operator: no studioUrl names another host.
    expect(await fromThisMachine()).toBe(200);
  });

  it("--host 0.0.0.0 with a studioUrl on this machine: TLS and the forwarding header alone", async () => {
    await anAccount();
    const result = await run(["worker", "--host", "0.0.0.0"], configWith("http://localhost:4040"));

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([TLS, HEADER_ONLY]);
    expect(await fromThisMachine()).toBe(200);
  });

  it("--host 0.0.0.0 with an https studioUrl on another host: only that every visitor signs in", async () => {
    await anAccount();
    const result = await run(
      ["worker", "--host", "0.0.0.0"],
      configWith("https://studio.example.com"),
    );

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([everyoneSignsIn("studio.example.com")]);
    expect(await fromThisMachine()).toBe(401);
  });

  it("an http studioUrl on another host: every visitor signs in, and TLS goes in front", async () => {
    await anAccount();
    const result = await run(["worker"], configWith("http://studio.example.com:8080"));

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([
      everyoneSignsIn("studio.example.com:8080"),
      TLS_THEN_HTTPS,
    ]);
    expect(await fromThisMachine()).toBe(401);
  });

  it("an https studioUrl on another host behind a loopback bind: nobody is the operator", async () => {
    await anAccount();
    const result = await run(["worker"], configWith("https://studio.example.com"));

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([everyoneSignsIn("studio.example.com")]);
    expect(await fromThisMachine()).toBe(401);
  });

  it("a loopback bind with no studioUrl, or one on this machine, prints nothing new and keeps the operator", async () => {
    for (const config of [configWith(), configWith("http://localhost:4040")]) {
      served = [];
      const result = await run(["worker"], config);
      expect(result.code).toBe(0);
      expect(bindLines(result.stdout)).toEqual([]);
      expect(await fromThisMachine()).toBe(200);
    }
    expect(bindWords("127.0.0.1", undefined)).toEqual([]);
    expect(bindWords("::1", "http://[::1]:4040")).toEqual([]);
  });

  it("names the studioUrl's host alone, never the rest of the text", () => {
    // The loader refuses a credential, a path or a query; the words would not repeat one anyway.
    const lines = bindWords("127.0.0.1", "https://ops:s3cret@Studio.Example.com:8443/");
    expect(lines).toEqual([everyoneSignsIn("studio.example.com:8443")]);
    expect(lines.join("\n")).not.toMatch(/s3cret|ops@/);
  });

  it("facetdb studio prints the same", async () => {
    await anAccount();
    const result = await run(
      ["studio", "--host", "0.0.0.0", "--no-open"],
      configWith("https://studio.example.com"),
    );

    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([everyoneSignsIn("studio.example.com")]);
  });

  it("facetdb dev keeps this machine's user as the operator whatever studioUrl names", async () => {
    const env: Record<string, string | undefined> = {};
    const stop = new AbortController();
    stop.abort();
    // No account exists: a worker would refuse to start under this studioUrl.
    const result = await runInProcess(
      ["dev"],
      {
        projectDir: PROJECT_DIR,
        env,
        osUser: () => "alex",
        setEnv: (name, value) => {
          env[name] = value;
        },
        loadConfig: () => Promise.resolve(configWith("https://studio.example.com")),
        connect: () => {
          throw new Error("dev connected to a database outside the embedded one");
        },
        provider: () => {
          throw new Error("dev built the real model provider without --model-url");
        },
        clock,
        embedded: {
          open: () => Promise.resolve({ pglite: world.db, close: () => Promise.resolve() }),
          wipe: () => Promise.reject(new Error("these tests wipe nothing")),
        },
        serve: (handler, port, host) => {
          served.push({ handler, host });
          return Promise.resolve({ port, close: () => Promise.resolve() });
        },
        stopSignal: () => stop.signal,
        studio,
        openBrowser: () => Promise.resolve(),
      },
      COMMANDS,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(bindLines(result.stdout)).toEqual([]);
    // The operator's own door: the setup is open to this machine's browser with no sign-in.
    const setup = await askedFromThisMachine("/v1/sources/setup");
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ open: true });
  });

  it("refuses to start with no account when studioUrl names another host, on a loopback bind too", async () => {
    for (const argv of [["worker"], ["studio", "--no-open"]]) {
      served = [];
      const result = await run(argv, configWith("https://studio.example.com"));

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "studioUrl is studio.example.com, so everyone must sign in, and no reviewer account exists; nothing was started",
      );
      // The fix fits `facetdb studio` as well as `facetdb worker`.
      expect(result.stderr).toContain(
        "fix: run facetdb users add <name> to make an account, then start again\n",
      );
      expect(served).toEqual([]);
    }
  });
});
