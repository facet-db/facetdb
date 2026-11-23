import { type ClientRequest, request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { FakeClock } from "@facetdb/core/testing";
import { HOOK_BODY_MAX_BYTES } from "@facetdb/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpListener } from "./program.ts";
import { serveHttp } from "./serve.ts";

/**
 * The HTTP adapter's cap on a plugin source's webhook, over a real socket on this machine's
 * loopback address: a hook's body past 5 MB is answered 413, with a request id, as soon as its
 * declared length or the bytes received say so, and the answer reaches a sender that is still
 * writing; the handler never sees the body, the server reads and drops the rest until the sender
 * ends or the linger passes, then closes the connection (a write after it fails); a body at the
 * cap, and a body of any size on another path, reach the handler whole as before.
 */

const MiB = 1024 * 1024;

/** A linger short enough that a sender who never ends is closed within the test. */
const SHORT_LINGER_MS = 50;
/** A linger past the package's 30-second test timeout: a test using it never sees it pass. */
const LONG_LINGER_MS = 60_000;

type Seen = { readonly url: string; readonly body: Uint8Array };

let listener: HttpListener | undefined;
/** Every request and socket a test opened, ended after it whatever became of it. */
const opened: (ClientRequest | Socket)[] = [];

afterEach(async () => {
  for (const sent of opened.splice(0)) {
    sent.destroy();
  }
  await listener?.close();
  listener = undefined;
});

async function serve(lingerMs?: number): Promise<{ readonly port: number; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  listener = await serveHttp(
    async (request) => {
      seen.push({ url: request.url, body: new Uint8Array(await request.arrayBuffer()) });
      return Response.json({ ok: true }, { status: 202 });
    },
    0,
    "127.0.0.1",
    // A clock that stands still: these few hooks are far inside the rate limits.
    { clock: new FakeClock(), ...(lingerMs === undefined ? {} : { lingerMs }) },
  );
  return { port: listener.port, seen };
}

type Answer = {
  readonly status: number;
  readonly body: string;
  readonly requestId: string | undefined;
  /** The request, left open by this side: whether the server closed it is the test's to see. */
  readonly sent: ClientRequest;
};

/**
 * A POST whose body is streamed back to back, each chunk as soon as the last was flushed, with no
 * pause, then ended: the answer may arrive while the body is still going out, and the sender goes
 * on writing (it stops waiting on its writes once the answer is in). Once the answer has arrived, a
 * failed write is the refusal closing the connection, not the test's failure; before it, the test
 * fails. `end: false` leaves the body unfinished.
 */
function post(
  port: number,
  path: string,
  options: {
    readonly headers?: OutgoingHttpHeaders;
    readonly chunks: readonly Uint8Array[];
    readonly end?: boolean;
  },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // Set by the response's callback and read by the error listener, so a field, never narrowed.
    const answer = { arrived: false };
    let heard = (): void => {};
    const arrived = new Promise<void>((done) => {
      heard = done;
    });
    const sent = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...options.headers } },
      (response) => {
        answer.arrived = true;
        heard();
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const id = response.headers["x-request-id"];
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(parts).toString("utf8"),
            requestId: typeof id === "string" ? id : undefined,
            sent,
          });
        });
      },
    );
    opened.push(sent);
    sent.on("error", (error) => {
      if (!answer.arrived) {
        reject(error);
      }
    });
    // The headers go now, so a server that answers on them alone is heard before any body.
    sent.flushHeaders();
    void (async () => {
      for (const chunk of options.chunks) {
        if (sent.destroyed) {
          return;
        }
        await Promise.race([
          new Promise<void>((done) => {
            sent.write(chunk, () => done());
          }),
          arrived,
        ]);
      }
      if (options.end !== false && !sent.destroyed) {
        sent.end();
      }
    })();
  });
}

type RawAnswer = {
  readonly status: number;
  readonly body: string;
  readonly requestId: string | undefined;
};

/**
 * A chunked POST to a hook over a bare socket, its body begun with `chunks` and left unfinished:
 * unlike `node:http`'s client, which closes its own connection once a `connection: close` answer
 * has arrived, it leaves the connection to the server, so the test sees who closes it and what a
 * write after the answer meets. `answer` resolves once the answer has arrived whole, `closed` when
 * the server has closed its end, and `errors` holds every error the connection met. `halfOpen`
 * keeps this side writable after the server's end, as a sender that does not listen would.
 */
