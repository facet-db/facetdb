import type { ActionRecord } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { pgliteClient } from "@facetdb/postgres";
import { freshPglite } from "@facetdb/postgres/testing";
import {
  createOutbox,
  createWebhookAction,
  sign,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookFetch,
} from "@facetdb/server";
import { afterEach, describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "./webhook.ts";

const SECRET = "whsec-sender-test";
const START = 1_700_000_000_000;
const ENDPOINT = "https://hooks.example.com/facetdb";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

type Sent = { headers: Record<string, string>; body: string };

/** The real sender (the outbox and the webhook action of @facetdb/server) over PGlite, capturing what it sends. */
async function sender() {
  const clock = new FakeClock(START);
  const pglite = await freshPglite();
  closers.push(() => pglite.close());
  await pglite.query("create schema if not exists facetdb");
  const sent: Sent[] = [];
  const send: WebhookFetch = (_url, init) => {
    sent.push({ headers: { ...init.headers }, body: init.body });
    return Promise.resolve({ status: 204 });
  };
  const outbox = createOutbox({
    client: pgliteClient(pglite),
    clock,
    fetch: send,
    secretFor: () => Promise.resolve(SECRET),
    onGiveUp: () => Promise.resolve(),
  });
  await outbox.install();
  const action = createWebhookAction({ outbox, projectId: "project-1", source: "tickets", clock });
  return { clock, outbox, action, sent };
}

const record: ActionRecord = {
  key: "T-1042",
  state: { subject: "Remboursement", body: "Facturé deux fois ✓" },
  status: "done",
};

describe("verifyWebhook accepts what the real sender sends", () => {
  it("verifies, byte for byte, a body the outbox signed (non-ASCII text included)", async () => {
    const t = await sender();
    await t.action.run(
      record,
      {
        urgency: { kind: "decided", value: "high", probabilityOrConfidence: 0.91, expected: 2.89 },
        wants_refund: { kind: "decided", value: true, probabilityOrConfidence: 0.97 },
      },
      { url: ENDPOINT },
    );
    await t.outbox.deliverDue(t.clock.now());

    const [request] = t.sent;
    if (request === undefined) {
      throw new Error("the outbox sent nothing");
    }
    const now = t.clock.now();
    expect(verifyWebhook(SECRET, request.headers, request.body, { now })).toEqual({
      ok: true,
      timestamp: Math.floor(START / 1000),
    });
    // The raw bytes as a receiver reads them from the wire, and as a Headers object.
    const bytes = new TextEncoder().encode(request.body);
    expect(verifyWebhook(SECRET, new Headers(request.headers), bytes, { now }).ok).toBe(true);
    // Both ends make the same header for the same bytes.
    expect(request.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      signWebhook(SECRET, Math.floor(START / 1000), request.body),
    );
    expect(signWebhook(SECRET, 1_700_000_000, request.body)).toBe(
      sign(SECRET, 1_700_000_000, request.body),
    );

    // The body is what the receiver is told to rely on: delivery and decidedAt are in it.
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "record.decided",
      delivery: request.headers["facetdb-delivery"],
      decidedAt: new Date(START).toISOString(),
      id: "T-1042",
      status: "done",
    });
    // A changed decidedAt or delivery fails to verify.
    for (const changed of [{ decidedAt: "2030-01-01T00:00:00.000Z" }, { delivery: "7" }]) {
      expect(
        verifyWebhook(SECRET, request.headers, JSON.stringify({ ...body, ...changed }), { now }),
      ).toEqual({ ok: false, reason: "mismatch" });
    }
  });
});
