import { createHmac, timingSafeEqual } from "node:crypto";

/** The header every webhook carries. */
export const WEBHOOK_SIGNATURE_HEADER = "facetdb-signature";

/**
 * The signature header's value is `t=<unix seconds>,v1=<hex HMAC-SHA256>` over the
 * string `<t>.<body>`: the timestamp is signed together with the exact bytes sent, so a captured
 * request cannot be replayed later and a tampered body does not verify.
 *
 * The receiver is `receiveFacetdbWebhook` in `receiver.ts` beside this file, the snippet the docs
 * show: real code that `pnpm typecheck` compiles and webhooks.test.ts runs. It reads the raw body
 * (never a re-serialised one), reads `FACETDB_WEBHOOK_SECRET` on each request (typed
 * `string | undefined`; unset, it answers 500 with the fix and nothing throws at load), verifies,
 * and answers 2xx quickly, keyed by `delivery` and ordered by `decidedAt`.
 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

const HEADER = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/;

function mac(secret: string, timestamp: number, body: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body, "utf8").digest();
}

/** The header value for `body` sent at `timestamp` (unix seconds). */
export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, body).toString("hex")}`;
}

export type Verification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "expired" | "mismatch";
    };

/**
 * Checks a signature header against the body that arrived. `now` is milliseconds since the epoch.
 * A signature more than 5 minutes away from `now`, in either direction, is refused; so is any
 * other than the exact header shape.
 */
export function verify(
  secret: string,
  header: string | null | undefined,
  body: string,
  now: number,
): Verification {
  const match = header === null || header === undefined ? null : HEADER.exec(header);
  if (match === null) {
    return { ok: false, reason: "malformed" };
  }
  const timestamp = Number(match[1]);
  if (Math.abs(now - timestamp * 1000) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: "expired" };
  }
  const given = Buffer.from(match[2] ?? "", "hex");
  const expected = mac(secret, timestamp, body);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