function postRaw(
  port: number,
  chunks: readonly Uint8Array[],
  halfOpen = false,
): {
  readonly socket: Socket;
  readonly answer: Promise<RawAnswer>;
  readonly closed: Promise<void>;
  readonly errors: Error[];
} {
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: halfOpen });
  opened.push(socket);
  const errors: Error[] = [];
  socket.on("error", (error) => errors.push(error));
  // Its end heard, or the connection gone (a reset is no end, and `errors` tells it apart).
  const closed = new Promise<void>((done) => {
    socket.once("end", () => done());
    socket.once("close", () => done());
  });
  const answer = new Promise<RawAnswer>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const read = (part: Buffer): void => {
      received = Buffer.concat([received, part]);
      const split = received.indexOf("\r\n\r\n");
      if (split < 0) {
        return;
      }
      const [statusLine = "", ...lines] = received
        .subarray(0, split)
        .toString("latin1")
        .split("\r\n");
      const headers = new Map(
        lines.map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const;
        }),
      );
      const body = received.subarray(split + 4);
      if (body.byteLength < Number(headers.get("content-length"))) {
        return;
      }
      resolve({
        status: Number(statusLine.split(" ")[1]),
        body: body.toString("utf8"),
        requestId: headers.get("x-request-id"),
      });
    };
    // Read to the end, so the server's closing is heard; a later resolve or reject is a no-op.
    socket.on("data", read);
    socket.on("error", reject);
  });
  socket.write(
    "POST /v1/hooks/github/issues HTTP/1.1\r\nhost: 127.0.0.1\r\ntransfer-encoding: chunked\r\n\r\n",
  );
  for (const chunk of chunks) {
    void writeChunk(socket, chunk);
  }
  return { socket, answer, closed, errors };
}

/** One chunk of a chunked body on a bare socket: what its write met once flushed. */
function writeChunk(socket: Socket, chunk: Uint8Array): Promise<Error | undefined> {
  socket.write(`${chunk.byteLength.toString(16)}\r\n`);
  socket.write(chunk);
  return new Promise((done) => {
    socket.write("\r\n", (error) => done(error ?? undefined));
  });
}

/**
 * Waits until the server has closed the request's connection, then writes once more: what that
 * write met. A connection the server kept open would leave this waiting, and the test timing out.
 */
async function writeAfterClose(sent: ClientRequest): Promise<unknown> {
  const socket = sent.socket;
  if (socket !== null && !socket.destroyed) {
    await new Promise<void>((done) => {
      socket.once("close", () => done());
    });
  }
  return new Promise((done) => {
    sent.write(new Uint8Array(16), (error) => done(error));
  });
}

