import { oneLine } from "./message.ts";

/**
 * A delivery that failed, in words a person can act on: which step the SMTP server refused and
 * what it said. It is built fresh from a few fields of what the transport threw, never wrapped
 * around it: nodemailer hangs the command, the server's response and sometimes the transport's
 * options on its errors, so the thrown object carries no `cause` and none of those properties.
 *
 * The message is two parts (the review of 35030fa). The first is FacetDB's own sentence, made of
 * fixed words and settings that are not secret (host, port, from, the channel's address); nothing
 * ever runs over it, so it reads the same whatever the password is. The second is the only
 * untrusted part, the server's reply (or the failed connection's own words): when any form of the
 * password appears in it (`echoesPassword`: as written, percent-encoded, in base64 or base64url at
 * any byte offset, the whole login lines with the user, padded or not; any 8 characters in a row of
 * a longer form, so a truncated echo counts, also across line breaks and reply codes; a form
 * shorter than 8 only as a whole token), the whole reply is left out and fixed words say so, the
 * reply code kept; and a refused login with a password shorter than 8 characters always leaves its
 * reply out. It is never blanked in place, since what is blanked would tell the password. A reply
 * kept is put on one line and clipped to 300 characters, with each 334 line (a SASL challenge or
 * answer) dropped and an AUTH command's argument left out: rules that do not read the password.
 */

/** Which step failed, for a caller that acts on it; the message says the same in words. */
export type DeliveryFailure =
  | "address-refused"
  | "login-refused"
  | "sender-refused"
  | "recipient-refused"
  | "message-refused"
  | "tls-failed"
  | "timed-out"
  | "unreachable"
  | "stopped"
  | "failed";

/** The SMTP reply codes of a temporary refusal: the server asks the client to try again later. */
function isTemporary(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * The failures worth trying again unchanged when the server gave no 4xx or 5xx: it did not answer
 * (or not yet), the worker stopped (the message may have been sent), or the failure is of no kind
 * FacetDB knows. The other kinds (`address-refused`, `tls-failed`, a refused login, sender,
 * recipient or message) need a change of settings or address first.
 */
const TRIED_AGAIN: ReadonlySet<DeliveryFailure> = new Set([
  "timed-out",
  "unreachable",
  "stopped",
  "failed",
]);

/**
 * A 5xx reply that is a sending quota or a rate limit, which lifts with time though its code says
 * the refusal is permanent (so a notification is not given up at once for it): the enhanced status
 * code 5.4.5 (RFC 3463's congestion, which Gmail answers its daily sending limit with, `550 5.4.5
 * Daily user sending limit exceeded`), and any reply naming a quota (`552 5.2.2 ... over quota`) or
 * a limit as a word of its own (`554 5.7.0 ... sending limit`, `rate limited`; never inside another
 * word, such as "unlimited"). Read in the server's reply only, never in the transport's own error
 * words. Its cost: a 5xx naming another limit (a message size limit) is tried for 24 hours, as
 * every failure was before, rather than given up at once.
 */
const QUOTA_REPLY = /\b5\.4\.5\b|quota|\blimit/i;

/** What the words say of a refusal that may pass later: the server asked, or its reply names a quota. */
const ASKED_LATER = "for now and asked to try again later";
const QUOTA_LATER = "for now: its reply names a sending quota or limit, which lifts with time";

export class EmailDeliveryError extends Error {
  readonly failure: DeliveryFailure;
  /** The SMTP reply code the server refused with, when it answered one (`status`, as Slack's and Telegram's errors name theirs). */
  readonly status: number | undefined;
  /**
   * Whether trying again unchanged can succeed, which FacetDB reads before `status` (an SMTP reply
   * code is not an HTTP status, and a notification refused for good is given up at once). With a
   * 4xx or 5xx reply code, the code says: true for a 4xx, the server asking to try again later;
   * false for a 5xx, unless its reply names a sending quota or limit (`QUOTA_REPLY`, the `quota`
   * argument). Without one, the kind says (`TRIED_AGAIN`): true when the server did not answer, the
   * worker stopped, or the kind is unknown; false for a failure that needs a change of settings or
   * address first.
   */
  readonly temporary: boolean;

  constructor(failure: DeliveryFailure, message: string, status?: number, quota = false) {
    super(message);
    this.name = "EmailDeliveryError";
    this.failure = failure;
    this.status = status;
    this.temporary =
      status !== undefined && status >= 400 && status < 600
        ? isTemporary(status) || quota
        : TRIED_AGAIN.has(failure);
  }
}

/** What a delivery knows of itself when it fails: where it went and the login it used. */
export type DeliveryScene = {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly to: string;
  readonly user: string | undefined;
  readonly password: string | undefined;
};

const WORDS_LIMIT = 300;
/** The shortest piece of a form of the password that leaves a reply out: 8 characters, 6 bytes of base64. */
const WINDOW = 8;

/** A 334 line: a SASL challenge, or the client's answer echoed back, base64 throughout. */
const SASL_LINE = /^\s*334(?:[\s-]|$)/;
/**
 * An AUTH command's argument (its initial response, base64) as nodemailer writes the command, in
 * capitals: left out, the mechanism kept. "AUTH command used when not advertised" stays as written.
 */
const AUTH_ARGUMENT = /\b(AUTH\s+[A-Z0-9_-]+)\s+\S+/g;
/** The reply code and enhanced status code at the head of a reply line: `535-5.7.8 `. */
const REPLY_CODES = /^\s*\d{3}[ -](?:\d\.\d{1,3}\.\d{1,3}\s+)?/;

/**
 * The base64 of `bytes` as it reads inside any longer encoded text: for each of the three byte
 * offsets, the characters made of the password's bytes alone; plus the whole encoding with and
 * without its padding, which is all a password shorter than a group leaves.
 */
function base64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (const shift of [0, 1, 2]) {
    const shifted = Buffer.concat([Buffer.alloc(shift), bytes]);
    const encoded = shifted.toString("base64");
    forms.push(encoded.slice(shift === 0 ? 0 : 4, Math.floor(shifted.length / 3) * 4));
    if (shift === 0) {
      forms.push(encoded, encoded.replace(/=+$/, ""));
    }
  }
  return forms;
}

