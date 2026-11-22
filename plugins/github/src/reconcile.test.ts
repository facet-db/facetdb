import { inspect } from "node:util";
import { env, facetdb, noul, VERSION } from "facetdb";
import {
  createPluginHost,
  createPluginSourceConnector,
  type HostedSource,
  hostedSource,
  type Plugin,
  type PluginHost,
  type RecordStore,
  type SourceContext,
  type SourceDefinition,
} from "facetdb/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeGithub, fakeGithub, json, type Seen } from "./fake-github.ts";
import {
  BODY_MAX_BYTES,
  createGithubPlugin,
  GithubActionError,
  type GithubConfig,
  github,
  type IssuesSettings,
  issuesSettings,
} from "./index.ts";
import {
  POLL_INTERVAL_MS,
  POLL_INTERVAL_NO_WEBHOOK_MS,
  RATE_LIMIT_WAIT_MS,
  START_MARGIN_MS,
  STUCK_PAGES_MAX,
} from "./reconcile.ts";

/**
 * The issues source's poll, run as the source's `watch` on a stepped clock and a scripted GitHub
 * that dates its answers by its own clock: what changed while the worker was down is found at
 * start, then every 5 minutes (60 s with no webhook secret); the cursor is GitHub's `updated_at` of
 * the last change read, saved after each page, survives a restart and never runs ahead of GitHub's
 * clock; a change in the second of one already read is read again; a rate limit is waited out on
 * the clock, a refused token is lost access, a 5xx is tried again at the next poll, a page too
 * large is asked for in smaller ones. Every test runs with the timer functions faked, and every
 * time the poll waits it holds no timer: each wait is the context's clock.
 */

const TOKEN = "ghp_P0llT0k3nV4lu3F0rT3st1ngOnly0003";
const SECRET = "whsec_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const VARIABLE = "GITHUB_TOKEN";
const HOOK_VARIABLE = "GITHUB_WEBHOOK_SECRET";
const REPO = "your-org/your-repo";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MINUTE = 60_000;
const FIELDS = ["title", "body", "labels", "changed_files"];
const LIST_PATH = `/repos/${REPO}/issues`;

type Kind = "issues" | "pull_requests";
type Context = SourceContext<GithubConfig, IssuesSettings>;

/** A time as GitHub writes one: UTC, to the second. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A clock whose sleeps end only when the test moves time past them, or when their signal aborts;
 * it lists the sleeps still waiting and every duration asked for.
 */
class SteppedClock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];
  readonly asked: number[] = [];

  constructor(start: number) {
    this.#time = start;
  }

  now(): number {
    return this.#time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((wake) => {
      if (signal?.aborted === true) {
        wake();
        return;
      }
      this.asked.push(ms);
      const sleeper = { due: this.#time + ms, wake };
      this.#sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
          wake();
        },
        { once: true },
      );
    });
  }

  /** When each sleep still waiting ends. */
  pending(): readonly number[] {
    return this.#sleepers.map((sleeper) => sleeper.due);
  }

  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

type WorldOptions = {
  readonly include?: readonly Kind[];
  /** Whether a webhook secret is set (the default); without one the poll is all the source hears. */
  readonly webhooks?: boolean;
  /** The token the variable holds; GitHub's own by default. */
  readonly token?: string;
  /** The worker's clock at the start; `NOW` by default. */
  readonly start?: number;
  /**
   * GitHub's clock, by which it dates each answer: the worker's moved by this many milliseconds
   * (the same clock by default), or `none` for answers with no `Date` header.
   */
  readonly githubClock?: number | "none";
};

type World = {
  readonly gh: FakeGithub;
  readonly clock: SteppedClock;
  readonly host: PluginHost;
  readonly hosted: HostedSource;
  readonly issues: SourceDefinition<GithubConfig>;
  /** The lines the plugin printed. */
  readonly lines: string[];
  /** The source's one saved cursor, as the store would keep it, and every save in order. */
  readonly saved: { value: string | null; readonly saves: string[] };
};