/** A request id as the app makes one: a UUID. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const chunksOf = (total: number, size = MiB): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let left = total; left > 0; left -= size) {
    chunks.push(new Uint8Array(Math.min(size, left)).fill(0x61));
  }
  return chunks;
};

describe("serveHttp caps a plugin source's webhook at 5 MB (serve)", () => {
  it("answers a declared length past the cap 413 at once, reading none of the body", async () => {
    const { port, seen } = await serve(SHORT_LINGER_MS);

    const answer = await post(port, "/v1/hooks/github/issues", {
      headers: { "content-length": String(HOOK_BODY_MAX_BYTES + 1) },
      chunks: [],
      end: false,
    });

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "body_too_large" } });
    expect(answer.requestId).toMatch(REQUEST_ID);
    expect(seen).toEqual([]);
    // The server closed the connection: the body it never read cannot follow.
    expect(await writeAfterClose(answer.sent)).toBeInstanceOf(Error);
  });

  it("answers a sender writing twice the cap back to back 413, chunked or with its length declared, and holds none of it", async () => {
    const { port, seen } = await serve();

    for (const headers of [
      // Chunked, no length declared: the body grows past the cap as it arrives.
      { "transfer-encoding": "chunked" },
      // Refused on its headers, the declared body following them all the same.
      { "content-length": String(2 * HOOK_BODY_MAX_BYTES) },
    ]) {
      const answer = await post(port, "/v1/hooks/github/issues", {
        headers,
        chunks: chunksOf(2 * HOOK_BODY_MAX_BYTES),
      });

      const label = JSON.stringify(headers);
      expect(answer.status, label).toBe(413);
      expect(JSON.parse(answer.body), label).toMatchObject({ error: { code: "body_too_large" } });
      expect(answer.requestId, label).toMatch(REQUEST_ID);
    }
    expect(seen).toEqual([]);
  });

  it("answers a body that grows past the cap 413 when it does, and closes a sender that never ends after the linger", async () => {
    const { port, seen } = await serve(SHORT_LINGER_MS);

    // One byte past the cap, so the server has read all of it when it answers; the body never ends.
    const chunks = chunksOf(HOOK_BODY_MAX_BYTES);
    chunks.push(new Uint8Array([0x61]));
    const sent = postRaw(port, chunks);

    const answer = await sent.answer;
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "body_too_large" } });
    expect(answer.requestId).toMatch(REQUEST_ID);
    expect(seen).toEqual([]);
    // The sender never ended its body: the server closed the connection itself, cleanly, and a
    // write fails.
    await sent.closed;
    expect(sent.errors).toEqual([]);
    expect(
      await new Promise((done) => {
        sent.socket.write(new Uint8Array(16), (error) => done(error));
      }),
    ).toBeInstanceOf(Error);
  });

  it("lets a sender that has its 413 write the rest of its body and end, then closes the connection", async () => {
    // A linger longer than the test may run: the connection can close only on the body's end.
    const { port, seen } = await serve(LONG_LINGER_MS);
    const pastCap = chunksOf(HOOK_BODY_MAX_BYTES);
    pastCap.push(new Uint8Array([0x61]));
    const sent = postRaw(port, pastCap, true);

    // The answer is in while the body is unfinished; the sender writes the rest regardless.
    expect((await sent.answer).status).toBe(413);
    const met: (Error | undefined)[] = [];
    for (const chunk of chunksOf(HOOK_BODY_MAX_BYTES)) {
      met.push(await writeChunk(sent.socket, chunk));
    }
    sent.socket.write("0\r\n\r\n");
    // The server read every byte and closed only once the body ended: no write met a reset.
    await sent.closed;
    expect(met).toEqual(chunksOf(HOOK_BODY_MAX_BYTES).map(() => undefined));
    expect(sent.errors).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("caps by the URL the router sees, whatever escapes, case or Host header make it", async () => {
    const { port, seen } = await serve();
    for (const [path, host] of [
      ["/v1/%68ooks/github/issues", "127.0.0.1"],
      ["/V1/Hooks/github/issues", "127.0.0.1"],
      // A Host header holding a path makes the request's URL a hook's: the cap follows the URL.
      ["/v1/check", "worker/v1/hooks/github/issues?"],
    ] as const) {
      const answer = await post(port, path, {
        headers: { host, "content-length": String(HOOK_BODY_MAX_BYTES + 1) },
        chunks: [],
        end: false,
      });
      expect(answer.status, `${host} ${path}`).toBe(413);
    }
    expect(seen).toEqual([]);
  });

  it("hands a body at the cap to the handler byte for byte, and leaves every other path as it was", async () => {
    const { port, seen } = await serve();
    const atCap = chunksOf(HOOK_BODY_MAX_BYTES);
    atCap.push(new Uint8Array([0xff, 0xfe]));
    atCap[0]?.set([0xc3, 0x28], 0);
    const exact = chunksOf(HOOK_BODY_MAX_BYTES);
    exact[0]?.set([0xc3, 0x28], 0);

    expect(
      (
        await post(port, "/v1/hooks/github/issues", {
          headers: { "content-length": String(HOOK_BODY_MAX_BYTES) },
          chunks: exact,
        })
      ).status,
    ).toBe(202);
    expect(seen[0]?.body.byteLength).toBe(HOOK_BODY_MAX_BYTES);
    expect(Buffer.from(seen[0]?.body ?? []).subarray(0, 3)).toEqual(
      Buffer.from([0xc3, 0x28, 0x61]),
    );

    // Not a hook: held whole, as every other route's body is (only the hooks are capped).
    expect(
      (
        await post(port, "/v1/check", {
          headers: { "content-length": String(HOOK_BODY_MAX_BYTES + 2) },
          chunks: atCap,
        })
      ).status,
    ).toBe(202);
    expect(seen[1]?.body.byteLength).toBe(HOOK_BODY_MAX_BYTES + 2);
  });
});
