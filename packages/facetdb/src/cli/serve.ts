import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpHandler, HttpListener } from "./program.ts";

/**
 * Serves a fetch-shaped handler (the Hono app of `@facetdb/server`) on a port with `node:http`: each
 * request becomes a `Request`, each `Response` is written back as it came.
 */

function requestOf(incoming: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, one);
    }
  }
  const method = incoming.method ?? "GET";
  return new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
  });
}

export async function serveHttp(handler: HttpHandler, port: number): Promise<HttpListener> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        try {
          const response = await handler(requestOf(incoming, Buffer.concat(chunks)));
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
    server.listen(port, () => {
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
