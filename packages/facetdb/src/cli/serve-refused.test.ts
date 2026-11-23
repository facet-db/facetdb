import { connect, type Socket } from "node:net";
import { FakeClock } from "@facetdb/core/testing";
import { BODY_MAX_BYTES, HOOK_BODY_MAX_BYTES, HOOK_READING_PER_ADDRESS } from "@facetdb/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpListener } from "./program.ts";
import { serveHttp } from "./serve.ts";

/**
 * The HTTP adapter's cap on every path and what follows a refusal, over bare sockets on this
 * machine's loopback address, so the test sees every byte the server writes and who closes the
 * connection: a body past 1 MB to a studio path or to `POST /v1/check` is answered 413, by its
 * declared length or as it grows, and the handler (where every login check lives) is never called;
 * a body under the cap runs as before; `Expect: 100-continue` past a cap is answered 413 with no
 * `100 Continue`; a request pipelined after a refused one (413, or a hook's 429) never reaches the
 * handler; a sender that declares a body past the cap and never ends is closed when the linger
 * passes, as is a refused connection whose answer waits behind an earlier pipelined one.
 */

/** A linger short enough that a refused connection is closed within the test. */
const SHORT_LINGER_MS = 50;
/** A deadline past the package's 30-second test timeout: never seen to pass. */
const LONG_MS = 60_000;

let listener: HttpListener | undefined;
const opened: Socket[] = [];
/** Lets go of a handler a test left hanging. */
let unhang = (): void => {};

afterEach(async () => {
  unhang();
  for (const socket of opened.splice(0)) {
    socket.destroy();
  }
  await listener?.close();
  listener = undefined;
});

/**
 * A server over a handler that notes each request's path the moment it is called, before reading
 * its body; `hang` leaves every `/v1/check` unanswered until the test ends.
 */
async function serve(
  options: { readonly lingerMs?: number; readonly hang?: boolean } = {},
): Promise<{ readonly port: number; readonly calls: string[] }> {
  const calls: string[] = [];
  const hung = new Promise<void>((done) => {
    unhang = done;
  });
  listener = await serveHttp(
    async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (options.hang === true && path === "/v1/check") {
        await hung;
      }
      const body = JSON.stringify({ bytes: (await request.arrayBuffer()).byteLength });
      // Its length declared, as the refusals' are, so the bare socket reads it without chunking.
      return new Response(body, {
        status: 202,
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      });
    },
    0,
    "127.0.0.1",
    {
      // A clock that stands still: these few hooks are far inside the rate limits.
      clock: new FakeClock(1_000_000),
      bodyDeadlineMs: LONG_MS,
      ...(options.lingerMs === undefined ? {} : { lingerMs: options.lingerMs }),
    },
  );
  return { port: listener.port, calls };
}

type Answer = {
  readonly status: number;
  readonly code: string | undefined;
  readonly bytes: number;
};

/**
 * A connection that this side never closes: `statuses` is every status line the server
 * wrote, `100` included, in order; `handled` resolves on the first of them (the request's headers
 * were admitted or refused), `answer` on the first final answer whole, `closed` when the server has
 * closed its end, and `errors` holds what the connection met.
 */
type Wire = {
  readonly socket: Socket;
  readonly statuses: number[];
  readonly handled: Promise<void>;
  readonly answer: Promise<Answer>;
  readonly closed: Promise<void>;
  readonly errors: Error[];
};

function wire(port: number): Wire {
  const socket = connect({ port, host: "127.0.0.1" });
  opened.push(socket);
  const errors: Error[] = [];
  const statuses: number[] = [];
  socket.on("error", (error) => errors.push(error));
  // Its end heard, or the connection gone (a reset is no end, and `errors` tells it apart).
  const closed = new Promise<void>((done) => {
    socket.once("end", () => done());
    socket.once("close", () => done());
  });
  let heard = (): void => {};
  const handled = new Promise<void>((done) => {
    heard = done;
  });
  const answer = new Promise<Answer>((resolve) => {
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
        const length = Number(
          lines.find((line) => line.toLowerCase().startsWith("content-length:"))?.slice(15) ?? 0,
        );
        if (received.byteLength < split + 4 + length) {
          return;
        }
        const body = received.subarray(split + 4, split + 4 + length).toString("utf8");
        received = received.subarray(split + 4 + length);
        statuses.push(status);
        heard();
        if (status !== 100) {
          const json = JSON.parse(body) as { error?: { code?: string }; bytes?: number };
          resolve({ status, code: json.error?.code, bytes: json.bytes ?? 0 });
        }
      }
    });
  });
  return { socket, statuses, handled, answer, closed, errors };
}

/** A POST's head, framed by `content-length: <n>` or chunked, with `extra` header lines. */
const head = (path: string, framing: number | "chunked", extra = ""): string =>
  `POST ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n${
    framing === "chunked" ? "transfer-encoding: chunked" : `content-length: ${framing}`
  }\r\n${extra}\r\n`;

/** A whole chunked body of `size` bytes, its last chunk written. */
const chunked = (size: number): Buffer =>
  Buffer.concat([
    Buffer.from(`${size.toString(16)}\r\n`),
    Buffer.alloc(size, 0x61),
    Buffer.from("\r\n0\r\n\r\n"),
  ]);

/** A small request that would run if the handler were handed it. */
const pipelined = `${head("/v1/check", 2)}{}`;

