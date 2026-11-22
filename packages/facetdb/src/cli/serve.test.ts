import { type ClientRequest, request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { HOOK_BODY_MAX_BYTES } from "@facetdb/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpListener } from "./program.ts";
import { serveHttp } from "./serve.ts";

/**
 * The HTTP adapter's cap on a plugin source's webhook, over a real socket on this machine's
 * loopback address: a hook's body past 5 MB is answered 413, with a request id, as soon as its
 * declared length or the bytes received say so; the handler never sees it, the server closes the
 * connection (a write after the answer fails) and the rest is never held; a body at the cap, and a
 * body of any size on another path, reach the handler whole as before.
 */

const MiB = 1024 * 1024;

type Seen = { readonly url: string; readonly body: Uint8Array };

let listener: HttpListener | undefined;
/** Every request a test opened, ended after it whatever became of it. */
const opened: ClientRequest[] = [];

afterEach(async () => {
  for (const sent of opened.splice(0)) {
    sent.destroy();
  }
  await listener?.close();
  listener = undefined;
});

async function serve(): Promise<{ readonly port: number; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  listener = await serveHttp(
    async (request) => {
      seen.push({ url: request.url, body: new Uint8Array(await request.arrayBuffer()) });
      return Response.json({ ok: true }, { status: 202 });
    },
    0,
    "127.0.0.1",
  );
  return { port: listener.port, seen };
}

type Answer = {
  readonly status: number;
  readonly body: string;
  readonly requestId: string | undefined;
  /** The body's bytes written before the answer arrived. */
  readonly written: number;
  /** The request, left open by this side: whether the server closed it is the test's to see. */
  readonly sent: ClientRequest;
};

/**
 * A POST written one chunk at a time, each after the last was flushed, stopping once an answer
 * arrives (a server that refused the body closes the connection, so later writes may fail: those
 * failures are the refusal working, not the test's). `end: false` leaves the body unfinished.
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
    // Set by the response's callback and read by the writer's loop, so a field, never narrowed.
    const answer = { arrived: false };
    let written = 0;
    const sent = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...options.headers } },
      (response) => {
        answer.arrived = true;
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const id = response.headers["x-request-id"];
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(parts).toString("utf8"),
            requestId: typeof id === "string" ? id : undefined,
            written,
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
        if (answer.arrived || sent.destroyed) {
          return;
        }
        await new Promise<void>((done) => {
          sent.write(chunk, () => done());
        });
        written += chunk.byteLength;
        // A turn for an answer already on its way to arrive before the next chunk goes.
        await new Promise((done) => setTimeout(done, 5));
      }
      if (options.end !== false && !answer.arrived && !sent.destroyed) {
        sent.end();
      }
    })();
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
    const { port, seen } = await serve();

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

  it("answers a body that grows past the cap 413 when it does, closes the connection and holds none of it", async () => {
    const { port, seen } = await serve();

    // Chunked, no length declared: twice the cap offered, a megabyte at a time.
    const answer = await post(port, "/v1/hooks/github/issues", {
      headers: { "transfer-encoding": "chunked" },
      chunks: chunksOf(2 * HOOK_BODY_MAX_BYTES),
    });

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "body_too_large" } });
    expect(answer.requestId).toMatch(REQUEST_ID);
    expect(answer.written).toBeLessThan(2 * HOOK_BODY_MAX_BYTES);
    expect(seen).toEqual([]);
    // The rest of the body has nowhere to go: the server closed the connection after its answer.
    expect(await writeAfterClose(answer.sent)).toBeInstanceOf(Error);
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
