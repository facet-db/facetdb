import { createHmac, timingSafeEqual } from "node:crypto";

/** The header every webhook carries. */
export const WEBHOOK_SIGNATURE_HEADER = "facetdb-signature";

/**
 * The signature header's value is `t=<unix seconds>,v1=<hex HMAC-SHA256>` over the
 * string `<t>.<body>`: the timestamp is signed together with the exact bytes sent, so a captured
 * request cannot be replayed later and a tampered body does not verify.
 *
 * The receiver (Node; read the raw body, not a re-serialised one):
 *
 * ```ts
 * import { verify } from "@facetdb/server";
 *
 * app.post("/facetdb", express.raw({ type: "application/json" }), (req, res) => {
 *   const body = req.body.toString("utf8"); // the exact bytes FacetDB sent
 *   const result = verify(process.env.FACETDB_WEBHOOK_SECRET, req.get("facetdb-signature"), body, Date.now());
 *   if (!result.ok) return res.status(400).send(result.reason);
 *   const event = JSON.parse(body); // { event, source, id, status, answers }
 *   // Answer 2xx quickly. Anything else is retried with backoff for 24 hours, so be idempotent:
 *   // `facetdb-delivery` (a header) is the same on every retry of one webhook.
 *   res.sendStatus(204);
 * });
 * ```
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
