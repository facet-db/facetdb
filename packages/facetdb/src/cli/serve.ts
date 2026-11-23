import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HOOK_BODY_MAX_BYTES,
  hookBodyTooLarge,
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
 * anyone may send: past `HOOK_BODY_MAX_BYTES` it is answered 413 as soon as its declared length or
 * the bytes received say so, nothing more of it is kept, and the connection is closed once the
 * sender has finished its request or `REFUSED_BODY_LINGER_MS` has passed.
 */

/**
 * How long a refused hook's connection stays open after its 413, reading and dropping what the
 * sender still writes. Closing at once, with the sender's bytes unread, makes the kernel reset the
 * connection, and a sender still writing meets the reset before it reads the answer; nginx lingers
 * after its own 413 for the same reason. Bounded, so a sender that never ends costs two seconds.
 */
export const REFUSED_BODY_LINGER_MS = 2000;

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
 * The 413 of a hook's body past the cap, in the surface's one error shape and with a request id as
 * every answer of the app carries. The answer goes out whole at once, its length declared, so the
 * sender can read it while it still writes. The response ends, and Node closes the connection it
 * marked `connection: close`, only once the request has ended or the linger has passed; until
 * then the request is read and its bytes dropped, so none of them is kept.
 */
function refuseTooLarge(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  lingerMs: number,
): void {
  const error = hookBodyTooLarge();
  const body = Buffer.from(JSON.stringify(error.toBody()));
  outgoing.writeHead(error.status, {
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
  // A declared length refused on its headers was never read: flowing with no reader drops it.
  incoming.resume();
}

export async function serveHttp(
  handler: HttpHandler,
  port: number,
  host: string,
  lingerMs: number = REFUSED_BODY_LINGER_MS,
): Promise<HttpListener> {
  const server = createServer((incoming, outgoing) => {
    const url = urlOf(incoming);
    const limit = isHookUrl(url) ? HOOK_BODY_MAX_BYTES : undefined;
    const declared = incoming.headers["content-length"];
    if (limit !== undefined && declared !== undefined && Number(declared) > limit) {
      refuseTooLarge(incoming, outgoing, lingerMs);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    incoming.on("data", (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.length;
      if (limit !== undefined && size > limit) {
        refused = true;
        chunks.length = 0;
        refuseTooLarge(incoming, outgoing, lingerMs);
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (refused) {
        return;
      }
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