async function world(options: WorldOptions = {}): Promise<World> {
  const clock = new SteppedClock(options.start ?? NOW);
  const offset = options.githubClock ?? 0;
  const gh = fakeGithub({
    token: TOKEN,
    login: "facetdb-bot",
    ...(offset === "none" ? {} : { now: () => clock.now() + offset }),
  });
  gh.repo(REPO);
  const lines: string[] = [];
  const plugin: Plugin<GithubConfig> = createGithubPlugin({
    fetch: gh.fetch,
    now: () => clock.now(),
    warn: (line) => lines.push(line),
  });
  const config = facetdb({
    model: "jev-1.14.0",
    plugins: {
      github:
        options.webhooks === false
          ? { token: env(VARIABLE) }
          : { token: env(VARIABLE), webhookSecret: env(HOOK_VARIABLE) },
    },
    source: github.issues({
      repo: REPO,
      ...(options.include === undefined ? {} : { include: options.include }),
    }),
    read: FIELDS,
    questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
  });
  const environment = { [VARIABLE]: options.token ?? TOKEN, [HOOK_VARIABLE]: SECRET };
  const host = await createPluginHost({
    config,
    env: environment,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: async (specifier: string) => {
      if (specifier === "@facetdb/github") {
        return { default: plugin };
      }
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
    builtins: {},
  });
  const hosted = hostedSource(host, config, config.sources[0] as never, environment);
  const issues = plugin.sources["issues"];
  if (issues === undefined) {
    throw new Error("the plugin has no issues source");
  }
  return { gh, clock, host, hosted, issues, lines, saved: { value: null, saves: [] } };
}

/** The source's context as the SDK's adapter builds it: the stepped clock, the world's cursor. */
function contextOf(w: World, signal: AbortSignal): Context {
  return {
    ...w.host.contextFor("@facetdb/github", signal),
    // The host parsed them with this schema already: parsed again only to carry their type.
    source: {
      name: "issues",
      settings: issuesSettings.parse(w.hosted.settings),
      actions: w.hosted.actions,
    },
    clock: { now: () => w.clock.now(), sleep: (ms, own) => w.clock.sleep(ms, own) },
    cursor: {
      load: () => Promise.resolve(w.saved.value),
      save: (value) => {
        w.saved.value = value;
        w.saved.saves.push(value);
        return Promise.resolve();
      },
    },
  } as Context;
}

type Running = {
  readonly stop: AbortController;
  /** Each batch of keys the poll yielded, in order. */
  readonly batches: string[][];
  /** Settles when the poll ends: with its failure, or with nothing when the source stopped. */
  readonly done: Promise<unknown>;
  readonly ended: boolean;
};

/** The source's `watch`, its batches taken as fast as they come, as the SDK's pump takes them. */
function run(w: World): Running {
  const stop = new AbortController();
  const batches: string[][] = [];
  const state = { ended: false };
  const done = (async () => {
    try {
      for await (const keys of w.issues.watch(contextOf(w, stop.signal))) {
        batches.push([...keys]);
      }
      return undefined;
    } catch (error) {
      return error;
    } finally {
      state.ended = true;
    }
  })();
  return {
    stop,
    batches,
    done,
    get ended() {
      return state.ended;
    },
  };
}

/**
 * Lets the poll go on until it waits on the clock (or ends), and checks that it then holds no
 * timer: a wait that is not the context's clock fails here.
 */
async function idle(w: World, running?: Running): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (w.clock.pending().length > 0 || running?.ended === true) {
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the poll never came to wait on the clock");
}

/** The list requests made, each as its `since` and, past the first, its page number. */
function lists(gh: FakeGithub): string[] {
  return gh.requests
    .filter((seen) => seen.url.pathname === LIST_PATH)
    .map((seen) => {
      const page = seen.url.searchParams.get("page");
      return `${seen.url.searchParams.get("since")}${page === null ? "" : ` page ${page}`}`;
    });
}

/** Every place in `value` where any 8 characters of `secret` in a row are found, by name. */
function leaks(value: unknown, secret = TOKEN): string[] {
  const pieces: string[] = [];
  for (let at = 0; at + 8 <= secret.length; at += 1) {
    pieces.push(secret.slice(at, at + 8).toLowerCase());
  }
  const found: string[] = [];
  const check = (text: string, where: string) => {
    const lower = text.toLowerCase();
    if (pieces.some((piece) => lower.includes(piece))) {
      found.push(where);
    }
  };
  if (value instanceof Error) {
    check(String(value), "as text");
    check(value.stack ?? "", "stack");
    check(JSON.stringify(value, Object.getOwnPropertyNames(value)), "as JSON");
  }
  check(inspect(value, { showHidden: true, depth: 20 }), "inspected");
  return found;
}

beforeEach(() => {
  // Every timer function faked: a wait that is not the context's clock would hold one.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcile: what changed while nobody listened", () => {
  it("@timing finds at start a change made while the worker was down, from the saved cursor, the cursor's own second read again", async () => {
    const w = await world();
    const cursor = NOW - 60 * MINUTE;
    w.saved.value = iso(cursor);
    w.gh.issue(REPO, 8, { updatedAt: iso(cursor - 60 * MINUTE) });
    w.gh.issue(REPO, 9, { updatedAt: iso(cursor) });
    w.gh.issue(REPO, 7, { updatedAt: iso(NOW - 30 * MINUTE) });
    const running = run(w);
    await idle(w, running);

    // One list, from the second before the cursor: 9 changed in the cursor's second, 7 after it.
    expect(w.gh.log()).toEqual([
      `GET ${LIST_PATH}?state=all&sort=updated&direction=asc&since=${encodeURIComponent(iso(cursor - 1000))}&per_page=100`,
    ]);
    expect(running.batches).toEqual([["9", "7"]]);
    expect(w.saved.saves).toEqual([iso(NOW - 30 * MINUTE)]);
    expect(w.clock.pending()).toEqual([NOW + POLL_INTERVAL_MS]);
    expect(w.lines).toEqual([]);
    for (const seen of w.gh.requests) {
      expect(seen.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(seen.redirect).toBe("error");
    }

    running.stop.abort();
    expect(await running.done).toBeUndefined();
    expect(w.clock.pending()).toEqual([]);
  });

  it("@timing starts a few seconds before now on a first start: the issues that exist are the backfill's, and the next change is found at the next poll", async () => {
    const w = await world();
    const start = iso(NOW - START_MARGIN_MS);
    w.gh.issue(REPO, 1);
    w.gh.issue(REPO, 2, { updatedAt: iso(NOW - 10 * MINUTE) });
    const running = run(w);
    await idle(w, running);
    expect(w.saved.saves).toEqual([start]);
    expect(lists(w.gh)).toEqual([iso(NOW - START_MARGIN_MS - 1000)]);
    expect(running.batches).toEqual([]);

    const issue = w.gh.issue(REPO, 3, { updatedAt: iso(NOW + 2 * MINUTE) });
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    expect(running.batches).toEqual([["3"]]);
    expect(w.saved.saves).toEqual([start, issue.updatedAt]);
    running.stop.abort();
    await running.done;
  });

  it("@timing moves a first start's cursor back to GitHub's clock when the worker's runs ahead of it, so a change GitHub stamps after the start is listed", async () => {
    // The worker's clock is 2 minutes ahead of GitHub's.
    const w = await world({ githubClock: -2 * MINUTE });
    const running = run(w);
    await idle(w, running);
    const githubNow = NOW - 2 * MINUTE;
    expect(w.saved.saves).toEqual([iso(NOW - START_MARGIN_MS), iso(githubNow)]);

    // A minute after the start by GitHub's clock: before the worker's start, after GitHub's.
    w.gh.issue(REPO, 5, { updatedAt: iso(githubNow + MINUTE) });
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    expect(lists(w.gh)).toEqual([iso(NOW - START_MARGIN_MS - 1000), iso(githubNow - 1000)]);
    expect(running.batches).toEqual([["5"]]);
    running.stop.abort();
    await running.done;
  });

  it("@timing replaces a saved cursor that is not a time it wrote by a few seconds before now, in one line", async () => {
    const w = await world();
    const start = iso(NOW - START_MARGIN_MS);
    w.saved.value = '{"before":"2026-11-14T10:00:00Z","seen":[]}';
    const running = run(w);
    await idle(w, running);
    expect(w.saved.saves).toEqual([start]);
    expect(w.lines).toEqual([
      `github issues source on ${REPO}: the poll's saved place is not a time it wrote, so it starts from ${start}, a few seconds before now; facetdb backfill reads the open issues changed before it`,
    ]);
    running.stop.abort();
    await running.done;
  });
});

describe("reconcile: a change in the second of one already read", () => {
  it("@timing yields an issue again while GitHub's answer is dated within its second, so a change made later in that second is read", async () => {
    // The worker lists at 12:00:00.4; issue 5 changed at 12:00:00.1, stamped 12:00:00.
    const w = await world({ start: NOW + 400 });
    w.saved.value = iso(NOW - MINUTE);
    const five = w.gh.issue(REPO, 5, { title: "v1", updatedAt: iso(NOW) });
    const running = run(w);
    await idle(w, running);
    expect(running.batches).toEqual([["5"]]);

    // A bot changes it again at 12:00:00.9; GitHub stamps it 12:00:00 still, and its delivery is lost.
    five.labels = ["needs-triage"];
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    // Listed again from the overlapping second and yielded again: its new state is read.
    expect(running.batches).toEqual([["5"], ["5"]]);

    // Dated well after its second now, it is remembered: an idle poll yields nothing more.
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    expect(running.batches).toEqual([["5"], ["5"]]);
    expect(lists(w.gh)).toEqual([iso(NOW - MINUTE - 1000), iso(NOW - 1000), iso(NOW - 1000)]);
    running.stop.abort();
    await running.done;
  });

  it("@timing remembers nothing from an answer with no Date: each poll yields the issue of the cursor's second again", async () => {
    const w = await world({ githubClock: "none" });
    w.saved.value = iso(NOW - 10 * MINUTE);
    w.gh.issue(REPO, 9, { updatedAt: iso(NOW - 10 * MINUTE) });
    const running = run(w);
    await idle(w, running);
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    expect(running.batches).toEqual([["9"], ["9"]]);
    expect(lists(w.gh)).toHaveLength(2);
    running.stop.abort();
    await running.done;
  });
});

describe("reconcile: the intervals", () => {
  it("@timing with webhooks on and nothing changing, makes one list request every 5 minutes and yields the issue of the cursor's second once", async () => {
    const w = await world();
    const cursor = NOW - 10 * MINUTE;
    w.saved.value = iso(cursor);
    w.gh.issue(REPO, 9, { updatedAt: iso(cursor) });
    const running = run(w);
    await idle(w, running);
    for (let poll = 1; poll <= 6; poll += 1) {
      expect(w.clock.pending()).toEqual([NOW + poll * POLL_INTERVAL_MS]);
      w.clock.advance(POLL_INTERVAL_MS);
      await idle(w, running);
    }
    // Half an hour: the poll at start and six more, each one list request and nothing else.
    expect(w.gh.requests).toHaveLength(7);
    expect(lists(w.gh)).toEqual(Array.from({ length: 7 }, () => iso(cursor - 1000)));
    expect(w.clock.asked).toEqual(Array.from({ length: 7 }, () => POLL_INTERVAL_MS));
    // Listed by every poll, in the overlapping second, and yielded once: no read for it again.
    expect(running.batches).toEqual([["9"]]);
    expect(w.saved.saves).toEqual([]);
    running.stop.abort();
    await running.done;
  });

  it("@timing with no webhook secret, polls every 60 seconds", async () => {
    const w = await world({ webhooks: false });
    const running = run(w);
    await idle(w, running);
    w.gh.issue(REPO, 4, { updatedAt: iso(NOW + 30_000) });
    w.clock.advance(POLL_INTERVAL_NO_WEBHOOK_MS);
    await idle(w, running);
    w.clock.advance(POLL_INTERVAL_NO_WEBHOOK_MS);
    await idle(w, running);
    expect(lists(w.gh)).toHaveLength(3);
    expect(w.clock.asked).toEqual([60_000, 60_000, 60_000]);
    expect(running.batches).toEqual([["4"]]);
    running.stop.abort();
    await running.done;
  });

  it("stops when the source stops: while it waits, while GitHub has not answered, and while a rate limit is waited out, leaving no sleep", async () => {
    const waiting = await world();
    const between = run(waiting);
    await idle(waiting, between);
    between.stop.abort();
    expect(await between.done).toBeUndefined();
    expect(waiting.clock.pending()).toEqual([]);

    const hanging = await world();
    hanging.gh.script(() => new Promise<Response>(() => undefined));
    const inFlight = run(hanging);
    for (let turn = 0; turn < 20 && hanging.gh.requests.length === 0; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(hanging.gh.requests).toHaveLength(1);
    inFlight.stop.abort();
    expect(await inFlight.done).toBeUndefined();
    expect(hanging.clock.pending()).toEqual([]);
    expect(hanging.lines).toEqual([]);

    const limited = await world();
    limited.gh.script(() => json(429, { message: "Too many requests" }, { "retry-after": "600" }));
    const resting = run(limited);
    await idle(limited, resting);
    expect(limited.clock.pending()).toEqual([NOW + 600_000]);
    resting.stop.abort();
    expect(await resting.done).toBeUndefined();
    expect(limited.clock.pending()).toEqual([]);
  });
});

describe("reconcile: pages", () => {
  it("@timing reads more than a page as fresh lists from the last change read, the cursor saved after each, so an issue changed meanwhile moves no page", async () => {
    const w = await world();
    const cursor = NOW - 60 * MINUTE;
    w.saved.value = iso(cursor);
    const made = Array.from({ length: 250 }, (_, i) =>
      w.gh.issue(REPO, i + 1, { updatedAt: iso(cursor + (i + 1) * 1000) }),
    );
    // Issue 5, read on the first page, changes before the second is asked for.
    let asked = 0;
    w.gh.script((seen: Seen) => {
      if (seen.url.pathname === LIST_PATH) {
        asked += 1;
        if (asked === 2) {
          (made[4] as (typeof made)[number]).updatedAt = iso(cursor + 300_000);
        }
      }
      return undefined;
    });
    const running = run(w);
    await idle(w, running);

    expect(lists(w.gh)).toEqual([iso(cursor - 1000), iso(cursor + 99_000), iso(cursor + 198_000)]);
    const numbers = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
    // Each page from the second before the last change read: the change at that second is not
    // yielded twice, and 101 is not skipped, as a page number after 5 moved would have done.
    expect(running.batches).toEqual([
      numbers(1, 100),
      numbers(101, 199),
      [...numbers(200, 250), "5"],
    ]);
    expect(w.saved.saves).toEqual([
      iso(cursor + 100_000),
      iso(cursor + 199_000),
      iso(cursor + 300_000),
    ]);
    running.stop.abort();
    await running.done;
  });

  it("@timing reads more than 100 changes of one second by page number, as no fresh list moves past them", async () => {
    const w = await world();
    const cursor = NOW - 60 * MINUTE;
    w.saved.value = iso(cursor);
    for (let number = 1; number <= 150; number += 1) {
      w.gh.issue(REPO, number, { updatedAt: iso(cursor + 1000) });
    }
    const running = run(w);
    await idle(w, running);
    expect(lists(w.gh)).toEqual([iso(cursor - 1000), iso(cursor), `${iso(cursor)} page 2`]);
    expect(running.batches.flat()).toEqual(Array.from({ length: 150 }, (_, i) => String(i + 1)));
    expect(w.saved.saves).toEqual([iso(cursor + 1000)]);
    expect(w.lines).toEqual([]);
    running.stop.abort();
    await running.done;
  });

  it("@timing says so and goes on from the next second past more than 1,000 changes within two seconds", async () => {
    const w = await world();
    const cursor = NOW - 60 * MINUTE;
    w.saved.value = iso(cursor);
    for (let number = 1; number <= 1050; number += 1) {
      w.gh.issue(REPO, number, { updatedAt: iso(cursor + 1000) });
    }
    const running = run(w);
    await idle(w, running);
    expect(lists(w.gh)).toEqual([
      iso(cursor - 1000),
      iso(cursor),
      ...Array.from({ length: STUCK_PAGES_MAX - 1 }, (_, i) => `${iso(cursor)} page ${i + 2}`),
      iso(cursor + 1000),
    ]);
    expect(running.batches.flat()).toHaveLength(STUCK_PAGES_MAX * 100);
    expect(w.saved.saves).toEqual([iso(cursor + 1000), iso(cursor + 2000)]);
    expect(w.lines).toEqual([
      `github issues source on ${REPO}: more than 1000 issues and pull requests changed within the two seconds from ${iso(cursor)}, more than the poll reads; it goes on from the second after ${iso(cursor + 1000)}, and facetdb backfill reads any open issue it passed`,
    ]);
    running.stop.abort();
    await running.done;
  });

  it("@timing never steps past the second GitHub is still in: more than 1,000 changes in it wait for the next poll", async () => {
    // The worker lists at 12:00:00.4; 1,050 issues changed in the second 12:00:00.
    const w = await world({ start: NOW + 400 });
    w.saved.value = iso(NOW - 10_000);
    for (let number = 1; number <= 1050; number += 1) {
      w.gh.issue(REPO, number, { updatedAt: iso(NOW) });
    }
    const running = run(w);
    await idle(w, running);
    expect(lists(w.gh)).toEqual([
      iso(NOW - 11_000),
      iso(NOW - 1000),
      ...Array.from({ length: STUCK_PAGES_MAX - 1 }, (_, i) => `${iso(NOW - 1000)} page ${i + 2}`),
    ]);
    expect(w.saved.saves).toEqual([iso(NOW)]);
    expect(w.lines).toEqual([]);

    // Five minutes on, that second is over: the poll says so and goes on from the next.
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w, running);
    expect(w.saved.saves).toEqual([iso(NOW), iso(NOW + 1000)]);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain(`it goes on from the second after ${iso(NOW)}`);
    running.stop.abort();
    await running.done;
  });

  it("@timing ends the poll on an empty page, whatever its Link says", async () => {
    const w = await world();
    w.saved.value = iso(NOW - MINUTE);
    w.gh.script((seen: Seen) =>
      seen.url.pathname === LIST_PATH
        ? json(200, [], {
            link: `<https://api.github.com${LIST_PATH}?page=2>; rel="next", <https://api.github.com${LIST_PATH}?page=9>; rel="last"`,
          })
        : undefined,
    );
    const running = run(w);
    await idle(w, running);
    expect(w.gh.requests).toHaveLength(1);
    expect(w.clock.pending()).toEqual([NOW + POLL_INTERVAL_MS]);
    expect(w.saved.saves).toEqual([]);
    expect(w.lines).toEqual([]);
    running.stop.abort();
    await running.done;
  });

  it("@timing asks for a page too large to read in pages half as large, and says so when one issue alone is", async () => {
    /** An answer past the most FacetDB reads: 1 MiB of spaces at a time, one MiB too many. */
    const oversized = (): Response => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x20);
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent * chunk.byteLength > BODY_MAX_BYTES) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const sizes = (gh: FakeGithub) =>
      gh.requests
        .filter((seen) => seen.url.pathname === LIST_PATH)
        .map((seen) => Number(seen.url.searchParams.get("per_page")));

    // A hundred issues too large together, fifty not.
    const halved = await world();
    const cursor = NOW - 60 * MINUTE;
    halved.saved.value = iso(cursor);
    for (let number = 1; number <= 150; number += 1) {
      halved.gh.issue(REPO, number, { updatedAt: iso(cursor + number * 1000) });
    }
    halved.gh.script((seen: Seen) =>
      seen.url.pathname === LIST_PATH && seen.url.searchParams.get("per_page") === "100"
        ? oversized()
        : undefined,
    );
    const paging = run(halved);
    await idle(halved, paging);
    expect(sizes(halved.gh)).toEqual([100, 50, 50, 50, 50]);
    expect(paging.batches.flat()).toEqual(Array.from({ length: 150 }, (_, i) => String(i + 1)));
    expect(halved.saved.saves.at(-1)).toBe(iso(cursor + 150_000));
    expect(halved.lines).toEqual([]);
    paging.stop.abort();
    await paging.done;

    // One issue alone too large: said, the cursor kept, and asked again at the next poll.
    const single = await world();
    single.saved.value = iso(NOW - MINUTE);
    single.gh.script((seen: Seen) => (seen.url.pathname === LIST_PATH ? oversized() : undefined));
    const stuck = run(single);
    await idle(single, stuck);
    expect(sizes(single.gh)).toEqual([100, 50, 25, 12, 6, 3, 1]);
    expect(single.lines).toEqual([
      `github issues source on ${REPO}: GitHub's list of the issues updated since ${iso(NOW - MINUTE - 1000)} could not be read even one issue a page (larger than the 16 MiB FacetDB reads, cut off, or slower than 10 seconds); the poll keeps its cursor and tries again at ${iso(NOW + POLL_INTERVAL_MS)}`,
    ]);
    expect(single.saved.saves).toEqual([]);
    expect(single.clock.pending()).toEqual([NOW + POLL_INTERVAL_MS]);
    expect(stuck.ended).toBe(false);
    stuck.stop.abort();
    await stuck.done;
  });

  it("honours include: a source of issues yields no pull request", async () => {
    const w = await world({ include: ["issues"] });
    w.saved.value = iso(NOW - MINUTE);
    w.gh.issue(REPO, 7, { updatedAt: iso(NOW - 30_000) });
    w.gh.issue(REPO, 8, { updatedAt: iso(NOW - 20_000), files: ["src/a.ts"] });
    const running = run(w);
    await idle(w, running);
    expect(running.batches).toEqual([["7"]]);
    // The cursor passes the pull request all the same: it was read, and left out.
    expect(w.saved.saves).toEqual([iso(NOW - 20_000)]);
    running.stop.abort();
    await running.done;
  });
});

