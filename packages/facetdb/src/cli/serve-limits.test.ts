import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { FakeClock } from "@facetdb/core/testing";
import {
  HOOK_ADDRESS_BURST,
  HOOK_BODIES_AT_ONCE,
  HOOK_BODY_MAX_BYTES,
  HOOK_READING_PER_ADDRESS,
  HOOK_SOURCE_BURST,
} from "@facetdb/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpListener } from "./program.ts";
import { serveHttp } from "./serve.ts";

/**
 * The hook route's limits in the HTTP adapter, over real sockets on this machine's loopback
 * addresses (127.0.0.2 and on are other senders), on a clock that stands still so a burst never
 * earns a token back: the 101st hook from one address is answered 429 with `retry-after` on its
 * headers, the handler never called and none of its body read; another address and another source
 * still answer; behind a proxy on this machine the source's limit holds alone; one address holds at
 * most 2 of the bodies read at once; a 9th body read at once is refused until a slot is freed, by
 * the sender closing, by a 413 or by a 408 (each while the refused connection still lingers, so the
 * refusal itself freed it); and a sender that sends its headers and stops is answered 408 and
 * closed after the deadline and the linger.
 */

/** A deadline short enough to pass within a test, long enough for a small body sent at once. */
const SHORT_DEADLINE_MS = 1000;
/** A linger short enough that a stalled sender is closed within the test. */
const SHORT_LINGER_MS = 50;
/** A deadline or a linger past the package's 30-second test timeout: never seen to pass. */
const LONG_MS = 60_000;

type Seen = { readonly url: string; readonly body: string };

let listener: HttpListener | undefined;
const opened: Socket[] = [];

afterEach(async () => {
  for (const socket of opened.splice(0)) {
    socket.destroy();
  }
  await listener?.close();
  listener = undefined;
});

async function serve(
  options: { readonly bodyDeadlineMs?: number; readonly lingerMs?: number } = {},
): Promise<{ readonly port: number; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  listener = await serveHttp(
    async (request) => {
      seen.push({ url: request.url, body: await request.text() });
      return Response.json({ ok: true }, { status: 202 });
    },
    0,
    "127.0.0.1",
    { clock: new FakeClock(1_000_000), ...options },
  );
  return { port: listener.port, seen };
}

type Answer = {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly requestId: string | undefined;
  readonly body: string;
};

/** A whole request on a connection of its own from `from`: its answer. */
function send(
  port: number,
  path: string,
  options: {
    readonly from?: string;
    readonly headers?: OutgoingHttpHeaders;
    readonly body?: string;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        localAddress: options.from ?? "127.0.0.1",
        headers: { ...options.headers },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const header = (name: string): string | undefined => {
            const value = response.headers[name];
            return typeof value === "string" ? value : undefined;
          };
          resolve({
            status: response.statusCode ?? 0,
            retryAfter: header("retry-after"),
            requestId: header("x-request-id"),
            body: Buffer.concat(parts).toString("utf8"),
          });
        });
      },
    );
    sent.on("error", reject);
    sent.end(options.body ?? "{}");
  });
}

/**
 * A request over a bare socket that sends its head (and `start` of its body) and then waits:
 * unlike `node:http`'s client it leaves the connection to the server, so the test sees who closes
 * it. `continued` resolves on the server's `100 Continue` (asked by an `expect` header): `node:http`
 * writes it on the request's headers and calls the server's handler in the same turn, so by then
 * the request has been admitted or refused. `answer` is the first final answer, `closed` the server
 * closing its end, `errors` what the connection met; `seen` says whether each has happened yet.
 */
type Stalled = {
  readonly socket: Socket;
  readonly continued: Promise<void>;
  readonly answer: Promise<Answer>;
  readonly closed: Promise<void>;
  readonly errors: Error[];
  readonly seen: { answered: boolean; closed: boolean };
};

function stall(
  port: number,
  options: { readonly from?: string; readonly headers: string; readonly start?: string },
): Stalled {
  const socket = connect({ port, host: "127.0.0.1", localAddress: options.from ?? "127.0.0.1" });
  opened.push(socket);
  const errors: Error[] = [];
  const seen = { answered: false, closed: false };
  socket.on("error", (error) => errors.push(error));
  const closed = new Promise<void>((done) => {
    const heard = (): void => {
      seen.closed = true;
      done();
    };
    socket.once("end", heard);
    socket.once("close", heard);
  });
  let heardContinue = (): void => {};
  const continued = new Promise<void>((done) => {
    heardContinue = done;
  });
  const answer = new Promise<Answer>((resolve, reject) => {
    let received = Buffer.alloc(0);
    socket.on("data", (part: Buffer) => {
      received = Buffer.concat([received, part]);
      for (;;) {
        const split = received.indexOf("\r\n\r\n");
        if (split < 0) {
          return;
        }
        const [statusLine = "", ...lines] = received
          .subarray(0, split)
          .toString("latin1")
          .split("\r\n");
        const status = Number(statusLine.split(" ")[1]);
        if (status === 100) {
          heardContinue();
          received = received.subarray(split + 4);
          continue;
        }
        const headers = new Map(
          lines.map((line) => {
            const colon = line.indexOf(":");
            return [
              line.slice(0, colon).trim().toLowerCase(),
              line.slice(colon + 1).trim(),
            ] as const;
          }),
        );
        const body = received.subarray(split + 4);
        if (body.byteLength < Number(headers.get("content-length"))) {
          return;
        }
        seen.answered = true;
        resolve({
          status,
          retryAfter: headers.get("retry-after"),
          requestId: headers.get("x-request-id"),
          body: body.toString("utf8"),
        });
        return;
      }
    });
    socket.on("error", reject);
  });
  socket.write(`${options.headers}\r\n${options.start ?? ""}`);
  return { socket, continued, answer, closed, errors, seen };
}

