import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SIGNATURE_HEADER } from "@facetdb/server";

/** A signature older than this (or dated further ahead) is a replay or a wrong clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type WebhookVerification =
  | { readonly ok: true; readonly timestamp: number }
  | {
      readonly ok: false;
      /**
       * `missing`: no signature header; `malformed`: the header is not `t=<unix>,v1=<hex>`;
       * `expired`: the timestamp is too far from now; `mismatch`: the body or the secret differs.
       */
      readonly reason: "missing" | "malformed" | "expired" | "mismatch";
    };

/**
 * Checks a FacetDB webhook on the receiving side. Pass the headers and the exact bytes of the
 * body as they arrived (read the raw body before any JSON parser touches it); the signature
 * covers `t=<unix>.` followed by those bytes.
 *
 * ```ts
 * const raw = await request.text();
 * const verdict = verifyWebhook(process.env.FACETDB_WEBHOOK_SECRET, request.headers, raw);
 * if (!verdict.ok) return new Response("bad signature", { status: 401 });
 * ```
 *
 * `options.now` is the current time in milliseconds; tests pass a fixed one.
 *
 * An empty secret throws: anyone can sign with the empty key, so accepting it would let a forged
 * webhook through. It is a misconfiguration (an unset environment variable), not a verdict.
 */
export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string | Uint8Array,
  options: { readonly now?: number } = {},
): WebhookVerification {
  if (secret === "") {
    throw new TypeError(
      "verifyWebhook needs the webhook secret, got an empty string. Set FACETDB_WEBHOOK_SECRET.",
    );
  }
  const header = headerValue(headers, WEBHOOK_SIGNATURE_HEADER);
  if (header === undefined) {
    return { ok: false, reason: "missing" };
  }
  const parsed = parseSignature(header);
  if (parsed === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.`)
    .update(body)
    .digest();
  // Several v1 values appear while a secret is being rotated: any one that matches is enough.
  const matches = parsed.signatures.some(
    (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
  );
  return matches ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "mismatch" };
}

/**
 * Makes a signature header the way FacetDB's sender does. A receiver never needs it; tests of the
 * receiving code and the documentation use it to show a valid pair.
 */
export function signWebhook(secret: string, timestamp: number, body: string | Uint8Array): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return typeof value === "string" ? value : value?.[0];
    }
  }
  return undefined;
}

function parseSignature(
  header: string,
): { timestamp: number; signatures: readonly Buffer[] } | undefined {
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [name, value] = part.trim().split("=");
    if (name === "t" && value !== undefined && /^\d{1,15}$/.test(value)) {
      timestamp = Number(value);
    } else if (name === "v1" && value !== undefined && /^(?:[0-9a-f]{2})+$/i.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  return timestamp === undefined || signatures.length === 0 ? undefined : { timestamp, signatures };
}