/** `value` in base64 and base64url, each padded and not. */
function wholeEncodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const url = bytes.toString("base64url");
  return [
    base64,
    base64.replace(/=+$/, ""),
    url,
    `${url}${"=".repeat((4 - (url.length % 4)) % 4)}`,
  ];
}

/**
 * Every form of the password a reply could carry, never an empty one: as written, percent-encoded,
 * its base64 and base64url at each byte offset, and whole the login lines a client sends with it
 * (SASL PLAIN's `\0user\0password`, `user\0password` and `user\0user\0password`, each in base64 and
 * base64url, padded and not). The user is known, so the whole lines are listed: the offset slices
 * alone find nothing for a password of 3 or 4 bytes at some offsets (the review of 3bfd2c9).
 */
function passwordForms(password: string, user: string | undefined): readonly string[] {
  const percent = encodeURIComponent(password);
  const base64 = base64Forms(Buffer.from(password, "utf8"));
  const lines =
    user === undefined
      ? []
      : [
          `\u0000${user}\u0000${password}`,
          `${user}\u0000${password}`,
          `${user}\u0000${user}\u0000${password}`,
        ];
  const forms = [
    password,
    percent,
    // The same escapes in lower case (`%2f`), as some encoders write them.
    percent.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    ...base64,
    ...base64.map((form) => form.replace(/\+/g, "-").replace(/\//g, "_")),
    ...lines.flatMap(wholeEncodings),
  ];
  return [...new Set(forms)].filter((form) => form !== "");
}

const WORD_CHARACTER = /[A-Za-z0-9]/;

/** Whether `form` stands in `text` as a whole token: no letter or digit right before or after it. */
function asToken(text: string, form: string): boolean {
  for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
    const before = text.charAt(at - 1);
    const after = text.charAt(at + form.length);
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `reply` holds a form of the password. A form of WINDOW characters or more counts by any
 * WINDOW characters of it in a row (a truncated echo), anywhere, a line break or a reply code in
 * between included. A shorter form counts only as a whole token: `e` or `user` inside the server's
 * own words is not an echo, and counting it would make the choice to leave a reply out tell a bit
 * of the password (the review of 3bfd2c9). What remains: a long password made of dictionary words
 * still decides, when the reply holds 8 characters of it, that the reply is left out; that one bit
 * is the password's own to give and no rule that reads the password can take it away.
 */
function echoesPassword(reply: string, password: string, user: string | undefined): boolean {
  const lines = reply.split(/\r\n|[\n\r]/);
  const readings = [
    reply,
    reply.replace(/\s+/g, ""),
    lines.map((line) => line.replace(REPLY_CODES, "").replace(/\s+/g, "")).join(""),
  ];
  return passwordForms(password, user).some((form) => {
    if (form.length < WINDOW) {
      return asToken(reply, form);
    }
    for (let at = 0; at + WINDOW <= form.length; at += 1) {
      const piece = form.slice(at, at + WINDOW);
      if (readings.some((reading) => reading.includes(piece))) {
        return true;
      }
    }
    return false;
  });
}

/** The reply kept: 334 lines dropped, AUTH arguments left out, one line, clipped. Reads no secret. */
function keptReply(reply: string): string {
  const words = oneLine(
    reply
      .split(/\r\n|[\n\r]/)
      .filter((line) => !SASL_LINE.test(line))
      .map((line) => line.replace(AUTH_ARGUMENT, "$1 [argument left out]"))
      .join(" "),
  );
  const characters = Array.from(words);
  return characters.length <= WORDS_LIMIT
    ? words
    : `${characters.slice(0, WORDS_LIMIT - 1).join("")}…`;
}

/** Reads one field of what the transport threw, as the type it must have, or nothing. */
function field<Kind extends "string" | "number">(
  thrown: unknown,
  key: string,
  kind: Kind,
): (Kind extends "string" ? string : number) | undefined {
  if (typeof thrown !== "object" || thrown === null) {
    return undefined;
  }
  const value: unknown = (thrown as Readonly<Record<string, unknown>>)[key];
  return typeof value === kind ? (value as Kind extends "string" ? string : number) : undefined;
}

const UNREACHABLE = new Set([
  "ECONNECTION",
  "ESOCKET",
  "EDNS",
  "EPROXY",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** The step that failed, read from nodemailer's error code and the command it was answering. */
function failureOf(code: string | undefined, command: string | undefined): DeliveryFailure {
  switch (code) {
    case "EAUTH":
    case "ENOAUTH":
      return "login-refused";
    case "EENVELOPE":
      return command === "MAIL FROM" ? "sender-refused" : "recipient-refused";
    case "EMESSAGE":
      return "message-refused";
    case "ETLS":
    case "EREQUIRETLS":
      return "tls-failed";
    case "ETIMEDOUT":
      return "timed-out";
    case "EABORT":
      return "stopped";
    default:
      return code !== undefined && UNREACHABLE.has(code) ? "unreachable" : "failed";
  }
}

/**
 * FacetDB's own sentence for a failed step: fixed words and settings that are not secret. `later`
 * is what it says of a refusal that may pass later (`ASKED_LATER`, `QUOTA_LATER`), undefined for
 * one that needs a change first.
 */
function what(failure: DeliveryFailure, scene: DeliveryScene, later: string | undefined): string {
  const server = `the SMTP server ${scene.host}:${scene.port}`;
  switch (failure) {
    case "login-refused":
      return later !== undefined
        ? `${server} refused the login ${later}`
        : `${server} refused the login: check user and the variable password names`;
    case "sender-refused":
      return later !== undefined
        ? `${server} refused the sender ${scene.from} ${later}`
        : `${server} refused the sender ${scene.from}: from must be an address this server lets the login send from`;
    case "recipient-refused":
      return later !== undefined
        ? `${server} refused the recipient ${scene.to} ${later}`
        : `${server} refused the recipient ${scene.to}: check the address of the channel`;
    case "message-refused":
      return later !== undefined
        ? `${server} refused the message ${later}`
        : `${server} refused the message`;
    case "tls-failed":
      return later !== undefined
        ? `${server} refused TLS ${later}, and FacetDB sends nothing without it`
        : `TLS with ${server} failed, and FacetDB sends nothing without it: the server must offer STARTTLS on this port with a certificate valid for ${scene.host}, or take secure: true on its TLS port (465)`;
    case "timed-out":
      return `${server} did not answer in time`;
    case "unreachable":
      return later !== undefined
        ? `${server} closed the connection ${later}`
        : `${server} could not be reached: check host and port`;
    case "stopped":
      return `FacetDB stopped while the email to ${scene.to} was being sent; it may or may not have been sent`;
    default:
      return later !== undefined
        ? `${server} turned the email to ${scene.to} away ${later}`
        : `the email to ${scene.to} through ${server} failed`;
  }
}

/** A send the server answered without taking the recipient: a failed delivery all the same. */
export function recipientNotAccepted(scene: DeliveryScene): EmailDeliveryError {
  return new EmailDeliveryError("recipient-refused", what("recipient-refused", scene, undefined));
}

/**
 * The worker stopped the delivery. Before the message was handed to the transport it was not
 * sent; once it was, the connection is ended, but a server that had already accepted the data
 * cannot be made to unsend it, so the words say it may or may not have been sent.
 */
export function deliveryStopped(scene: DeliveryScene, handedOver: boolean): EmailDeliveryError {
  return new EmailDeliveryError(
    "stopped",
    handedOver
      ? what("stopped", scene, undefined)
      : `the email to ${scene.to} was not sent: FacetDB is stopping`,
  );
}

/**
 * The error a failed send becomes: FacetDB's sentence, then the server's reply when no form of the
 * password is in it, or fixed words saying it was left out. The result holds nothing of the thrown
 * object but these words and the reply code, and no `cause`.
 */
export function deliveryFailure(thrown: unknown, scene: DeliveryScene): EmailDeliveryError {
  const code = field(thrown, "code", "string");
  const failure = failureOf(code, field(thrown, "command", "string"));
  const response = field(thrown, "response", "string");
  const reply =
    response ??
    field(thrown, "message", "string") ??
    (typeof thrown === "string" ? thrown : undefined);
  const replyCode = field(thrown, "responseCode", "number");
  const status =
    replyCode !== undefined && Number.isInteger(replyCode) && replyCode >= 200 && replyCode < 600
      ? replyCode
      : undefined;
  // A 5xx reply naming a sending quota or limit lifts with time (`QUOTA_REPLY`).
  const quota =
    status !== undefined && status >= 500 && response !== undefined && QUOTA_REPLY.test(response);
  const sentence = what(
    failure,
    scene,
    isTemporary(status) ? ASKED_LATER : quota ? QUOTA_LATER : undefined,
  );
  const label = response === undefined ? "The error was" : "The server said";
  const { password, user } = scene;
  const secret = password !== undefined && password !== "";
  // A short password could stand in a refused login's reply as an ordinary word, where no rule
  // tells an echo from the server's own words: that reply is always left out, its code kept.
  const shortLogin = secret && failure === "login-refused" && password.length < WINDOW;
  let message = sentence;
  if (reply !== undefined && (shortLogin || (secret && echoesPassword(reply, password, user)))) {
    message =
      response === undefined
        ? `${sentence}. The error's words were left out, as they could carry the login`
        : `${sentence}. The server answered${status === undefined ? "" : ` ${status}`}; its words were left out, as they could carry the login`;
  } else if (reply !== undefined && keptReply(reply) !== "") {
    message = `${sentence}. ${label}: ${keptReply(reply)}`;
  }
  return new EmailDeliveryError(failure, message, status, quota);
}
