import { createHmac, timingSafeEqual } from "node:crypto";
import { type Infer, type SourceReceipt, z } from "facetdb/plugin";
import { issueNumber, type Kind } from "./issues-state.ts";
import type { Repo } from "./settings.ts";

/**
 * The issues source's webhook: a delivery GitHub signed with the webhook's secret names the issue
 * or pull request that changed, and nothing else is believed.
 *
 * In this order, and nothing of a step is read before the one above it holds:
 * 1. no `webhookSecret` set: 401, webhooks are off for this source, nothing read;
 * 2. `X-Hub-Signature-256` missing, or not exactly `sha256=` and 64 lowercase hex digits (GitHub's
 *    form): 401, the body unread;
 * 3. the body read as bytes, at most `WEBHOOK_BODY_MAX_BYTES` (a `Content-Length` above it is 413
 *    unread, a body that grows past it 413 when it does);
 * 4. the HMAC-SHA256 of those exact bytes with the secret, compared with the header's digest in
 *    constant time (`timingSafeEqual`, both 32 bytes): 401 when they differ;
 * 5. only then the event: `X-GitHub-Event` other than `issues` and `pull_request` (a `ping`
 *    included) is accepted with no key, its body never parsed; an `issues` or `pull_request` body
 *    is parsed (JSON, or the `payload` field of a form-encoded delivery, GitHub's two content
 *    types) and judged by shape (400 when it is not one), and its repository compared with the
 *    source's (422 for another); its number is the key, when `include` takes its kind.
 *
 * The answer's `reason` is fixed words: nothing of the body, a header or the secret is in any
 * answer, and nothing here throws or logs. The SDK's receipt carries `status` and `keys` only;
 * `reason` rides beside them for the route to say, and is not read today.
 */

/**
 * The largest body read: 4 MiB. An `issues` or `pull_request` event carries one issue, whose body
 * GitHub holds to 65,536 characters (at most 384 KiB of JSON, every character escaped; twice that
 * for an edit, which carries the old body too), its repository and its labels: far below it. A
 * larger delivery of another event is refused 413 rather than read whole; it would name no key.
 */
export const WEBHOOK_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** What `receive` answers: the SDK's receipt, and why, in fixed words, when it is not a 2xx. */
export type Receipt = SourceReceipt & { readonly reason?: string };

/** The status of a delivery taken: with keys, or with none (a ping, an event the source does not read). */
export const ACCEPTED = 202;

export const WEBHOOKS_OFF =
  'webhooks are off for this source: no webhookSecret is set in plugins.github, so no delivery can be checked; set webhookSecret: env("GITHUB_WEBHOOK_SECRET") there, the same secret in the repository\'s webhook settings, and restart the worker';
export const NO_SIGNATURE =
  "the delivery carries no X-Hub-Signature-256 header: set the webhook's secret in the repository's webhook settings";
export const BAD_SIGNATURE =
  "the delivery's X-Hub-Signature-256 is not the signature of its body with the source's webhook secret: set the same secret in the repository's webhook settings and in the variable plugins.github.webhookSecret names";
export const TOO_LARGE = `the delivery's body is larger than the ${WEBHOOK_BODY_MAX_BYTES} bytes (4 MiB) this source reads`;
export const UNREADABLE =
  "the event's body is not an issues or pull_request event this source can read";
export const OTHER_REPOSITORY =
  "the event is for another repository than the one this source reads: deliver only that repository's events to this source's webhook";

/** GitHub's signature header: `sha256=` and the HMAC-SHA256 digest as 64 lowercase hex digits. */
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/** What a delivery is judged against: the source's settings and what it learnt of its repository. */
export type WebhookTarget = {
  readonly secret: string | undefined;
  readonly repo: Repo;
  readonly include: ReadonlySet<Kind>;
  /** The repository's numeric id, once a signed event of it said it; it stays the same across a rename. */
  readonly knownId: number | undefined;
  readonly learn: (id: number) => void;
};

function refused(status: number, reason: string): Receipt {
  return { status, keys: [], reason };
}

/**
 * A body read as bytes, at most `WEBHOOK_BODY_MAX_BYTES`; `undefined` when it cannot be read (the
 * stream failed, or was read or locked before).
 */