describe("serveHttp refuses a body past its path's cap before the handler, and runs nothing more on its connection (serve-refused)", () => {
  it("answers a body past 1 MB to a studio path and to POST /v1/check 413, declared or grown, and never calls the handler", async () => {
    const { port, calls } = await serve();
    for (const path of ["/v1/session", "/v1/apply", "/v1/check"]) {
      // Declared: answered on the headers, before a byte of the body is sent.
      const declared = wire(port);
      declared.socket.write(head(path, BODY_MAX_BYTES + 1));
      expect(await declared.answer, `${path} declared`).toEqual({
        status: 413,
        code: "request_too_large",
        bytes: 0,
      });

      // Grown: chunked, no length declared, one byte past the cap.
      const grown = wire(port);
      grown.socket.write(head(path, "chunked"));
      grown.socket.write(chunked(BODY_MAX_BYTES + 1));
      expect(await grown.answer, `${path} grown`).toEqual({
        status: 413,
        code: "request_too_large",
        bytes: 0,
      });
      // The sender ended its body: the server closes the connection, and reads nothing more.
      await grown.closed;
      expect(grown.errors, `${path} grown`).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it("hands a body at or under 1 MB to the handler as before, an Expect: 100-continue one after its 100", async () => {
    const { port, calls } = await serve();
    const atCap = wire(port);
    atCap.socket.write(head("/v1/check", BODY_MAX_BYTES));
    atCap.socket.write(Buffer.alloc(BODY_MAX_BYTES, 0x61));
    expect(await atCap.answer).toEqual({ status: 202, code: undefined, bytes: BODY_MAX_BYTES });

    const expecting = wire(port);
    expecting.socket.write(head("/v1/apply", 2, "expect: 100-continue\r\n"));
    await expecting.handled;
    expecting.socket.write("{}");
    expect(await expecting.answer).toEqual({ status: 202, code: undefined, bytes: 2 });
    expect(expecting.statuses).toEqual([100, 202]);
    expect(calls).toEqual(["/v1/check", "/v1/apply"]);
  });

  it("answers Expect: 100-continue past the cap 413 with no 100 Continue, on any path and on a hook", async () => {
    const { port, calls } = await serve();
    for (const [path, length, code] of [
      ["/v1/check", BODY_MAX_BYTES + 1, "request_too_large"],
      ["/v1/hooks/github/issues", HOOK_BODY_MAX_BYTES + 1, "body_too_large"],
    ] as const) {
      const expecting = wire(port);
      expecting.socket.write(head(path, length, "expect: 100-continue\r\n"));
      expect((await expecting.answer).code, path).toBe(code);
      // A 100 comes before the final answer or never: the 413 was the first word.
      expect(expecting.statuses, path).toEqual([413]);
    }
    expect(calls).toEqual([]);
  });

  it("never hands the handler a request pipelined after a refused one: a 413 declared or grown, and a hook's 429", async () => {
    const { port, calls } = await serve();

    // Declared past the cap, its body sent all the same, then a request on the same connection.
    const declared = wire(port);
    declared.socket.write(head("/v1/check", BODY_MAX_BYTES + 1));
    declared.socket.write(Buffer.alloc(BODY_MAX_BYTES + 1, 0x61));
    declared.socket.write(pipelined);
    expect((await declared.answer).status).toBe(413);
    await declared.closed;

    // Grown past the cap, its last chunk and the next request in one write.
    const grown = wire(port);
    grown.socket.write(head("/v1/apply", "chunked"));
    grown.socket.write(Buffer.concat([chunked(BODY_MAX_BYTES + 1), Buffer.from(pipelined)]));
    expect((await grown.answer).status).toBe(413);
    await grown.closed;

    // A hook refused on its headers (429: this address already has its bodies being read).
    const holding: Wire[] = [];
    for (let at = 0; at < HOOK_READING_PER_ADDRESS; at += 1) {
      const one = wire(port);
      one.socket.write(head("/v1/hooks/github/issues", 64, "expect: 100-continue\r\n"));
      await one.handled;
      expect(one.statuses).toEqual([100]);
      holding.push(one);
    }
    const limited = wire(port);
    limited.socket.write(`${head("/v1/hooks/github/issues", 2)}{}${pipelined}`);
    expect((await limited.answer).status).toBe(429);
    await limited.closed;

    // Each connection answered its refusal alone: nothing after it ran, nor was answered.
    expect([declared.statuses, grown.statuses, limited.statuses]).toEqual([[413], [413], [429]]);
    expect(calls).toEqual([]);
  });

  it("@timing closes a sender that declares a body past 1 MB and never ends, once a short linger passes", async () => {
    const { port, calls } = await serve({ lingerMs: SHORT_LINGER_MS });
    const stalled = wire(port);
    stalled.socket.write(head("/v1/check", BODY_MAX_BYTES + 1));
    stalled.socket.write(Buffer.alloc(1024, 0x61));

    expect((await stalled.answer).status).toBe(413);
    // The server, not this side, closed the connection; what was sent had all been read.
    await stalled.closed;
    expect(stalled.errors).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("@timing destroys a refused connection when the linger passes, though its 413 waits behind an earlier pipelined answer", async () => {
    // The first request's handler never answers, so the 413 queued behind it is never written.
    const { port, calls } = await serve({ lingerMs: SHORT_LINGER_MS, hang: true });
    const queued = wire(port);
    queued.socket.write(`${pipelined}${head("/v1/hooks/github/issues", HOOK_BODY_MAX_BYTES + 1)}`);

    await queued.closed;
    expect(queued.statuses).toEqual([]);
    expect(calls).toEqual(["/v1/check"]);
  });
});