const hookHead = (path: string, length: number, extra = ""): string =>
  `POST ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${length}\r\n${extra}`;

/** A request id as the app makes one: a UUID. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a stalled sender declares: its start and the rest together. */
const STALLED_LENGTH = 64;

/**
 * `count` senders that send their headers (and `start` of a `STALLED_LENGTH` body) and stop, each
 * handled before the next opens; from `from(at)`, by default an address of its own each.
 */
async function stallMany(
  port: number,
  options: {
    readonly count?: number;
    readonly start?: string;
    readonly from?: (at: number) => string;
  } = {},
): Promise<Stalled[]> {
  const stalled: Stalled[] = [];
  for (let at = 0; at < (options.count ?? HOOK_BODIES_AT_ONCE); at += 1) {
    const one = stall(port, {
      from: options.from?.(at) ?? `127.0.1.${at + 1}`,
      headers: hookHead("/v1/hooks/github/issues", STALLED_LENGTH, "expect: 100-continue\r\n"),
      start: options.start ?? "",
    });
    await one.continued;
    stalled.push(one);
  }
  return stalled;
}

/** The rest of a stalled sender's body after `start`: its request ends, and the server closes. */
function finish(one: Stalled, start: string): void {
  one.socket.write("x".repeat(STALLED_LENGTH - start.length));
}