describe("reconcile: what GitHub answers", () => {
  it("@timing waits out a rate limit on the clock until GitHub's reset, in one line, then goes on with the same page", async () => {
    const cases: readonly {
      readonly answer: () => Response;
      readonly wait: number;
    }[] = [
      {
        // The primary limit: no request left until the reset, 90 s away.
        answer: () =>
          json(
            403,
            { message: "API rate limit exceeded" },
            { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 90) },
          ),
        wait: 90_000,
      },
      {
        answer: () => json(429, { message: "Too many requests" }, { "retry-after": "30" }),
        wait: 30_000,
      },
      {
        // A secondary limit GitHub gave no time for: one minute, as GitHub asks.
        answer: () => json(403, { message: "You have exceeded a secondary rate limit." }),
        wait: RATE_LIMIT_WAIT_MS,
      },
      {
        // A reset already past by the worker's clock: one minute, never a request a turn.
        answer: () =>
          json(
            403,
            { message: "API rate limit exceeded" },
            { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 - 5) },
          ),
        wait: RATE_LIMIT_WAIT_MS,
      },
    ];
    for (const { answer, wait } of cases) {
      const w = await world();
      w.saved.value = iso(NOW - MINUTE);
      w.gh.issue(REPO, 7, { updatedAt: iso(NOW - 30_000) });
      let limited = false;
      w.gh.script(() => {
        if (limited) {
          return undefined;
        }
        limited = true;
        return answer();
      });
      const running = run(w);
      await idle(w, running);
      expect(w.lines).toEqual([
        `github issues source on ${REPO}: GitHub's rate limit stopped the poll (status ${answer().status}); it waits until ${iso(NOW + wait)}, then goes on from where it stopped`,
      ]);
      expect(w.clock.pending()).toEqual([NOW + wait]);
      expect(running.batches).toEqual([]);

      w.clock.advance(wait);
      await idle(w, running);
      expect(lists(w.gh)).toEqual([iso(NOW - MINUTE - 1000), iso(NOW - MINUTE - 1000)]);
      expect(running.batches).toEqual([["7"]]);
      expect(w.clock.pending()).toEqual([NOW + wait + POLL_INTERVAL_MS]);
      expect(running.ended).toBe(false);
      running.stop.abort();
      await running.done;
    }
  });

  it("throws SourceAccessLost on a refused token, a 403 that is not a rate limit and a repository GitHub does not show, in fixed words with the fix, never quoting GitHub nor holding any piece of the token", async () => {
    const refused = await world({ token: `${TOKEN}x` });
    const lost = await run(refused).done;
    expect(lost instanceof Error && lost.name).toBe("SourceAccessLost");
    expect((lost as Error).message).toBe(
      `github issues source on ${REPO}: GitHub does not accept the token (status 401) for listing the issues and pull requests updated since ${iso(NOW - START_MARGIN_MS - 1000)}; put a valid token in the variable plugins.github.token names: a fine-grained token with Issues and Pull requests read on the repository (a classic token with the repo scope, or public_repo for a public repository); the source is tried again by itself, so a token restored is picked up without a restart`,
    );
    expect(leaks(lost, `${TOKEN}x`)).toEqual([]);
    expect(Object.hasOwn(lost as object, "cause")).toBe(false);

    const forbidden = await world();
    forbidden.gh.script(() =>
      json(403, { message: "Resource not accessible by personal access token" }),
    );
    const denied = (await run(forbidden).done) as Error;
    expect(denied.name).toBe("SourceAccessLost");
    expect(denied.message).toContain(
      "the token is not allowed to list the repository's issues and pull requests (status 403)",
    );
    expect(denied.message).not.toContain("Resource not accessible");
    expect(denied.message).toContain("Issues and Pull requests read on the repository");

    const unseen = await world();
    unseen.gh.script(() => json(404, { message: "Not Found" }));
    const missing = (await run(unseen).done) as Error;
    expect(missing.name).toBe("SourceAccessLost");
    expect(missing.message).toContain(
      "GitHub answers 404 to listing the issues and pull requests updated since",
    );
    expect(missing.message).toContain(`the token cannot see the repository ${REPO}`);
    expect(missing.message).not.toContain("Not Found");

    // GitHub's body is never quoted, whatever it holds (rest.ts's rule).
    const echoed = await world();
    echoed.gh.script(() => json(401, { message: `BODY-TEXT Bearer ${TOKEN}` }));
    const quiet = (await run(echoed).done) as Error;
    expect(quiet.name).toBe("SourceAccessLost");
    expect(quiet.message).not.toContain("BODY-TEXT");
    expect(leaks(quiet)).toEqual([]);

    for (const w of [refused, forbidden, unseen, echoed]) {
      expect(w.lines).toEqual([]);
      expect(w.saved.saves).toEqual([iso(NOW - START_MARGIN_MS)]);
    }
  });

  it("@timing says a 5xx or a failed network in one line and lists again at the next poll, from the cursor it saved", async () => {
    const answers: readonly (() => Promise<Response>)[] = [
      () => Promise.resolve(json(502, { message: `Bad gateway for ${TOKEN}` })),
      () => Promise.reject(new TypeError(`fetch failed: Bearer ${TOKEN}`)),
    ];
    const words = [
      "GitHub answered 502, a failure on its side",
      "GitHub could not be reached (the network failed, GitHub did not answer within 10 seconds, or it answered with a redirect, which is never followed: a renamed repository redirects, so check the source's repo)",
    ];
    for (const [index, answer] of answers.entries()) {
      const w = await world();
      w.saved.value = iso(NOW - MINUTE);
      let failed = false;
      w.gh.script(() => {
        if (failed) {
          return undefined;
        }
        failed = true;
        return answer();
      });
      const running = run(w);
      await idle(w, running);
      expect(w.lines).toEqual([
        `github issues source on ${REPO}: the poll could not list the issues updated since ${iso(NOW - MINUTE - 1000)}: ${words[index]}; it tries again at ${iso(NOW + POLL_INTERVAL_MS)}`,
      ]);
      expect(leaks(w.lines.join("\n"))).toEqual([]);
      expect(w.clock.pending()).toEqual([NOW + POLL_INTERVAL_MS]);

      w.gh.issue(REPO, 7, { updatedAt: iso(NOW + MINUTE) });
      w.clock.advance(POLL_INTERVAL_MS);
      await idle(w, running);
      expect(lists(w.gh)).toEqual([iso(NOW - MINUTE - 1000), iso(NOW - MINUTE - 1000)]);
      expect(running.batches).toEqual([["7"]]);
      expect(running.ended).toBe(false);
      running.stop.abort();
      await running.done;
    }
  });

  it("fails the poll on a request GitHub refuses as asked (a 422), with no line: asking again would change nothing", async () => {
    const w = await world();
    w.saved.value = iso(NOW - MINUTE);
    w.gh.script(() => json(422, { message: "Validation Failed" }));
    const failed = await run(w).done;
    expect(failed instanceof GithubActionError && failed.status).toBe(422);
    expect(w.lines).toEqual([]);
    expect(w.gh.requests).toHaveLength(1);
  });

  it("never yields a key of another repository: such a page, or one out of the order asked, fails the poll with nothing of it yielded and the cursor kept", async () => {
    const item = (number: number, updatedAt: string, repo = REPO) => ({
      number,
      title: "x",
      body: null,
      labels: [],
      updated_at: updatedAt,
      repository_url: `https://api.github.com/repos/${repo}`,
    });
    const pages: readonly (readonly unknown[])[] = [
      [item(7, iso(NOW - 30_000)), item(8, iso(NOW - 20_000), "someone/else")],
      [item(7, iso(NOW - 20_000)), item(8, iso(NOW - 30_000))],
      [item(7, iso(NOW - 2 * MINUTE))],
      [item(7, "2026-11-14 11:59:30")],
      [{ number: "7", updated_at: iso(NOW) }],
    ];
    const words = [
      "holds an issue of another repository",
      "out of the order asked",
      "holds an issue changed before since",
      "with no time of change FacetDB can read",
      "holds an item that is not an issue FacetDB can read",
    ];
    for (const [index, page] of pages.entries()) {
      const w = await world();
      w.saved.value = iso(NOW - MINUTE);
      w.gh.script(() => json(200, page));
      const failed = await run(w).done;
      expect(failed instanceof GithubActionError).toBe(true);
      expect((failed as Error).message).toContain(words[index]);
      expect(w.saved.saves).toEqual([]);
      expect(w.lines).toEqual([]);
    }
    const w = await world();
    w.saved.value = iso(NOW - MINUTE);
    w.gh.script(() => json(200, { items: [] }));
    expect(((await run(w).done) as Error).message).toContain("is not the list FacetDB asked for");
  });
});

