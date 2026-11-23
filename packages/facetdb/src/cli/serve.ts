import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "@facetdb/core";
import {
  type ApiError,
  createHookLimiter,
  HOOK_BODY_DEADLINE_MS,
  HOOK_BODY_MAX_BYTES,
  hookBodyTooLarge,
  hookBodyTooSlow,
  isHookUrl,
  REQUEST_ID_HEADER,
} from "@facetdb/server";
import type { HttpHandler, HttpListener } from "./program.ts";

/**
 * Serves a fetch-shaped handler (the Hono app of `@facetdb/server`) on a host and port with
 * `node:http`: each request becomes a `Request`, each `Response` is written back as it came. The
 * handler is told the address of the socket's other end, which the reviewer sessions read to know a
 * request from this machine's loopback address.
 *
 * A request is held whole before the handler sees it, except a plugin source's webhook, which
 * anyone may send. Before a byte of its body is read, the hook limits (`@facetdb/server`,
 * hooks/limits.ts) are asked: past a rate, or with every body slot taken, it is answered 429 with
 * `retry-after`. Once admitted, past `HOOK_BODY_MAX_BYTES` it is answered 413 as soon as its
 * declared length or the bytes received say so, and a body not whole by the deadline is answered
 * 408. A refused request's body is never held nor handed on, and its connection is closed once the
 * sender has finished its request or `REFUSED_BODY_LINGER_MS` has passed.
 */

/**
 * How long a refused hook's connection stays open after its answer, reading and dropping what the
 * sender still writes. Closing at once, with the sender's bytes unread, makes the kernel reset the
 * connection, and a sender still writing meets the reset before it reads the answer; nginx lingers
 * after its own 413 for the same reason. Bounded, so a sender that never ends costs two seconds.
 */
export const REFUSED_BODY_LINGER_MS = 2000;

export type ServeOptions = {
  /** The clock the hook limits' buckets read: the process's own, a fake one in a test. */
  readonly clock: Clock;
  /** `REFUSED_BODY_LINGER_MS` unless a test passes a shorter or longer one. */
  readonly lingerMs?: number;
  /** `HOOK_BODY_DEADLINE_MS` unless a test passes a shorter one. */
  readonly bodyDeadlineMs?: number;
};

/** The URL a request is made with: the one the hook check reads and the router routes by. */
function urlOf(incoming: IncomingMessage): string {
  return `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`;
}

function requestOf(incoming: IncomingMessage, url: string, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, one);
    }
  }
  const method = incoming.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
  });
}

/**
 * A hook refused by the adapter (429, 408, 413), in the surface's one error shape and with a request
 * id as every answer of the app carries. The answer goes out whole at once, its length declared, so
 * the sender can read it while it still writes. The response ends, and Node closes the connection
 * it marked `connection: close`, only once the request has ended or the linger has passed; until
 * then the request is read and its bytes dropped, so none of them is kept.
 */
function refuse(
  error: ApiError,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  lingerMs: number,
): void {
  const body = Buffer.from(JSON.stringify(error.toBody()));
  outgoing.writeHead(error.status, {
    ...error.headers,
    "content-type": "application/json",
    "content-length": body.byteLength,
    connection: "close",
    [REQUEST_ID_HEADER]: randomUUID(),
  });
  outgoing.write(body);
  const close = (): void => {
    clearTimeout(timer);
    incoming.off("end", close);
    outgoing.off("close", close);
    if (!outgoing.writableEnded && !outgoing.destroyed) {
      outgoing.end();
    }
  };
  const timer = setTimeout(close, lingerMs);
  incoming.once("end", close);
  // A connection that errors or is closed first (the sender gave up) leaves no timer behind.
  outgoing.once("close", close);
  // A body refused on its headers was never read: flowing with no reader drops it.
  incoming.resume();
}

export async function serveHttp(
  handler: HttpHandler,
  port: number,
  host: string,
  options: ServeOptions,
): Promise<HttpListener> {
  const lingerMs = options.lingerMs ?? REFUSED_BODY_LINGER_MS;
  const bodyDeadlineMs = options.bodyDeadlineMs ?? HOOK_BODY_DEADLINE_MS;
  const limits = createHookLimiter({ clock: options.clock });
  const server = createServer((incoming, outgoing) => {
    const url = urlOf(incoming);
    const hook = isHookUrl(url);
    // A hook is asked about before any listener reads its body: a refused one is never read.
    let release = (): void => {};
    if (hook) {
      const admission = limits.admit({
        url,
        remoteAddress: incoming.socket.remoteAddress,
        headers: incoming.headers,
      });
      if (admission.kind === "refused") {
        refuse(admission.error, incoming, outgoing, lingerMs);
        return;
      }
      release = admission.release;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    let deadline: NodeJS.Timeout | undefined;
    // The body is whole, refused, or its connection gone: its deadline and its slot end here.
    const settle = (): void => {
      clearTimeout(deadline);
      release();
    };
    const refuseBody = (error: ApiError): void => {
      refused = true;
      chunks.length = 0;
      settle();
      refuse(error, incoming, outgoing, lingerMs);
    };
    if (hook) {
      // Unref'd: an open socket keeps the process alive, never a deadline of its own.
      deadline = setTimeout(() => {
        refuseBody(hookBodyTooSlow());
      }, bodyDeadlineMs).unref();
      incoming.once("close", settle);
      outgoing.once("close", settle);
    }
    const declared = incoming.headers["content-length"];
    if (hook && declared !== undefined && Number(declared) > HOOK_BODY_MAX_BYTES) {
      refuseBody(hookBodyTooLarge());
      return;
    }
    incoming.on("data", (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.length;
      if (hook && size > HOOK_BODY_MAX_BYTES) {
        refuseBody(hookBodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (refused) {
        return;
      }
      settle();
      void (async () => {
        try {
          const response = await handler(requestOf(incoming, url, Buffer.concat(chunks)), {
            remoteAddress: incoming.socket.remoteAddress,
          });
          outgoing.writeHead(response.status, [...response.headers.entries()].flat());
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          // The app maps its own errors; this is the adapter failing, so no detail leaves the process.
          outgoing.writeHead(500, { "content-type": "application/json" });
          outgoing.end('{"error":{"code":"internal","message":"internal error"}}');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