describe("serveHttp limits a plugin source's webhook before it reads a body (serve-limits)", () => {
  it("answers the 101st hook from one address 429 with retry-after on its headers, the handler never seeing it, and other addresses still answer", async () => {
    const { port, seen } = await serve();
    for (let at = 0; at < HOOK_ADDRESS_BURST; at += 1) {
      const answer = await send(port, "/v1/hooks/github/issues", { body: `{"n":${at}}` });
      expect(answer.status).toBe(202);
    }
    expect(seen).toHaveLength(HOOK_ADDRESS_BURST);

    // The 101st declares a body and sends none of it: the answer comes on its headers alone.
    const refused = stall(port, { headers: hookHead("/v1/hooks/github/issues", 21) });
    const answer = await refused.answer;
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBe("1");
    expect(answer.requestId).toMatch(REQUEST_ID);
    expect(JSON.parse(answer.body)).toMatchObject({
      error: { code: "too_many_deliveries", fix: "Send the delivery again after 1 second." },
    });
    // Its body, written after the answer, is read and dropped, and the connection closed on its end.
    refused.socket.write('{"refused-body":true}');
    await refused.closed;
    expect(refused.errors).toEqual([]);
    expect(seen).toHaveLength(HOOK_ADDRESS_BURST);
    expect(seen.some((one) => one.body.includes("refused-body"))).toBe(false);

    // The same address is refused at any source; another address is not; nor is any other route.
    expect((await send(port, "/v1/hooks/github/pulls")).status).toBe(429);
    expect((await send(port, "/v1/hooks/github/issues", { from: "127.0.0.2" })).status).toBe(202);
    expect((await send(port, "/v1/check")).status).toBe(202);
    expect(seen.map((one) => new URL(one.url).pathname).slice(HOOK_ADDRESS_BURST)).toEqual([
      "/v1/hooks/github/issues",
      "/v1/check",
    ]);
  });

  it("behind a proxy on this machine, skips the address's limit and refuses the 201st to one source; another source still answers", async () => {
    const { port, seen } = await serve();
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let at = 0; at < HOOK_SOURCE_BURST; at += 1) {
      expect((await send(port, "/v1/hooks/github/issues", { headers })).status).toBe(202);
    }

    const refused = await send(port, "/v1/hooks/github/issues", { headers, body: '{"late":1}' });
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("1");
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "too_many_deliveries" } });
    expect((await send(port, "/v1/hooks/github/pulls", { headers })).status).toBe(202);
    expect(seen).toHaveLength(HOOK_SOURCE_BURST + 1);
    expect(seen.some((one) => one.body.includes("late"))).toBe(false);
  });

  it("lets one address's senders that send headers and stop hold 2 slots, refusing the rest, while another address is answered", async () => {
    const { port, seen } = await serve({ bodyDeadlineMs: LONG_MS, lingerMs: LONG_MS });
    const stalled = await stallMany(port, { from: () => "127.0.0.1" });

    // Without the per-address cap these eight would hold every slot, and this would be refused.
    expect((await send(port, "/v1/hooks/github/pulls", { from: "127.0.0.2" })).status).toBe(202);
    for (const one of stalled.slice(HOOK_READING_PER_ADDRESS)) {
      const answer = await one.answer;
      expect(answer.status).toBe(429);
      expect(answer.retryAfter).toBe("1");
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "too_many_deliveries" } });
    }
    expect(stalled.map((one) => one.seen.answered)).toEqual(
      stalled.map((_, at) => at >= HOOK_READING_PER_ADDRESS),
    );
    // The rest of the slots still serve other addresses, as many as are left.
    const others = await stallMany(port, {
      count: HOOK_BODIES_AT_ONCE - HOOK_READING_PER_ADDRESS,
      from: (at) => `127.0.3.${at + 1}`,
    });
    expect(others.map((one) => one.seen.answered)).toEqual(others.map(() => false));
    expect((await send(port, "/v1/hooks/github/pulls", { from: "127.0.4.1" })).status).toBe(429);
    expect(seen.map((one) => new URL(one.url).pathname)).toEqual(["/v1/hooks/github/pulls"]);
  });

  it("refuses a 9th hook body read at once, and frees a slot when its sender closes the connection", async () => {
    // A deadline and a linger past the test's timeout: only the sender's closing frees a slot here.
    const { port, seen } = await serve({ bodyDeadlineMs: LONG_MS, lingerMs: LONG_MS });
    const stalled = await stallMany(port);

    const ninth = await send(port, "/v1/hooks/github/pulls", { from: "127.0.2.1" });
    expect(ninth.status).toBe(429);
    expect(ninth.retryAfter).toBe("1");
    expect(JSON.parse(ninth.body)).toMatchObject({ error: { code: "too_many_deliveries" } });

    // The sender gives up mid-body; the server, hearing it, closes the connection, slot freed first.
    const gaveUp = stalled[0];
    gaveUp?.socket.end();
    await gaveUp?.closed;
    expect((await send(port, "/v1/hooks/github/pulls", { from: "127.0.2.1" })).status).toBe(202);
    expect(seen.map((one) => new URL(one.url).pathname)).toEqual(["/v1/hooks/github/pulls"]);
  });

  it("@timing answers senders that send headers and stop 408 after the deadline, each slot freed while its connection still lingers", async () => {
    // A linger past the test's timeout: the server keeps every refused connection open, so only
    // the 408 itself can have freed the slots.
    const { port, seen } = await serve({ bodyDeadlineMs: SHORT_DEADLINE_MS, lingerMs: LONG_MS });
    const start = '{"partial":';
    const stalled = await stallMany(port, { start });

    for (const one of stalled) {
      const answer = await one.answer;
      expect(answer.status).toBe(408);
      expect(answer.requestId).toMatch(REQUEST_ID);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "body_too_slow" } });
    }
    expect(stalled.map((one) => one.seen.closed)).toEqual(stalled.map(() => false));
    const next = await send(port, "/v1/hooks/github/issues", { from: "127.0.2.1" });
    expect(next.status).toBe(202);
    expect(seen.map((one) => one.body)).toEqual(["{}"]);

    // A sender that ends its body after all has its connection closed, cleanly, and nothing read.
    for (const one of stalled) {
      finish(one, start);
      await one.closed;
      expect(one.errors).toEqual([]);
    }
    expect(seen).toHaveLength(1);
  });

  it("@timing closes a sender that sends its headers and never ends, once the deadline and the linger have passed", async () => {
    const { port, seen } = await serve({
      bodyDeadlineMs: SHORT_DEADLINE_MS,
      lingerMs: SHORT_LINGER_MS,
    });
    const [stalled] = await stallMany(port, { count: 1, start: '{"partial":' });
    expect((await stalled?.answer)?.status).toBe(408);
    await stalled?.closed;
    expect(stalled?.errors).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("frees a slot on each 413, declared or grown past the cap, while its connection still lingers", async () => {
    const { port, seen } = await serve({ bodyDeadlineMs: LONG_MS, lingerMs: LONG_MS });
    await stallMany(port, { count: HOOK_BODIES_AT_ONCE - 1 });

    const declared = stall(port, {
      from: "127.0.3.1",
      headers: hookHead("/v1/hooks/github/issues", HOOK_BODY_MAX_BYTES + 1),
    });
    expect((await declared.answer).status).toBe(413);
    // The eighth slot is free again although the refused connection is open.
    expect((await send(port, "/v1/hooks/github/pulls", { from: "127.0.2.1" })).status).toBe(202);

    const past = HOOK_BODY_MAX_BYTES + 1;
    const grown = stall(port, {
      from: "127.0.3.2",
      headers:
        "POST /v1/hooks/github/issues HTTP/1.1\r\nhost: 127.0.0.1\r\ntransfer-encoding: chunked\r\n",
      start: `${past.toString(16)}\r\n${"a".repeat(past)}\r\n`,
    });
    expect((await grown.answer).status).toBe(413);
    expect((await send(port, "/v1/hooks/github/pulls", { from: "127.0.2.2" })).status).toBe(202);
    expect([declared.seen.closed, grown.seen.closed]).toEqual([false, false]);
    expect(seen).toHaveLength(2);
  });
});
