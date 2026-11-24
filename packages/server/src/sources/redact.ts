/**
 * The admin connection string's parts, hidden from every word the setup flow sends or logs. A
 * driver's message often names the host, the user or the whole string ("password authentication
 * failed for user …", "getaddrinfo ENOTFOUND db.internal"), and an engine's refusal may name the
 * host ("would send the password to … in the clear"): each part is replaced wherever it appears.
 *
 * A secret (the password, a credential in the query string, the whole string) is hidden whatever
 * its length. A short one, which could also be a piece of an ordinary word, is hidden only where it
 * stands as a word of its own. The user and the host are names, not secrets, and often common ones
 * (`postgres`, `localhost`): they are hidden only as whole words of three characters or more, and
 * never where they begin a connection string the setup's own fix words show (`postgres://…`).
 */

/** What stands in for a hidden part. */
export const HIDDEN = "[hidden]";

/** A secret at least this long is hidden wherever it appears, inside a word too. */
const HIDDEN_ANYWHERE = 8;

/** A user or a host shorter than this is not hidden: it says nothing, and would wreck words. */
const SHORTEST_NAME = 3;

/** Query-string parameters an engine reads as a credential (libpq's, the drivers', the tokens). */
const SECRET_PARAMETER = /pass|secret|token|key|auth|credential/i;

/** One part to hide: its text, and whether it is hidden only as a word of its own. */
export type SecretPart = { readonly text: string; readonly bounded: boolean };

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The parts of a connection string that must never be shown back: the whole string; its password
 * and every credential in its query string, as written and decoded; its user and its host. A string
 * the URL parser cannot read hides as a whole, and each of its words that holds an `@` or a `:` too.
 */
export function secretParts(url: string): readonly SecretPart[] {
  const parts = new Map<string, boolean>();
  const secret = (text: string) => {
    if (text !== "") {
      parts.set(text, text.length < HIDDEN_ANYWHERE && parts.get(text) !== false);
    }
  };
  const name = (text: string) => {
    if (text.length >= SHORTEST_NAME && !parts.has(text)) {
      parts.set(text, true);
    }
  };
  for (const whole of [url, url.trim()]) {
    if (whole !== "") {
      parts.set(whole, false);
    }
  }
  try {
    const parsed = new URL(url.trim());
    for (const part of [parsed.password, decoded(parsed.password)]) {
      secret(part);
    }
    for (const [key, value] of parsed.searchParams) {
      if (SECRET_PARAMETER.test(key)) {
        secret(value);
        secret(encodeURIComponent(value));
      }
    }
    for (const part of [parsed.username, decoded(parsed.username), parsed.host, parsed.hostname]) {
      name(part);
    }
    // A bracketed IPv6 host as a driver prints it: without the brackets.
    name(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    for (const word of url.split(/[\s/?#]+/)) {
      if (/[@:]/.test(word)) {
        parts.set(word, false);
      }
    }
  }
  return [...parts.entries()]
    .map(([text, bounded]) => ({ text, bounded }))
    .sort((a, b) => b.text.length - a.text.length);
}

/**
 * A path segment at least this long reads as a token, not a word: the shortest hook tokens in use
 * (a Slack hook's last segment) are 24 characters, while the words an API path is made of (`v1`,
 * `services`, `webhooks`, `incoming-webhooks`) stay under 20.
 */
const TOKEN_SEGMENT = 20;

/**
 * The parts of a secret value that is not a connection string: an API key, a signing secret, a
 * plugin's token or the address of a webhook. The value as written, trimmed and URL-encoded; for an
 * address, also its password, each query value whose key reads as a credential (`SECRET_PARAMETER`,
 * as `secretParts` hides a string's), and its path when one of its segments is long enough to be a
 * token (`TOKEN_SEGMENT`), with each such segment: `?v=2` and `/v1` stay readable. Every part is a
 * secret: a short one is hidden only where it stands as a word of its own, as `secretParts` hides a
 * short password.
 */
export function secretValueParts(value: string): readonly SecretPart[] {
  const texts = new Set([value, value.trim(), encodeURIComponent(value.trim())]);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) && URL.canParse(value.trim())) {
    const parsed = new URL(value.trim());
    texts.add(parsed.password);
    texts.add(decoded(parsed.password));
    const tokens = parsed.pathname
      .split("/")
      .filter((segment) => decoded(segment).length >= TOKEN_SEGMENT);
    if (tokens.length > 0) {
      texts.add(parsed.pathname);
      for (const token of tokens) {
        texts.add(token);
        texts.add(decoded(token));
      }
    }
    for (const [key, query] of parsed.searchParams) {
      if (SECRET_PARAMETER.test(key)) {
        texts.add(query);
        texts.add(encodeURIComponent(query));
      }
    }
  }
  return [...texts]
    .filter((text) => text !== "" && text !== "/")
    .map((text) => ({ text, bounded: text.length < HIDDEN_ANYWHERE }))
    .sort((a, b) => b.text.length - a.text.length);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every part hidden, the longest first so a part inside another goes with it. */
export function hideSecrets(text: string, parts: readonly SecretPart[]): string {
  let hidden = text;
  for (const part of parts) {
    hidden = part.bounded
      ? hidden.replace(
          new RegExp(`(?<![A-Za-z0-9_.%-])${escaped(part.text)}(?![A-Za-z0-9_%-]|://)`, "g"),
          HIDDEN,
        )
      : hidden.replaceAll(part.text, HIDDEN);
  }
  return hidden;
}