async function rawBody(request: Request): Promise<Uint8Array | "too large" | undefined> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^\d{1,16}$/.test(declared) &&
    Number(declared) > WEBHOOK_BODY_MAX_BYTES
  ) {
    return "too large";
  }
  const stream = request.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, size);
      }
      size += value.byteLength;
      if (size > WEBHOOK_BODY_MAX_BYTES) {
        return "too large";
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** GitHub's form-encoded delivery: `payload=` and the JSON, URL-encoded. */
const FORM = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;

/** The event's JSON, or undefined when the bytes are not UTF-8, or not JSON (as GitHub sends either form). */
function payloadOf(body: Uint8Array, contentType: string | null): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
  if (contentType !== null && FORM.test(contentType)) {
    const payload = new URLSearchParams(text).get("payload");
    if (payload === null) {
      return undefined;
    }
    text = payload;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The repository every issues and pull_request event names: its id and its `owner/name`. */
const repositoryShape = z.object({
  id: z.number().int().positive(),
  full_name: z.string().max(256),
});

type Repository = Infer<typeof repositoryShape>;

const issuesEvent = z.object({
  issue: z.object({ number: issueNumber, pull_request: z.unknown().optional() }),
  repository: repositoryShape,
});

const pullRequestEvent = z.object({
  pull_request: z.object({ number: issueNumber }),
  repository: repositoryShape,
});

/**
 * Whether the event's repository is the source's: by its numeric id once known (a name can pass to
 * another repository after a rename or a transfer, an id never does), else by its full name in any
 * case, as GitHub compares names; the first match teaches the id.
 */
function sameRepository(target: WebhookTarget, repository: Repository): boolean {
  if (target.knownId !== undefined) {
    return repository.id === target.knownId;
  }
  const same =
    repository.full_name.toLowerCase() === `${target.repo.owner}/${target.repo.name}`.toLowerCase();
  if (same) {
    target.learn(repository.id);
  }
  return same;
}

/** Judges one delivery, in the order the module's comment gives; never throws. */
export async function receiveEvent(target: WebhookTarget, request: Request): Promise<Receipt> {
  if (target.secret === undefined) {
    return refused(401, WEBHOOKS_OFF);
  }
  const header = request.headers.get("x-hub-signature-256");
  if (header === null) {
    return refused(401, NO_SIGNATURE);
  }
  const signed = SIGNATURE.exec(header);
  if (signed === null) {
    return refused(401, BAD_SIGNATURE);
  }
  const body = await rawBody(request);
  if (body === "too large") {
    return refused(413, TOO_LARGE);
  }
  if (body === undefined) {
    return refused(400, UNREADABLE);
  }
  const expected = createHmac("sha256", target.secret).update(body).digest();
  const given = Buffer.from(signed[1] as string, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refused(401, BAD_SIGNATURE);
  }

  // Signed by the holder of the secret: only now is anything of the delivery read as data.
  const event = request.headers.get("x-github-event");
  if (event !== "issues" && event !== "pull_request") {
    return { status: ACCEPTED, keys: [] };
  }
  const payload = payloadOf(body, request.headers.get("content-type"));
  let number: number;
  let kind: Kind;
  let repository: Repository;
  if (event === "issues") {
    const parsed = issuesEvent.safeParse(payload);
    if (!parsed.success) {
      return refused(400, UNREADABLE);
    }
    number = parsed.data.issue.number;
    // GitHub sends a pull request's changes as pull_request events; one marked so is read as one.
    const pull = parsed.data.issue.pull_request;
    kind = pull === undefined || pull === null ? "issues" : "pull_requests";
    repository = parsed.data.repository;
  } else {
    const parsed = pullRequestEvent.safeParse(payload);
    if (!parsed.success) {
      return refused(400, UNREADABLE);
    }
    number = parsed.data.pull_request.number;
    kind = "pull_requests";
    repository = parsed.data.repository;
  }
  if (!sameRepository(target, repository)) {
    return refused(422, OTHER_REPOSITORY);
  }
  // The key is the number written as GitHub numbers issues: decimal digits, nothing else.
  return { status: ACCEPTED, keys: target.include.has(kind) ? [String(number)] : [] };
}