/** The cursor's key in the store for the adapter's source. */
const RUN = "plugin-source:test";

/**
 * The SDK's adapter over the world's source, as the worker runs it, on an in-memory store and
 * cursor store: `log` says, in order, each record stored (`queued 7`, `unchanged 7`) and each
 * cursor saved (`saved …`).
 */
function adapterWorld(w: World) {
  const log: string[] = [];
  const states = new Map<string, string>();
  const unused = () => Promise.reject(new Error("not used here"));
  const store: RecordStore = {
    capabilities: {
      inlineColumns: false,
      pushWakeup: false,
      transactions: true,
      sideTable: false,
      multipleWorkers: true,
    },
    install: () => Promise.resolve(),
    uninstall: () => Promise.resolve(),
    watch: async function* () {},
    read: unused,
    write: unused,
    current: unused,
    scan: unused,
    enqueue: unused,
    claim: unused,
    claimKey: unused,
    ack: unused,
    release: unused,
    upsertRecord(key, state) {
      const changed = states.get(key) !== JSON.stringify(state);
      states.set(key, JSON.stringify(state));
      log.push(`${changed ? "queued" : "unchanged"} ${key}`);
      return Promise.resolve(changed);
    },
  };
  const cursors = new Map<string, { readonly cursor: string | null; readonly done: boolean }>();
  const notes: string[] = [];
  const adapter = () =>
    createPluginSourceConnector({
      store,
      name: "issues",
      hosted: w.hosted,
      context: (signal) => w.host.contextFor("@facetdb/github", signal),
      fields: FIELDS,
      clock: w.clock,
      cursors: {
        load: (key) => Promise.resolve(cursors.get(key)),
        save: (key, progress) => {
          cursors.set(key, progress);
          log.push(`saved ${progress.cursor}`);
          return Promise.resolve();
        },
      },
      cursorRun: RUN,
      note: (line) => notes.push(line),
    });
  return { adapter, log, cursors, notes };
}

