import { ADDRCONFIG } from "node:dns";
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo, isIP } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { WebhookFetch } from "./outbox.ts";
import { createPinnedFetch, PrivateAddressRefused, type Resolve } from "./pinned-fetch.ts";
import { isPrivateAddress } from "./private-address.ts";

/**
 * The webhook send: a host that is, or resolves to, a private address is refused before any
 * connection unless its endpoint allows it, and the connection goes to the address the one lookup
 * judged. The resolver is a script; the only sockets are a receiver on 127.0.0.1 that this file
 * starts, so nothing reaches the network.
 */

type Init = Parameters<WebhookFetch>[1];

const BODY = '{"id":"T-1","note":"café ✓"}';

function init(over: Partial<Init> = {}): Init {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "facetdb-signature": "t=1700000000,v1=abc",
      "facetdb-delivery": "42",
    },
    body: BODY,
    redirect: "manual",
    signal: new AbortController().signal,
    allowPrivate: false,
    ...over,
  };
}

/** The User-Agent the composition root would pass: `facetdb/<version>`. */
const AGENT = "facetdb/9.9.9-test";

/**
 * A resolver that answers its scripts in turn (the last one again after them), and keeps each ask
 * with the hints the socket handed it.
 */
function scripted(...answers: readonly (readonly string[])[]): {
  readonly asked: string[];
  readonly hints: (number | undefined)[];
  readonly resolve: Resolve;
} {
  const asked: string[] = [];
  const hints: (number | undefined)[] = [];
  return {
    asked,
    hints,
    resolve: (hostname, options) => {
      asked.push(hostname);
      hints.push(options.hints);
      const answer = answers[Math.min(asked.length, answers.length) - 1] ?? [];
      return Promise.resolve(answer.map((address) => ({ address, family: isIP(address) })));
    },
  };
}

