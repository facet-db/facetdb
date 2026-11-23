import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Clock } from "@facetdb/core";
import {
  type ApiError,
  BODY_MAX_BYTES,
  createHookLimiter,
  HOOK_BODY_DEADLINE_MS,
  HOOK_BODY_MAX_BYTES,
  hookBodyTooLarge,
  hookBodyTooSlow,
  isHookUrl,
  REQUEST_ID_HEADER,
  requestTooLarge,
} from "@facetdb/server";
import type { HttpHandler, HttpListener } from "./program.ts";

/**
 * Serves a fetch-shaped handler (the Hono app of `@facetdb/server`) on a host and port with
 * `node:http`: each request becomes a `Request`, each `Response` is written back as it came. The
 * handler is told the address of the socket's other end, which the reviewer sessions read to know a
 * request from this machine's loopback address.
 *
 * A request's body is held whole before the handler sees it, and every path has a cap, checked
 * before the handler runs and so before any login check: a plugin source's webhook, which anyone
 * may send, `HOOK_BODY_MAX_BYTES`; every other path `BODY_MAX_BYTES`. Past it a request is answered
 * 413 as soon as its declared length or the bytes received say so; a request that asks `Expect:
 * 100-continue` is refused on its headers with no `100 Continue`. Before a byte of a hook's body is
 * read, the hook limits (`@facetdb/server`, hooks/limits.ts) are asked: past a rate, or with every
 * body slot taken, it is answered 429 with `retry-after`; an admitted hook's body not whole by the
 * deadline is answered 408.
 *
 * A refused request's body is never held nor handed on. Every refusal (413, 429, 408) closes its
 * connection: once the sender has finished its request, or when `REFUSED_BODY_LINGER_MS` has passed
 * the socket is destroyed. A request parsed on that connection after the refused one never reaches
 * the handler: its answer could never be sent, so running it would only act unseen.
 */

/**
 * How long a refused request's connection stays open after its answer, reading and dropping what
 * the sender still writes. Closing at once, with the sender's bytes unread, makes the kernel reset
 * the connection, and a sender still writing meets the reset before it reads the answer; nginx
 * lingers after its own 413 for the same reason. Bounded: when it passes the socket is destroyed,
 * whatever is still being sent or answered on it, so a sender that never ends costs two seconds.
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

/**
 * What the adapter remembers of one connection: how many requests were parsed on it, and the place
 * among them of the first one refused. Held by the socket, so it goes with the connection.
 */
type Connection = { parsed: number; refusedAt: number | undefined };

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
 * A request refused by the adapter (413, 429, 408), in the surface's one error shape and with a
 * request id as every answer of the app carries. The answer goes out whole at once, its length
 * declared, so the sender can read it while it still writes. The response ends, and Node closes
 * the connection it marked `connection: close`, once the request has ended; until then the request
 * is read and its bytes dropped, so none of them is kept. When the linger passes the socket is
 * destroyed, whether or not the answer has ended (a sender that never ends, or an answer queued
 * behind an earlier pipelined one); the timer is `unref`'d, so it never holds the process up.
 */
function refuse(
  error: ApiError,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  lingerMs: number,
): void {
  const socket = incoming.socket;
  const body = Buffer.from(JSON.stringify(error.toBody()));
  outgoing.writeHead(error.status, {
    ...error.headers,
    "content-type": "application/json",
    "content-length": body.byteLength,
    connection: "close",
    [REQUEST_ID_HEADER]: randomUUID(),
  });
  outgoing.write(body);
  const end = (): void => {
    if (!outgoing.writableEnded && !outgoing.destroyed) {
      outgoing.end();
    }
  };
  const timer = setTimeout(() => {
    end();
    socket.destroy();
  }, lingerMs).unref();
  // The connection closed first (the answer ended, the sender gave up): no timer is left behind.
  socket.once("close", () => clearTimeout(timer));
  incoming.once("end", end);
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
  const connections = new WeakMap<Socket, Connection>();

  /**
   * One request, `expectsContinue` when it asked `Expect: 100-continue`: it is told to send its
   * body only once nothing on its headers refuses it.
   */
  const onRequest = (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    expectsContinue: boolean,
  ): void => {
    const socket = incoming.socket;
    const connection = connections.get(socket) ?? { parsed: 0, refusedAt: undefined };
    connections.set(socket, connection);
    const at = connection.parsed;
    connection.parsed += 1;
    // Parsed after a refusal, so after the refused body's last byte: nothing more on this
    // connection needs reading. The socket stops being read, so no further request is parsed, and
    // this one is neither admitted, read nor answered; the refusal's close ends the connection.
    if (connection.refusedAt !== undefined) {
      socket.pause();
      return;
    }
    const url = urlOf(incoming);
    const hook = isHookUrl(url);
    const cap = hook ? HOOK_BODY_MAX_BYTES : BODY_MAX_BYTES;
    const tooLarge = (): ApiError => (hook ? hookBodyTooLarge() : requestTooLarge());
    const refuseRequest = (error: ApiError): void => {
      connection.refusedAt ??= at;
      refuse(error, incoming, outgoing, lingerMs);
    };
    // A hook is asked about before any listener reads its body: a refused one is never read.
    let release = (): void => {};
    if (hook) {
      const admission = limits.admit({
        url,
        remoteAddress: socket.remoteAddress,
        headers: incoming.headers,
      });
      if (admission.kind === "refused") {
        refuseRequest(admission.error);
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
      refuseRequest(error);
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
    if (declared !== undefined && Number(declared) > cap) {
      refuseBody(tooLarge());
      return;
    }
    if (expectsContinue) {
      outgoing.writeContinue();
    }
    incoming.on("data", (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.length;
      if (size > cap) {
        refuseBody(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (refused) {
        return;
      }
      settle();
      // Parsed after a request this connection refused once its headers were already seen: never
      // run, as its answer could not be sent. A request parsed before the refused one runs.
      if (connection.refusedAt !== undefined && connection.refusedAt < at) {
        chunks.length = 0;
        return;
      }
      void (async () => {
        try {
          const response = await handler(requestOf(incoming, url, Buffer.concat(chunks)), {
            remoteAddress: socket.remoteAddress,
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
  };

  const server = createServer((incoming, outgoing) => onRequest(incoming, outgoing, false));
  // Listened for, Node no longer writes `100 Continue` itself before the request is seen: it is
  // written above, only to a request its headers do not refuse.
  server.on("checkContinue", (incoming, outgoing) => onRequest(incoming, outgoing, true));
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