describe("reconcile: through the SDK's adapter", () => {
  it("@timing saves the cursor once the page's keys were taken in, and a worker started again goes on from it", async () => {
    const w = await world();
    const { adapter, log, notes } = adapterWorld(w);
    const start = iso(NOW - START_MARGIN_MS);

    const first = adapter();
    const queued = first.watch()[Symbol.asyncIterator]();
    const next = queued.next();
    await idle(w);
    expect(log).toEqual([`saved ${start}`]);

    w.gh.issue(REPO, 7, { title: "Typo in README", updatedAt: iso(NOW + MINUTE) });
    w.clock.advance(POLL_INTERVAL_MS);
    expect((await next).value).toEqual(["7"]);
    await idle(w);
    // Read and stored first; the cursor only then.
    expect(log).toEqual([`saved ${start}`, "queued 7", `saved ${iso(NOW + MINUTE)}`]);
    await first.close();
    expect(w.clock.pending()).toEqual([]);

    // Down for 25 minutes, during which issue 8 changes and its webhook delivery is lost.
    w.gh.issue(REPO, 8, { updatedAt: iso(NOW + 10 * MINUTE) });
    w.clock.advance(25 * MINUTE);
    log.length = 0;
    const second = adapter();
    const resumed = second.watch()[Symbol.asyncIterator]();
    expect((await resumed.next()).value).toEqual(["8"]);
    await idle(w);
    // From the saved cursor's second: 7 read again and unchanged, 8 found.
    expect(log).toEqual(["unchanged 7", "queued 8", `saved ${iso(NOW + 10 * MINUTE)}`]);
    expect(lists(w.gh).at(-1)).toBe(iso(NOW + MINUTE - 1000));
    expect(notes).toEqual([]);
    expect(w.lines).toEqual([]);
    await second.close();
    expect(w.clock.pending()).toEqual([]);
  });

  it("@timing reads and queues a second change GitHub stamps in the second of one already read, its delivery lost", async () => {
    // The worker lists at 12:00:00.4; issue 5 changed at 12:00:00.1.
    const w = await world({ start: NOW + 400 });
    const { adapter, log, cursors } = adapterWorld(w);
    cursors.set(RUN, { cursor: iso(NOW - MINUTE), done: true });
    const five = w.gh.issue(REPO, 5, { title: "Login loops after SSO", updatedAt: iso(NOW) });
    const source = adapter();
    const queued = source.watch()[Symbol.asyncIterator]();
    expect((await queued.next()).value).toEqual(["5"]);
    await idle(w);
    expect(log).toEqual(["queued 5", `saved ${iso(NOW)}`]);

    // A bot labels it at 12:00:00.9: GitHub stamps 12:00:00 again, and the delivery is lost.
    five.labels = ["needs-triage"];
    const next = queued.next();
    w.clock.advance(POLL_INTERVAL_MS);
    expect((await next).value).toEqual(["5"]);
    await idle(w);
    // Its new state is read and queued: the decision is asked again on what the issue says now.
    expect(log).toEqual(["queued 5", `saved ${iso(NOW)}`, "queued 5"]);

    // An idle poll after: one list, no read.
    const requests = w.gh.requests.length;
    w.clock.advance(POLL_INTERVAL_MS);
    await idle(w);
    expect(w.gh.requests.length).toBe(requests + 1);
    expect(log).toHaveLength(3);
    await source.close();
  });

  it("is said as lost access in the worker's own words when the token is refused, the plugin's words never shown", async () => {
    const w = await world({ token: `${TOKEN}x` });
    const { adapter } = adapterWorld(w);
    const source = adapter();
    let failure: unknown;
    try {
      for await (const _ of source.watch()) {
        // Nothing is queued: the first list is refused.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error && failure.name).toBe("SourceAccessLost");
    const words = (failure as Error).message;
    expect(words).toContain("lost access");
    expect(words).toContain(VARIABLE);
    expect(words).not.toContain("status 401");
    expect(leaks(failure, `${TOKEN}x`)).toEqual([]);
    await source.close();
  });
});