type Received = {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/**
 * A receiver on 127.0.0.1: it keeps every request it read and counts every connection made to
 * it; `answer` writes the response, or never does.
 */
async function receiver(
  answer: (response: ServerResponse) => void = (response) => {
    response.statusCode = 204;
    response.end();
  },
) {
  const received: Received[] = [];
  let connections = 0;
  let arrived: () => void = () => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      arrived();
      answer(response);
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { port, received, connections: () => connections, firstRequest };
}

/** This file's network counts 127.0.0.1 as public, so a receiver here stands for a public host. */
const LOOPBACK_IS_PUBLIC = (address: string): boolean =>
  address !== "127.0.0.1" && isPrivateAddress(address);

describe("the pinned webhook fetch (pinned-fetch)", () => {
  it("refuses a name that resolves to 10.0.0.5, naming the address alone, with no connection made", async () => {
    const dns = scripted(["10.0.0.5"]);
    const send = createPinnedFetch({ userAgent: AGENT, resolve: dns.resolve });

    const refused = send("https://hooks.example.com/facetdb?token=s3cret", init());

    await expect(refused).rejects.toBeInstanceOf(PrivateAddressRefused);
    await expect(refused).rejects.toThrow(
      "the endpoint's host resolved to 10.0.0.5, a private address this endpoint does not allow: if the receiver is yours, set allowPrivate: true beside its url",
    );
    const error = await refused.catch((caught: unknown) => caught);
    expect(String(error)).not.toMatch(/facetdb\?|token|s3cret|hooks\.example\.com/);
    expect(dns.asked).toEqual(["hooks.example.com"]);

    // The same refusal with a receiver listening at the address it resolved to: nothing reaches it.
    const local = await receiver();
    const toLoopback = createPinnedFetch({
      userAgent: AGENT,
      resolve: scripted(["127.0.0.1"]).resolve,
    });
    await expect(toLoopback(`http://127.0.0.1.nip.io:${local.port}/hook`, init())).rejects.toThrow(
      "the endpoint's host resolved to 127.0.0.1, a private address",
    );
    expect(local.connections()).toBe(0);
    expect(local.received).toEqual([]);
  });

  it("asks the resolver once: a public answer then a private one connects to the first", async () => {
    const local = await receiver();
    // A name that rebinds: public (127.0.0.1 in this file's network) when asked first, 10.0.0.5 after.
    const dns = scripted(["127.0.0.1"], ["10.0.0.5"]);
    const send = createPinnedFetch({
      userAgent: AGENT,
      resolve: dns.resolve,
      isPrivate: LOOPBACK_IS_PUBLIC,
    });

    const answered = await send(`http://rebind.example.com:${local.port}/hook`, init());

    expect(answered).toEqual({ status: 204 });
    expect(dns.asked).toEqual(["rebind.example.com"]);
    expect(local.connections()).toBe(1);
    expect(local.received).toHaveLength(1);
    // The request still names the host it was sent to; only the socket's address was pinned.
    expect(local.received[0]?.headers["host"]).toBe(`rebind.example.com:${local.port}`);
  });

  it("refuses a literal 169.254.169.254, or [::1], before any lookup or connection", async () => {
    const dns = scripted(["93.184.215.14"]);
    const send = createPinnedFetch({ userAgent: AGENT, resolve: dns.resolve });

    await expect(send("http://169.254.169.254/latest/meta-data/iam?x=1", init())).rejects.toThrow(
      "the endpoint's host is 169.254.169.254, a private address this endpoint does not allow: if the receiver is yours, set allowPrivate: true beside its url",
    );
    await expect(send("http://[::1]:8080/hook", init())).rejects.toThrow(
      "the endpoint's host is ::1, a private address",
    );
    expect(dns.asked).toEqual([]);
  });

  it("with the endpoint's allowance, a receiver on 127.0.0.1 gets the POST with its headers and body", async () => {
    const local = await receiver();
    const dns = scripted(["127.0.0.1"]);
    const send = createPinnedFetch({ userAgent: AGENT, resolve: dns.resolve });

    const literal = await send(
      `http://127.0.0.1:${local.port}/hook?project=1`,
      init({ allowPrivate: true }),
    );
    const named = await send(
      `http://receiver.internal:${local.port}/named`,
      init({ allowPrivate: true }),
    );

    expect(literal).toEqual({ status: 204 });
    expect(named).toEqual({ status: 204 });
    expect(dns.asked).toEqual(["receiver.internal"]);
    expect(local.received.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: "/hook?project=1", body: BODY },
      { method: "POST", url: "/named", body: BODY },
    ]);
    // The exact set: a header gone missing (a User-Agent an edge requires) or added fails here.
    const sent = (host: string) => ({
      host,
      connection: "close",
      "user-agent": AGENT,
      accept: "*/*",
      "content-type": "application/json",
      "facetdb-signature": "t=1700000000,v1=abc",
      "facetdb-delivery": "42",
      "content-length": String(Buffer.byteLength(BODY)),
    });
    expect(local.received.map((request) => request.headers)).toEqual([
      sent(`127.0.0.1:${local.port}`),
      sent(`receiver.internal:${local.port}`),
    ]);
  });

  it("lets a header the outbox sets win over a default, whatever its case, and never sends it twice", async () => {
    const local = await receiver();
    const send = createPinnedFetch({ userAgent: AGENT, resolve: scripted(["127.0.0.1"]).resolve });
    const base = init({ allowPrivate: true });

    await send(`http://127.0.0.1:${local.port}/hook`, {
      ...base,
      headers: { ...base.headers, Accept: "application/json", "User-Agent": "receiver-test/1" },
    });

    expect(local.received.map((request) => request.headers)).toEqual([
      {
        host: `127.0.0.1:${local.port}`,
        connection: "close",
        "user-agent": "receiver-test/1",
        accept: "application/json",
        "content-type": "application/json",
        "facetdb-signature": "t=1700000000,v1=abc",
        "facetdb-delivery": "42",
        "content-length": String(Buffer.byteLength(BODY)),
      },
    ]);
  });

  it("hands the resolver the hints the socket asked with (ADDRCONFIG), every answer still judged", async () => {
    const local = await receiver();
    const dns = scripted(["127.0.0.1", "10.0.0.5"]);
    const send = createPinnedFetch({
      userAgent: AGENT,
      resolve: dns.resolve,
      isPrivate: LOOPBACK_IS_PUBLIC,
    });

    await expect(send(`http://hinted.example.com:${local.port}/hook`, init())).rejects.toThrow(
      "resolved to 10.0.0.5",
    );
    expect(dns.hints).toEqual([ADDRCONFIG]);

    const allowed = scripted(["127.0.0.1"]);
    await createPinnedFetch({
      userAgent: AGENT,
      resolve: allowed.resolve,
      isPrivate: LOOPBACK_IS_PUBLIC,
    })(`http://hinted.example.com:${local.port}/hook`, init());
    expect(allowed.hints).toEqual([ADDRCONFIG]);
    expect(local.received).toHaveLength(1);
  });

  it("refuses the send when one address of several is private, whichever comes first", async () => {
    const local = await receiver();
    for (const answer of [
      ["127.0.0.1", "10.0.0.5"],
      ["fd00::1", "127.0.0.1"],
    ]) {
      const dns = scripted(answer);
      const send = createPinnedFetch({
        userAgent: AGENT,
        resolve: dns.resolve,
        isPrivate: LOOPBACK_IS_PUBLIC,
      });
      await expect(
        send(`http://mixed.example.com:${local.port}/hook`, init()),
      ).rejects.toBeInstanceOf(PrivateAddressRefused);
      expect(dns.asked).toEqual(["mixed.example.com"]);
    }
    await expect(
      createPinnedFetch({
        userAgent: AGENT,
        resolve: scripted(["127.0.0.1", "169.254.169.254"]).resolve,
        isPrivate: LOOPBACK_IS_PUBLIC,
      })(`http://mixed.example.com:${local.port}/hook`, init()),
    ).rejects.toThrow("resolved to 169.254.169.254");
    expect(local.connections()).toBe(0);
  });

  it("ends a slow send when the signal aborts, and returns a redirect as its status, unfollowed", async () => {
    const silent = await receiver(() => undefined);
    const controller = new AbortController();
    const send = createPinnedFetch({ userAgent: AGENT, resolve: scripted(["127.0.0.1"]).resolve });

    const slow = send(
      `http://127.0.0.1:${silent.port}/slow`,
      init({ allowPrivate: true, signal: controller.signal }),
    );
    await silent.firstRequest;
    controller.abort();
    await expect(slow).rejects.toMatchObject({ name: "AbortError" });

    const moving = await receiver((response) => {
      response.statusCode = 302;
      response.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      response.end();
    });
    const answered = await send(
      `http://127.0.0.1:${moving.port}/hook`,
      init({ allowPrivate: true }),
    );
    expect(answered).toEqual({ status: 302 });
    expect(moving.received).toHaveLength(1);
  });

  it("sends only over http or https", async () => {
    const send = createPinnedFetch({
      userAgent: AGENT,
      resolve: scripted(["93.184.215.14"]).resolve,
    });
    await expect(send("ftp://hooks.example.com/facetdb", init())).rejects.toThrow(
      "a webhook is sent over http or https only",
    );
  });
});
