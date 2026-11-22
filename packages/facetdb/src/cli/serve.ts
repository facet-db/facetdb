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
 * the bytes received say so, nothing more of it is kept, and the connection is closed.
 */

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
 * every answer of the app carries; the connection closes.
 */
function refuseTooLarge(outgoing: ServerResponse): void {
  const error = hookBodyTooLarge();
  outgoing.writeHead(error.status, {
    "content-type": "application/json",
    connection: "close",
    [REQUEST_ID_HEADER]: randomUUID(),
  });
  outgoing.end(JSON.stringify(error.toBody()));
}

export async function serveHttp(
  handler: HttpHandler,
  port: number,
  host: string,
): Promise<HttpListener> {
  const server = createServer((incoming, outgoing) => {
    const url = urlOf(incoming);
    const limit = isHookUrl(url) ? HOOK_BODY_MAX_BYTES : undefined;
    const declared = incoming.headers["content-length"];
    if (limit !== undefined && declared !== undefined && Number(declared) > limit) {
      refuseTooLarge(outgoing);
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
        refuseTooLarge(outgoing);
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
