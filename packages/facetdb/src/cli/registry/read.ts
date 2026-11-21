import { RegistryError, type RegistryIndex, readRegistryIndex } from "../../plugin/index.ts";
import type { CliDeps } from "../program.ts";

/**
 * The one way the plugin registry's index is read: `facetdb add` and the studio's gallery both
 * resolve the address, judge it, read the text and parse the index here, so they refuse and fail
 * alike. The address is `--registry` (add only), else `FACETDB_REGISTRY`, else the default; it is
 * an http or https address, fetched, or the path of a file, read from the project's directory.
 * Everything that comes back is data from outside: an address that holds a username or a password,
 * or is not one of those, is never fetched and is refused in fixed words that do not echo it; no
 * caught error's text is kept (each kind of failure has its own words, since what an error says can
 * quote the address, credentials included); the address shown has its credentials, query and
 * fragment stripped.
 */

/** Where the registry is read from unless `--registry` or `FACETDB_REGISTRY` names another. */
export const DEFAULT_REGISTRY = "https://registry.facetdb.dev/index.json";

/** One read of the index may take this long. */
export const REGISTRY_TIMEOUT_MS = 10_000;
/** The largest index text read, in characters; the real index is a few hundred lines. */
export const MAX_INDEX_CHARS = 2_000_000;
/** How many of an index's problems, and how many characters of a reason, the answer holds. */
const MAX_PROBLEMS = 3;
const MAX_REASON = 300;

/**
 * The registry's address: `flag` (`facetdb add --registry`) if given, else `FACETDB_REGISTRY`, else
 * the default. The value is trimmed, and an empty one counts as not set.
 */
export function registryAddress(
  env: Readonly<Record<string, string | undefined>>,
  flag?: string,
): string {
  const named = (flag ?? env["FACETDB_REGISTRY"])?.trim();
  return named === undefined || named === "" ? DEFAULT_REGISTRY : named;
}

/** Control characters and the marks that reverse text direction: a terminal would obey them. */
const UNPRINTABLE = "[\\p{Cc}\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]";

/** Text from outside made safe to print: what a terminal could obey becomes `?`, lines stay lines. */
export function plain(text: string): string {
  return text.replace(new RegExp(UNPRINTABLE, "gu"), (character) =>
    character === "\n" ? character : "?",
  );
}

/** What an address is: one to fetch, a file to read, or refused in words that do not echo it. */
export type CheckedRegistry =
  | {
      readonly usable: true;
      readonly kind: "web" | "file";
      /** The address as given: what is fetched or opened, never printed. */
      readonly address: string;
      /**
       * What the operator's own terminal may show: a web address without credentials, query and
       * fragment, or the path of the file as it passed the check.
       */
      readonly shown: string;
      /**
       * What any other reader may be shown (the studio's gallery): the same for a web address, and
       * fixed words for a file, whose path is the server's business.
       */
      readonly public: string;
    }
  | { readonly usable: false; readonly why: string };

/** Plain http is read on this machine only; anything else that carries the index is https. */
function isLoopback(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

/** Whether an address may carry the index: https anywhere, plain http only on this machine. */
export function mayCarryRegistry(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

/** Two or more letters then a colon: a scheme (`https:`, `ftp:`, `javascript:`); `C:` is a drive. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * What a value with no scheme must not look like to be taken for a file: a mistyped web address
 * (`https//host`, `https:/host`, `//host`, `host/path?token=...`, `user@host`) or a network share
 * (`\\server`). A path of a file holds none of `@`, `?` and `#`, and neither starts that way.
 */
const NOT_A_PATH = /^(?:[a-z][a-z0-9+.-]*\/\/|\/\/|\\\\)|[@?#]/i;

/** Where an address came from: the variable, or the flag of `facetdb add`. */
export type AddressSource = "env" | "flag";

/**
 * Judged before anything is fetched or opened, and never echoed. A web address must parse, hold no
 * username or password, and be https (http on this machine); what has no scheme is the path of a
 * file unless it looks like a mistyped web address. A refusal names where the value was set.
 */
export function checkRegistryAddress(
  address: string,
  source: AddressSource = "env",
): CheckedRegistry {
  const where = source === "flag" ? "the --registry of facetdb add" : "FACETDB_REGISTRY";
  const refused = (why: string): CheckedRegistry => ({
    usable: false,
    why: `${where} is not an address FacetDB can read (${why}): set ${source === "flag" ? "it" : "it, or pass --registry to facetdb add,"} to an http or https address without a username or a password (http only for this machine), such as ${DEFAULT_REGISTRY}, or to the path of an index.json file, or ${source === "flag" ? "leave it out" : "unset it"} to use that one`,
  });
  if (address.trim() === "") {
    return refused("it is empty");
  }
  if (!SCHEME.test(address)) {
    if (new RegExp(UNPRINTABLE, "u").test(address)) {
      return refused("it holds control characters");
    }
    if (NOT_A_PATH.test(address)) {
      return refused("it is neither a web address nor the path of a file");
    }
    return {
      usable: true,
      kind: "file",
      address,
      shown: address,
      public: "a file in the project directory",
    };
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return refused("it is not a web address");
  }
  // `https:/host` parses, but it is a slip of the keys: a web address is written with two slashes.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    return refused("it is not a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refused("it is not an http or https address");
  }
  if (url.username !== "" || url.password !== "") {
    return refused("it holds a username or a password");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return refused("plain http is read only on this machine, so use https");
  }
  url.search = "";
  url.hash = "";
  return { usable: true, kind: "web", address, shown: url.href, public: url.href };
}

/** What the reader needs of its caller: the network, a time limit and the project's files. */
export type RegistryDeps = {
  readonly fetch: CliDeps["fetch"];
  readonly abortAfter: CliDeps["abortAfter"];
  readonly workspace: Pick<CliDeps["workspace"], "peek" | "lines">;
};

/** What one read came to: the index, or why it could not be had, in words. */
export type RegistryRead = { readonly index: RegistryIndex } | { readonly why: string };

type Text = { readonly text: string } | { readonly why: string };

/**
 * The body as text, read in pieces and given up on once it passes the limit: a body is never
 * buffered whole before it is judged. Undefined when it is longer than `MAX_INDEX_CHARS`.
 */
async function limitedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_INDEX_CHARS) {
        return undefined;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const tooLarge = `the registry's index is larger than ${MAX_INDEX_CHARS} characters`;

/** Whether a failed fetch was the platform refusing a redirect (undici: a TypeError whose cause says so). */
function isRedirectRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  const words = [error.message, cause instanceof Error ? cause.message : ""].join(" ");
  return /redirect/i.test(words);
}

async function webText(address: string, deps: RegistryDeps): Promise<Text> {
  const whereToChange =
    address === DEFAULT_REGISTRY ? "; FACETDB_REGISTRY sets another address" : "";
  let response: Response;
  try {
    // `redirect: "error"`: a redirect is never followed, so no request is sent to an address this
    // reader did not judge (one that is plain http, say); the address to set is the final one.
    response = await deps.fetch(address, {
      signal: deps.abortAfter(REGISTRY_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (isRedirectRefusal(error)) {
      return {
        why: "the registry answered with a redirect, which is not followed: set FACETDB_REGISTRY (or --registry for facetdb add) to the address it redirects to",
      };
    }
    return {
      why: timedOut
        ? `the registry did not answer within ${REGISTRY_TIMEOUT_MS / 1000} seconds${whereToChange}`
        : `the registry could not be reached${whereToChange}`,
    };
  }
  if (!response.ok) {
    return { why: `the registry answered with HTTP status ${response.status}${whereToChange}` };
  }
  let text: string | undefined;
  try {
    text = await limitedText(response);
  } catch {
    return { why: `the registry's answer could not be read to the end${whereToChange}` };
  }
  return text === undefined ? { why: tooLarge } : { text };
}

async function fileText(path: string, deps: RegistryDeps): Promise<Text> {
  try {
    const found = await deps.workspace.peek(path);
    if (found.kind === "none") {
      return { why: "the registry file does not exist" };
    }
    if (found.kind === "other") {
      return { why: "the registry path is not a regular file" };
    }
    // The size is known before a byte is read: a file with no newline would otherwise be held
    // whole as one line before any check. Bytes against a cap in characters is the stricter test,
    // and no real index comes near it.
    if (found.bytes !== undefined && found.bytes > MAX_INDEX_CHARS) {
      return { why: tooLarge };
    }
    let text = "";
    for await (const line of deps.workspace.lines(path)) {
      text += `${line}\n`;
      if (text.length > MAX_INDEX_CHARS) {
        return { why: tooLarge };
      }
    }
    return { text };
  } catch {
    return { why: "the registry file could not be read" };
  }
}

function cut(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON)}...`;
}

function parsed(text: string): RegistryRead {
  try {
    return { index: readRegistryIndex(text) };
  } catch (error) {
    if (!(error instanceof RegistryError)) {
      return { why: "the registry's index could not be read" };
    }
    const more = error.problems.length - MAX_PROBLEMS;
    const shown = error.problems.slice(0, MAX_PROBLEMS).join("; ");
    return {
      why: cut(
        `the registry's index cannot be read: ${shown}${more > 0 ? `; and ${more} more` : ""}`,
      ),
    };
  }
}

/**
 * One read of the index at an address `checkRegistryAddress` found usable. It never rejects. The
 * raw address, wherever a reason turns it up (the reader's problems quote the index), is replaced
 * by the address as shown, by a function so that no `$` in it is read as a pattern; control
 * characters in a reason are made harmless.
 */
export async function readRegistry(
  checked: Extract<CheckedRegistry, { readonly usable: true }>,
  deps: RegistryDeps,
): Promise<RegistryRead> {
  let result: RegistryRead;
  try {
    const got =
      checked.kind === "web"
        ? await webText(checked.address, deps)
        : await fileText(checked.address, deps);
    result = "text" in got ? parsed(got.text) : got;
  } catch {
    // Whatever else failed (the timeout signal's own factory, say): fixed words, nothing kept.
    result = { why: "the registry could not be read" };
  }
  if ("index" in result) {
    return result;
  }
  // The words may be shown to others than the operator, so the address stands as `public`.
  const why =
    checked.address === ""
      ? result.why
      : result.why.replaceAll(checked.address, () => checked.public);
  return { why: plain(why) };
}
