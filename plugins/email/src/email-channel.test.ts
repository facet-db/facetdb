import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { env, facetdb, noul, type PluginSettings, VERSION } from "facetdb";
import {
  createPluginHost,
  loadPlugin,
  type PluginContext,
  type PluginHostError,
} from "facetdb/plugin";
import { createTransport as nodemailerCreateTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import {
  type ChannelMessage,
  createEmailPlugin,
  type EmailDeliveryError,
  type EmailSettings,
  email,
  isLoopback,
  type MakeTransport,
  nodemailerTransport,
  type OutgoingMail,
  type SendResult,
  SMTP_TIMEOUTS,
  type SmtpOptions,
  SUBJECT_LIMIT,
  transportOptions,
} from "./index.ts";

/**
 * The email channel on a handwritten transport: no test opens a socket or reaches an SMTP server.
 * What it proves: the message's fields; that no line break from an alert's text, the configured
 * `from` or the channel's `where` reaches a header; the TLS options of each kind of host; each
 * refusal when the config loads; a server's words kept and the password in none of what a delivery
 * throws; and the plugin passing `loadPlugin`'s and the host's checks.
 */

const PASSWORD = "Tr0ub4dor&3-smtp-s3cret";
const USER = "alerts@example.com";
const NUL = String.fromCharCode(0);
const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const base64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
/** The password as written and in each form an SMTP login sends it: none may leave a delivery. */
const PASSWORD_FORMS = [
  PASSWORD,
  base64(PASSWORD),
  base64(`${NUL}${USER}${NUL}${PASSWORD}`),
  base64(`${USER}${NUL}${PASSWORD}`),
  base64url(PASSWORD),
  encodeURIComponent(PASSWORD),
];

/** FacetDB's own sentence for a refused login on the test settings, the same whatever the password. */
const LOGIN_REFUSED =
  "the SMTP server smtp.example.com:587 refused the login: check user and the variable password names";
/** What stands for a server's reply that was left out, its reply code kept. */
const leftOut = (code: number) =>
  `The server answered ${code}; its words were left out, as they could carry the login`;

/** Line breaks a header must never receive, written by code point so the file holds none. */
const CR = "\r";
const LF = "\n";
const NEL = String.fromCodePoint(0x85);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const INJECTION = `${CR}${LF}Bcc: attacker@example.com`;
const BREAKS = [CR, LF, `${CR}${LF}`, NEL, LINE_SEPARATOR, PARAGRAPH_SEPARATOR, "\v", "\f"];

const signal = new AbortController().signal;

type Fake = {
  readonly createTransport: MakeTransport;
  readonly made: SmtpOptions[];
  readonly sent: OutgoingMail[];
  readonly closed: () => number;
};

/** A transport that records what it is made with and sent, and answers as `answer` says. */
function fakeTransport(answer: (mail: OutgoingMail) => Promise<SendResult> = accepted): Fake {
  const made: SmtpOptions[] = [];
  const sent: OutgoingMail[] = [];
  let closed = 0;
  return {
    made,
    sent,
    closed: () => closed,
    createTransport: (options) => {
      made.push(options);
      return {
        send: async (mail) => {
          sent.push(mail);
          return answer(mail);
        },
        close: () => {
          closed += 1;
        },
      };
    },
  };
}

async function accepted(mail: OutgoingMail): Promise<SendResult> {
  return { accepted: [mail.to], rejected: [] };
}

function failing(thrown: unknown): (mail: OutgoingMail) => Promise<SendResult> {
  return async () => {
    throw thrown;
  };
}

const SETTINGS = {
  host: "smtp.example.com",
  user: USER,
  password: PASSWORD,
  from: "alerts@example.com",
};

function pluginOn(fake: Fake) {
  return createEmailPlugin({ createTransport: fake.createTransport });
}

type EmailPlugin = ReturnType<typeof pluginOn>;

function emailChannel(plugin: EmailPlugin) {
  const found = plugin.channels["email"];
  if (found === undefined) {
    throw new Error("the plugin has no email channel");
  }
  return found;
}

/** The plugin's settings as the host hands them over: parsed by the plugin's own schema, frozen. */
function contextOf(
  plugin: EmailPlugin,
  input: Readonly<Record<string, unknown>>,
  stop: AbortSignal = signal,
): PluginContext<EmailSettings> {
  const config = plugin.manifest.config.parse(input) as EmailSettings;
  const secrets = config.password === undefined ? {} : { password: config.password };
  return { config: Object.freeze(config), secrets: Object.freeze(secrets), signal: stop };
}

const ALERT: ChannelMessage = {
  kind: "system-alert",
  severity: "critical",
  text: "The worker has sent no heartbeat for 2 minutes. Project shop, every source. FacetDB is waiting for it.",
  link: "https://facetdb.example.com/alerts",
};

async function deliver(
  fake: Fake,
  message: ChannelMessage = ALERT,
  where = "ops@example.com",
  settings: Readonly<Record<string, unknown>> = SETTINGS,
): Promise<void> {
  const plugin = pluginOn(fake);
  await emailChannel(plugin).deliver(contextOf(plugin, settings), message, { where });
}

/** Every property of a thrown value, hidden ones and its cause included, as text. */
function everythingIn(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }
  if (seen.has(value)) {
    return "";
  }
  seen.add(value);
  const parts = [inspect(value, { depth: 20, showHidden: true, getters: true })];
  const own: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const inner: unknown = (value as Record<string, unknown>)[key];
    own[key] = inner;
    parts.push(`${key}: ${everythingIn(inner, seen)}`);
  }
  parts.push(JSON.stringify(own), JSON.stringify(value), String(value));
  return parts.join("\n");
}

function expectNoPassword(value: unknown): void {
  const all = everythingIn(value);
  for (const form of PASSWORD_FORMS) {
    expect(all).not.toContain(form);
  }
}

/** What `deliver` rejected with; fails the test when it resolved. */
async function failure(delivery: Promise<void>): Promise<EmailDeliveryError> {
  const thrown = await delivery.then(
    () => {
      throw new Error("the delivery succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
  expect((thrown as Error).name).toBe("EmailDeliveryError");
  const error = thrown as EmailDeliveryError;
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expectNoPassword(error);
  return error;
}

/** A nodemailer error as smtp-connection builds one (`_formatError`): code, response, command. */
function smtpError(message: string, code: string, response: string | false, command: string) {
  const error = new Error(response === false ? message : `${message}: ${response}`);
  const responseCode = response === false ? undefined : Number(response.slice(0, 3));
  return Object.assign(error, {
    code,
    command,
    ...(response === false ? {} : { response, responseCode }),
  });
}

describe("the email channel sends one plain-text message to the one address of the channel", () => {
  it("from the configured address, with the severity and the first sentence as the subject, and the text and the link as the body", async () => {
    const fake = fakeTransport();
    await deliver(fake);
    expect(fake.sent).toEqual([
      {
        from: "alerts@example.com",
        to: "ops@example.com",
        subject: "Critical: The worker has sent no heartbeat for 2 minutes.",
        text: `${ALERT.text}\n\nhttps://facetdb.example.com/alerts`,
      },
    ]);
    // Plain text only: the message has exactly these four fields, no html, no attachment.
    expect(Object.keys(fake.sent[0] ?? {}).sort()).toEqual(["from", "subject", "text", "to"]);
    expect(fake.closed()).toBe(1);
  });

  it("names each severity in a word, and a message with no link is its text alone", async () => {
    const fake = fakeTransport();
    for (const severity of ["critical", "warning", "information"] as const) {
      await deliver(fake, {
        kind: "record-notification",
        severity,
        text: "Ticket 42 is urgent (0.97)",
      });
    }
    expect(fake.sent.map((mail) => mail.subject)).toEqual([
      "Critical: Ticket 42 is urgent (0.97)",
      "Warning: Ticket 42 is urgent (0.97)",
      "Information: Ticket 42 is urgent (0.97)",
    ]);
    expect(fake.sent.map((mail) => mail.text)).toEqual(Array(3).fill("Ticket 42 is urgent (0.97)"));
  });

  it(`holds the subject to ${SUBJECT_LIMIT} characters, clipped with an ellipsis, and a text with no words to the severity`, async () => {
    const fake = fakeTransport();
    const long = `${"Backfill of the source tickets ".repeat(10)}failed.`;
    await deliver(fake, { kind: "system-alert", severity: "warning", text: long });
    await deliver(fake, { kind: "system-alert", severity: "warning", text: `${CR}${LF}  ` });
    const [clipped, empty] = fake.sent.map((mail) => mail.subject);
    expect(Array.from(clipped ?? "").length).toBeLessThanOrEqual(SUBJECT_LIMIT);
    expect(clipped).toMatch(/^Warning: Backfill of the source tickets .*…$/);
    expect(empty).toBe("Warning");
  });

  it("sends the same message twice when it is delivered twice: a channel does not deduplicate", async () => {
    const fake = fakeTransport();
    await deliver(fake);
    await deliver(fake);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toEqual(fake.sent[1]);
    expect(fake.made).toHaveLength(2);
    expect(fake.closed()).toBe(2);
  });
});

describe("no line break from an alert's text, from or where reaches a header", () => {
  it("keeps a text holding a CRLF and a Bcc line out of the subject; the body carries it as text", async () => {
    const fake = fakeTransport();
    await deliver(fake, {
      kind: "record-notification",
      severity: "warning",
      text: `Ticket 7 is urgent${INJECTION}`,
    });
    const mail = fake.sent[0];
    expect(mail?.subject).toBe("Warning: Ticket 7 is urgent");
    expect(mail?.to).toBe("ops@example.com");
    expect(mail?.from).toBe("alerts@example.com");
  });

  it("turns every kind of line break, control character and bidirectional control inside the first sentence into a space", async () => {
    const fake = fakeTransport();
    for (const separator of [
      ...BREAKS,
      "\t",
      NUL,
      String.fromCodePoint(0x1b),
      String.fromCodePoint(0x202e),
    ]) {
      // A first line that starts with the break: the subject is taken from the next line with words.
      await deliver(fake, {
        kind: "system-alert",
        severity: "critical",
        text: `${separator}Disk${separator}full${INJECTION}`,
      });
    }
    for (const mail of fake.sent) {
      expect(mail.subject).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u);
      expect(mail.subject).not.toContain("Bcc");
    }
  });

  it("composes, through nodemailer itself, a message whose only recipient is the channel's and with no Bcc header", async () => {
    const fake = fakeTransport();
    await deliver(fake, {
      kind: "system-alert",
      severity: "critical",
      text: `Model failing${INJECTION}${LINE_SEPARATOR}To: second@example.com`,
      link: `https://facetdb.example.com/alerts${INJECTION}`,
    });
    const mail = fake.sent[0] as OutgoingMail;
    // nodemailer's stream transport writes the message to a buffer: no socket is opened.
    const composer = nodemailerCreateTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    });
    const info = await composer.sendMail({ ...mail });
    expect(info.envelope.to).toEqual(["ops@example.com"]);
    const raw = info.message.toString("utf8");
    const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
    // Unfolded, one header per line: exactly one From, To and Subject, and no Bcc or Cc.
    const names = head
      .replace(/\r\n[ \t]+/g, " ")
      .split("\r\n")
      .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
    expect(names.filter((name) => name === "from")).toHaveLength(1);
    expect(names.filter((name) => name === "to")).toHaveLength(1);
    expect(names.filter((name) => name === "subject")).toHaveLength(1);
    expect(names).not.toContain("bcc");
    expect(names).not.toContain("cc");
    expect(head).not.toContain("attacker@example.com");
    expect(head).not.toContain("second@example.com");
    expect(head).not.toMatch(/content-type: text\/html/i);
  });

  it("refuses a where or a from holding a line break where the header is written, even past the schema", async () => {
    for (const where of [`ops@example.com${INJECTION}`, `ops@example.com${LINE_SEPARATOR}`]) {
      const fake = fakeTransport();
      const error = await failure(deliver(fake, ALERT, where));
      expect(error.failure).toBe("address-refused");
      expect(error.message).toMatch(/^where holds a line break/);
      expect(error.message).not.toContain("attacker");
      expect(fake.made).toEqual([]);
    }
    const plugin = pluginOn(fakeTransport());
    const ctx = contextOf(plugin, SETTINGS);
    const smuggled = { ...ctx, config: { ...ctx.config, from: `alerts@example.com${INJECTION}` } };
    const error = await failure(
      emailChannel(plugin).deliver(smuggled, ALERT, { where: "ops@example.com" }),
    );
    expect(error.message).toMatch(/^from holds a line break/);
  });
});

describe("an address is exactly one bare address, refused when the config loads", () => {
  const plugin = pluginOn(fakeTransport());
  const whereSchema = emailChannel(plugin).config;

  const refused: readonly (readonly [string, RegExp])[] = [
    ["a@example.com,b@example.com", /^where holds a list .*name the channel twice/],
    ["a@example.com; b@example.com", /^where holds a list/],
    ["Ops <ops@example.com>", /^where holds a display name/],
    ['"Ops" <ops@example.com>', /^where holds a display name/],
    ["ops@example.com <attacker@example.com>", /^where holds a display name/],
    ["<ops@example.com>", /^where holds a display name/],
    ["ops@example.com (ops)", /^where holds a display name/],
    ["undisclosed-recipients:;", /^where holds a list/],
    ["ops @example.com", /^where holds a space/],
    [`ops@example.com${INJECTION}`, /^where holds a line break/],
    [`ops@example.com${LF}`, /^where holds a line break/],
    [`ops@example.com${LINE_SEPARATOR}`, /^where holds a line break/],
    [`ops@exa${NUL}mple.com`, /^where holds a line break or a control character/],
    ["", /^where is empty/],
    ["ops.example.com", /^where is not one email address .*exactly one @/],
    ["ops@a@example.com", /^where is not one email address/],
    ["ops@", /^where is not an email address FacetDB can send to/],
    ["@example.com", /^where is not an email address/],
    [".ops@example.com", /^where is not an email address/],
    ["ops@-example.com", /^where is not an email address/],
    ["opé@example.com", /^where is not an email address/],
    [`${"a".repeat(65)}@example.com`, /^where is not an email address/],
  ];

  it.each(refused)(
    "refuses where %j with words that name the setting and the fix",
    (where, words) => {
      const parsed = whereSchema.safeParse({ where });
      expect(parsed.success).toBe(false);
      const messages = parsed.error?.issues.map((issue) => issue.message) ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(words);
      expect(messages[0]).toMatch(/such as|name the channel twice|exactly one @/);
    },
  );

  it.each([
    "ops@example.com",
    "first.last+alerts@mail.example.co.uk",
    "o'brien@example.ie",
    "ops@localhost",
    "ops@xn--bcher-kva.example",
  ])("takes where %j", (where) => {
    expect(whereSchema.safeParse({ where }).success).toBe(true);
  });

  it("refuses a missing where, and keys other than where", () => {
    const missing = whereSchema.safeParse({});
    expect(missing.error?.issues[0]?.message).toMatch(
      /^where is missing: an email channel is written "email:ops@example.com"/,
    );
    expect(whereSchema.safeParse({ where: "ops@example.com", cc: "x@example.com" }).success).toBe(
      false,
    );
  });

  it("refuses a from that is not one address, and a missing from, naming from", () => {
    const schema = plugin.manifest.config;
    const bad = schema.safeParse({
      ...SETTINGS,
      from: "FacetDB <alerts@example.com>, x@example.com",
    });
    expect(bad.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["from"], expect.stringMatching(/^from holds a list .*FacetDB sends from one address/)],
    ]);
    const { from: _from, ...withoutFrom } = SETTINGS;
    const missing = schema.safeParse(withoutFrom);
    expect(missing.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["from"], expect.stringMatching(/^from is missing: .*add from: "alerts@example.com"/)],
    ]);
  });

  it("refuses a user with no password, and a password with no user, on the missing setting, never quoting a value", () => {
    const schema = plugin.manifest.config;
    const { password: _password, ...userOnly } = SETTINGS;
    const noPassword = schema.safeParse(userOnly);
    expect(noPassword.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [
        ["password"],
        expect.stringMatching(
          /^password is missing: user is set.*password: env\("EMAIL_PASSWORD"\)/,
        ),
      ],
    ]);
    const { user: _user, ...passwordOnly } = SETTINGS;
    const noUser = schema.safeParse(passwordOnly);
    expect(noUser.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["user"], expect.stringMatching(/^user is missing: a password is set/)],
    ]);
    expectNoPassword(noUser.error?.issues.map((issue) => issue.message));
  });

  it("takes a server that needs no login, with STARTTLS by default and the port left to secure", () => {
    const parsed = plugin.manifest.config.parse({
      host: "smtp.example.com",
      from: "alerts@example.com",
    });
    expect(parsed).toEqual({
      host: "smtp.example.com",
      secure: false,
      from: "alerts@example.com",
    });
  });

  it.each([
    [{}, 587],
    [{ secure: true }, 465],
    [{ secure: true, port: 587 }, 587],
    [{ secure: false, port: 465 }, 465],
  ])(
    "connects with %j to port %i: 465 with secure and 587 without when port is left out, a written port always",
    (written, port) => {
      const settings = plugin.manifest.config.parse({ ...SETTINGS, ...written }) as EmailSettings;
      expect(transportOptions(settings).port).toBe(port);
    },
  );

  it("refuses a host with a scheme, a port or a space, a port out of range, and an unknown key", () => {
    const schema = plugin.manifest.config;
    for (const host of [
      "smtp://smtp.example.com",
      "smtp.example.com:587",
      "smtp example.com",
      "",
    ]) {
      expect(schema.safeParse({ ...SETTINGS, host }).error?.issues[0]?.message).toMatch(/^host is/);
    }
    for (const port of [0, 65536, 58.7, "587"]) {
      expect(schema.safeParse({ ...SETTINGS, port }).error?.issues[0]?.message).toMatch(
        /^port is a whole number/,
      );
    }
    expect(schema.safeParse({ ...SETTINGS, pass: "x" }).success).toBe(false);
  });
});

describe("no connection is made without TLS unless the host is a loopback address", () => {
  const settings = (input: Readonly<Record<string, unknown>>) =>
    pluginOn(fakeTransport()).manifest.config.parse(input) as EmailSettings;
  const COMMON = {
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };

  it("requires STARTTLS on a remote server by default, with the certificate verified and nodemailer's logs off", () => {
    expect(transportOptions(settings(SETTINGS))).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: USER, pass: PASSWORD },
      ...COMMON,
    });
  });

  it("uses TLS from the first byte with secure: true", () => {
    expect(transportOptions(settings({ ...SETTINGS, port: 465, secure: true }))).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: USER, pass: PASSWORD },
      ...COMMON,
    });
  });

  it("requires TLS on a remote server that needs no login too", () => {
    const options = transportOptions(
      settings({ host: "relay.example.com", from: "a@example.com" }),
    );
    expect(options).toMatchObject({ requireTLS: true, ignoreTLS: false, secure: false });
    expect(options).not.toHaveProperty("auth");
  });

  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["127.10.20.30", "127.10.20.30"],
    ["::1", "::1"],
    ["0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:1"],
    ["localhost", "127.0.0.1"],
    ["LocalHost", "127.0.0.1"],
  ])("speaks in the clear to loopback host %s with no login, connecting to %s", (host, address) => {
    const options = transportOptions(settings({ host, port: 1025, from: "a@example.com" }));
    expect(options).toEqual({
      host: address,
      port: 1025,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
      ...COMMON,
    });
  });

  it("still requires TLS on a loopback host when a password is sent: a password never travels in the clear", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(transportOptions(settings({ ...SETTINGS, host }))).toEqual({
        host,
        port: 587,
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        auth: { user: USER, pass: PASSWORD },
        ...COMMON,
      });
    }
  });

  it("uses TLS from the first byte on a loopback host that asks for it", () => {
    const options = transportOptions(
      settings({ host: "127.0.0.1", port: 465, secure: true, from: "a@example.com" }),
    );
    expect(options).toMatchObject({
      host: "127.0.0.1",
      secure: true,
      requireTLS: true,
      ignoreTLS: false,
    });
  });

  it.each([
    "localhost.",
    "localhost.example.com",
    "mylocalhost",
    "127.0.0.1.nip.io",
    "128.0.0.1",
    "126.255.255.255",
    "0.0.0.0",
    "::",
    "::2",
    "10.0.0.1",
    "192.168.1.10",
  ])("does not count %s as loopback, so TLS is required", (host) => {
    expect(isLoopback(host)).toBe(false);
    const options = transportOptions(settings({ host, from: "a@example.com" }));
    expect(options).toMatchObject({ host, requireTLS: true, ignoreTLS: false });
  });

  it("counts an IPv4-mapped 127.x address as loopback", () => {
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:10.0.0.1")).toBe(false);
  });

  it("makes the transport with these options, once per delivery", async () => {
    const fake = fakeTransport();
    await deliver(fake);
    expect(fake.made).toEqual([transportOptions(settings(SETTINGS))]);
    expect(fake.made[0]).toMatchObject(SMTP_TIMEOUTS);
  });
});

describe("a failed delivery says what the server said, and never the password", () => {
  it("a refused login: the server's words, without the AUTH line nodemailer hangs on the error", async () => {
    const thrown = Object.assign(
      smtpError(
        "Invalid login",
        "EAUTH",
        "535 5.7.8 Username and Password not accepted",
        `AUTH PLAIN ${base64(`${NUL}${USER}${NUL}${PASSWORD}`)}`,
      ),
      // What a careless transport could hang on its error too: its options and a cause.
      { transportOptions: { auth: { user: USER, pass: PASSWORD } } },
    );
    thrown.cause = new Error(`login with ${PASSWORD} refused`);
    const fake = fakeTransport(failing(thrown));
    const error = await failure(deliver(fake));
    expect(error.failure).toBe("login-refused");
    expect(error.status).toBe(535);
    expect(error.temporary).toBe(false);
    expect(error.message).toBe(
      `${LOGIN_REFUSED}. The server said: 535 5.7.8 Username and Password not accepted`,
    );
    expect(fake.closed()).toBe(1);
  });

  it("a reply holding any form of the password is left out whole, on every failure, never blanked in place", async () => {
    const plain = base64(`${NUL}${USER}${NUL}${PASSWORD}`);
    // A login this plugin did not send (another user): the password sits at another byte offset.
    const foreign = base64(`${NUL}xy${NUL}${PASSWORD}`);
    const forms = [
      PASSWORD,
      plain,
      plain.replace(/=+$/, ""),
      base64(PASSWORD),
      base64(PASSWORD).replace(/=+$/, ""),
      base64url(PASSWORD),
      base64url(`${NUL}${USER}${NUL}${PASSWORD}`),
      encodeURIComponent(PASSWORD),
      encodeURIComponent(PASSWORD).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
      foreign,
      foreign.slice(5, -3),
    ];
    const replies = [
      ...forms.map((form) => `535 5.7.8 Authentication failed for ${form} here`),
      // Wrapped over two reply lines, a reply code in between.
      `535-5.7.8 Bad credentials ${plain.slice(0, 20)}\r\n535 5.7.8 ${plain.slice(20)}`,
      `334 ${base64(PASSWORD)}\r\n535 5.7.8 Authentication failed`,
    ];
    for (const response of replies) {
      const login = await failure(
        deliver(
          fakeTransport(failing(smtpError("Invalid login", "EAUTH", response, "AUTH PLAIN"))),
        ),
      );
      // The reply code nodemailer reads is the reply's first three digits (334 for the last one).
      expect(login.message).toBe(`${LOGIN_REFUSED}. ${leftOut(Number(response.slice(0, 3)))}`);
      expect(everythingIn(login)).not.toContain(foreign.slice(8, 20));
      // Any failure, not only a refused login.
      const recipient = await failure(
        deliver(
          fakeTransport(
            failing(smtpError("Recipient", "EENVELOPE", response.replace("535", "550"), "RCPT TO")),
          ),
        ),
      );
      expect(recipient.message).toBe(
        `the SMTP server smtp.example.com:587 refused the recipient ops@example.com: check the address of the channel. ${leftOut(Number(response.replace("535", "550").slice(0, 3)))}`,
      );
    }
  });

  it("leaves out a reply holding the whole encoded login line, for every password of 1 to 12 characters and users of several lengths", async () => {
    const survivors: string[] = [];
    for (const user of [
      "a",
      "ab",
      "abc",
      "ops",
      "alerts@example.com",
      "a.much.longer.login@mail.example.org",
    ]) {
      for (let length = 1; length <= 12; length += 1) {
        const password = "abcdefghijkl".slice(0, length);
        const lines = [
          `${NUL}${user}${NUL}${password}`,
          `${user}${NUL}${password}`,
          `${user}${NUL}${user}${NUL}${password}`,
        ];
        const encodings = lines.flatMap((line) => [
          base64(line),
          base64(line).replace(/=+$/, ""),
          base64url(line),
          `${base64url(line)}${"=".repeat((4 - (base64url(line).length % 4)) % 4)}`,
        ]);
        for (const encoded of encodings) {
          // A refused recipient: the rule for short passwords on a refused login plays no part.
          const plugin = pluginOn(
            fakeTransport(
              failing(smtpError("Recipient", "EENVELOPE", `550 x ${encoded}`, "RCPT TO")),
            ),
          );
          const ctx = contextOf(plugin, { ...SETTINGS, user, password });
          const error = await failure(
            emailChannel(plugin).deliver(ctx, ALERT, { where: "ops@example.com" }),
          );
          if (!error.message.endsWith(leftOut(550))) {
            survivors.push(`${user} / ${password} / ${encoded}`);
          }
        }
      }
    }
    expect(survivors).toEqual([]);
  });

  it("drops a 334 line and an AUTH command's argument by rules that read no password, and keeps every other word", async () => {
    const someoneElse = base64(`${NUL}bob${NUL}hunter2`);
    const kept: readonly (readonly [string, string])[] = [
      [
        `535 5.7.8 AUTH PLAIN ${someoneElse} refused`,
        "535 5.7.8 AUTH PLAIN [argument left out] refused",
      ],
      [`334 VXNlcm5hbWU6\r\n535 5.7.8 Authentication failed`, "535 5.7.8 Authentication failed"],
      [
        "503 5.5.1 AUTH command used when not advertised",
        "503 5.5.1 AUTH command used when not advertised",
      ],
      [
        "535-5.7.8 Username and Password not accepted. For more information, go to\r\n535 5.7.8  https://support.google.com/mail/?p=BadCredentials d2e1a72fcca58-7a1b2c3d4e5sm1234567b.12 - gsmtp",
        "535-5.7.8 Username and Password not accepted. For more information, go to 535 5.7.8 https://support.google.com/mail/?p=BadCredentials d2e1a72fcca58-7a1b2c3d4e5sm1234567b.12 - gsmtp",
      ],
    ];
    for (const [response, words] of kept) {
      const error = await failure(
        deliver(
          fakeTransport(failing(smtpError("Invalid login", "EAUTH", response, "AUTH PLAIN"))),
        ),
      );
      expect(error.message).toBe(`${LOGIN_REFUSED}. The server said: ${words}`);
    }
  });

  it("FacetDB's own sentence never changes with the password, and a real server's reply is left out or kept only by the echo rules: a long form anywhere, a short one as a whole token, any reply of a refused login when the password is short", async () => {
    // Real servers' words, in mixed case. Each case: the failure, and the reply when it has one.
    const cases: readonly (readonly [
      (mail: OutgoingMail) => Promise<SendResult>,
      number | undefined,
    ])[] = [
      [
        failing(
          smtpError(
            "Invalid login",
            "EAUTH",
            "535-5.7.8 Username and Password not accepted",
            "AUTH PLAIN",
          ),
        ),
        535,
      ],
      [
        failing(
          smtpError(
            "Invalid login",
            "EAUTH",
            "535 5.7.8 Error: authentication failed",
            "AUTH PLAIN",
          ),
        ),
        535,
      ],
      [failing(smtpError("Recipient", "EENVELOPE", "550 5.1.1 No such user here", "RCPT TO")), 550],
      [
        failing(
          smtpError(
            "Sender",
            "EENVELOPE",
            "553 5.7.1 Sender address rejected: not owned by user",
            "MAIL FROM",
          ),
        ),
        553,
      ],
      [
        failing(smtpError("Recipient", "EENVELOPE", "451 4.7.1 Please try again later", "RCPT TO")),
        451,
      ],
      [failing(smtpError("STARTTLS", "ETLS", "502 5.5.1 STARTTLS not supported", "STARTTLS")), 502],
      [
        failing(Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:587"), { code: "ESOCKET" })),
        undefined,
      ],
      [failing(smtpError("Greeting never received", "ETIMEDOUT", false, "CONN")), undefined],
      [async () => ({ accepted: [], rejected: ["ops@example.com"] }), undefined],
    ];
    const messagesWith = async (password: string) => {
      const messages: string[] = [];
      for (const [answer] of cases) {
        const plugin = pluginOn(fakeTransport(answer));
        const ctx = contextOf(plugin, SETTINGS);
        // Past the schema, so an empty password is tried too.
        const withPassword = { ...ctx, config: { ...ctx.config, password } };
        const error = await failure(
          emailChannel(plugin).deliver(withPassword, ALERT, { where: "ops@example.com" }),
        );
        messages.push(error.message);
      }
      return messages;
    };
    const reference = await messagesWith(PASSWORD);
    expect(reference.join("\n")).not.toContain("left out, as");
    // The sentence is everything before the reply's own label; it must never change.
    const sentenceOf = (message: string) => message.split(/\. (?:The server|The error)/)[0];
    // Which replies each password leaves out (by index in `cases`), and why.
    const expected: readonly (readonly [string, readonly number[]])[] = [
      // 8 characters: a long form, found anywhere; "Password" is not "password".
      ["password", []],
      // Shorter than 8: both refused logins always; elsewhere only as a whole token.
      ["server", [0, 1]],
      ["user", [0, 1, 2, 3]],
      ["example", [0, 1]],
      ["587", [0, 1, 6]],
      ["e", [0, 1]],
      // Every regex metacharacter: . * + ? ^ $ { } ( ) | [ ] \
      [".*+?^$" + "{}()|[]\\", []],
      // No password at all: nothing to echo.
      ["", []],
    ];
    for (const [password, leftOutAt] of expected) {
      const messages = await messagesWith(password);
      messages.forEach((message, index) => {
        const sentence = sentenceOf(reference[index] as string);
        expect(sentenceOf(message)).toBe(sentence);
        const code = cases[index]?.[1];
        const want = !leftOutAt.includes(index)
          ? reference[index]
          : code === undefined
            ? `${sentence}. The error's words were left out, as they could carry the login`
            : `${sentence}. ${leftOut(code)}`;
        expect([password, message]).toEqual([password, want]);
      });
    }
  });

  it("a short form counts only as a whole token: inside a longer word it is the server's own", async () => {
    const outcome = async (password: string, response: string) => {
      const plugin = pluginOn(
        fakeTransport(failing(smtpError("Recipient", "EENVELOPE", response, "RCPT TO"))),
      );
      const error = await failure(
        emailChannel(plugin).deliver(contextOf(plugin, { ...SETTINGS, password }), ALERT, {
          where: "ops@example.com",
        }),
      );
      return error.message.endsWith(leftOut(550)) ? "left out" : "kept";
    };
    expect(await outcome("user", "550 5.1.1 No such user here")).toBe("left out");
    expect(await outcome("user", "550 5.1.1 No such username here")).toBe("kept");
    expect(await outcome("user", "550 5.1.1 Unknown (user)")).toBe("left out");
    expect(await outcome("e", "550 5.1.1 No such mailbox here")).toBe("kept");
    expect(await outcome("Pa55", "550 5.1.1 Pa55: denied")).toBe("left out");
  });

  it("a refused login with a password shorter than 8 characters always leaves its reply out, the reply code kept", async () => {
    for (const password of ["e", "hunter2"]) {
      const plugin = pluginOn(
        fakeTransport(
          failing(
            smtpError(
              "Invalid login",
              "EAUTH",
              "535 5.7.8 Error: authentication failed",
              "AUTH PLAIN",
            ),
          ),
        ),
      );
      const error = await failure(
        emailChannel(plugin).deliver(contextOf(plugin, { ...SETTINGS, password }), ALERT, {
          where: "ops@example.com",
        }),
      );
      expect(error.message).toBe(`${LOGIN_REFUSED}. ${leftOut(535)}`);
      expect(error.status).toBe(535);
    }
  });

  it("a password in the message of the error, with no response, leaves the error's words out", async () => {
    const error = await failure(
      deliver(
        fakeTransport(
          failing(smtpError(`Missing credentials for ${PASSWORD}`, "EAUTH", false, "API")),
        ),
      ),
    );
    expect(error.message).toBe(
      `${LOGIN_REFUSED}. The error's words were left out, as they could carry the login`,
    );
  });

  it.each([
    [
      "ECONNECTION",
      "421 4.3.2 Service shutting down, closing transmission channel",
      "CONN",
      "unreachable",
      "closed the connection for now and asked to try again later",
    ],
    [
      "EENVELOPE",
      "450 4.2.0 <ops@example.com>: Recipient address rejected: Greylisted",
      "RCPT TO",
      "recipient-refused",
      "refused the recipient ops@example.com for now and asked to try again later",
    ],
    [
      "EENVELOPE",
      "451 4.7.1 Please try again later",
      "RCPT TO",
      "recipient-refused",
      "refused the recipient ops@example.com for now and asked to try again later",
    ],
    [
      "EAUTH",
      "454 4.7.0 Temporary authentication failure",
      "AUTH PLAIN",
      "login-refused",
      "refused the login for now and asked to try again later",
    ],
  ])(
    "a %s %s is a temporary failure: the server asked to try again later",
    async (code, response, command, kind, words) => {
      const error = await failure(
        deliver(fakeTransport(failing(smtpError("Refused", code, response, command)))),
      );
      expect(error.failure).toBe(kind);
      expect(error.status).toBe(Number(response.slice(0, 3)));
      expect(error.temporary).toBe(true);
      expect(error.message).toBe(
        `the SMTP server smtp.example.com:587 ${words}. The server said: ${response}`,
      );
      expect(error.message).not.toMatch(/check user|check the address/);
      expect(error).not.toHaveProperty("retryAfterMs");
    },
  );

  it("a 5xx stays a permanent failure", async () => {
    for (const [code, response, command] of [
      ["EAUTH", "535 5.7.8 Username and Password not accepted", "AUTH PLAIN"],
      ["EENVELOPE", "550 5.1.1 User unknown", "RCPT TO"],
      ["EMESSAGE", "554 5.7.1 Message rejected as spam", "DATA"],
    ] as const) {
      const error = await failure(
        deliver(fakeTransport(failing(smtpError("Refused", code, response, command)))),
      );
      expect(error.status).toBe(Number(response.slice(0, 3)));
      expect(error.temporary).toBe(false);
      expect(error.message).not.toContain("try again later");
    }
  });

  it("a refused recipient: the server's words, the address included", async () => {
    const fake = fakeTransport(
      failing(
        smtpError(
          "Can't send mail - all recipients were rejected",
          "EENVELOPE",
          "550 5.1.1 <ops@example.com>: Recipient address rejected: User unknown in virtual mailbox table",
          "RCPT TO",
        ),
      ),
    );
    const error = await failure(deliver(fake));
    expect(error.failure).toBe("recipient-refused");
    expect(error.status).toBe(550);
    expect(error.temporary).toBe(false);
    expect(error.message).toBe(
      "the SMTP server smtp.example.com:587 refused the recipient ops@example.com: check the address of the channel. The server said: 550 5.1.1 <ops@example.com>: Recipient address rejected: User unknown in virtual mailbox table",
    );
  });

  it("a refused sender, a refused message, and a recipient the server answered without taking", async () => {
    const sender = await failure(
      deliver(
        fakeTransport(
          failing(
            smtpError(
              "Mail command failed",
              "EENVELOPE",
              "553 5.7.1 <alerts@example.com>: Sender address rejected: not owned by user",
              "MAIL FROM",
            ),
          ),
        ),
      ),
    );
    expect(sender.failure).toBe("sender-refused");
    expect(sender.message).toMatch(
      /refused the sender alerts@example.com: .*Sender address rejected/,
    );

    const message = await failure(
      deliver(
        fakeTransport(
          failing(
            smtpError("Message failed", "EMESSAGE", "554 5.7.1 Message rejected as spam", "DATA"),
          ),
        ),
      ),
    );
    expect(message.failure).toBe("message-refused");
    expect(message.message).toMatch(
      /refused the message. The server said: 554 5.7.1 Message rejected as spam$/,
    );

    const rejected = await failure(
      deliver(fakeTransport(async () => ({ accepted: [], rejected: ["ops@example.com"] }))),
    );
    expect(rejected.failure).toBe("recipient-refused");
  });

  it("a server that offers no STARTTLS fails the delivery: nothing is sent in the clear", async () => {
    const error = await failure(
      deliver(
        fakeTransport(
          failing(
            smtpError(
              "Error upgrading connection with STARTTLS",
              "ETLS",
              "502 5.5.1 STARTTLS not supported",
              "STARTTLS",
            ),
          ),
        ),
      ),
    );
    expect(error.failure).toBe("tls-failed");
    expect(error.message).toMatch(
      /^TLS with the SMTP server smtp.example.com:587 failed, and FacetDB sends nothing without it: .*The server said: 502 5.5.1 STARTTLS not supported$/,
    );
  });

  it("a server that cannot be reached, or does not answer in time", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:587"), {
      code: "ESOCKET",
    });
    const unreachable = await failure(deliver(fakeTransport(failing(refused))));
    expect(unreachable.failure).toBe("unreachable");
    expect(unreachable.message).toBe(
      "the SMTP server smtp.example.com:587 could not be reached: check host and port. The error was: connect ECONNREFUSED 10.0.0.9:587",
    );
    const slow = await failure(
      deliver(
        fakeTransport(failing(smtpError("Greeting never received", "ETIMEDOUT", false, "CONN"))),
      ),
    );
    expect(slow.failure).toBe("timed-out");
  });

  it("anything else thrown, even a bare string or a transport that cannot be made, holds no password", async () => {
    const odd = await failure(deliver(fakeTransport(failing(`exploded with ${PASSWORD}`))));
    expect(odd.failure).toBe("failed");
    expect(odd.message).toBe(
      "the email to ops@example.com through the SMTP server smtp.example.com:587 failed. The error's words were left out, as they could carry the login",
    );

    const plugin = createEmailPlugin({
      createTransport: () => {
        throw Object.assign(new Error(`bad options ${JSON.stringify({ pass: PASSWORD })}`), {
          options: { auth: { pass: PASSWORD } },
        });
      },
    });
    const unmade = await failure(
      emailChannel(plugin).deliver(contextOf(plugin, SETTINGS), ALERT, {
        where: "ops@example.com",
      }),
    );
    expect(unmade.failure).toBe("failed");
  });

  it("stopped before the message is handed over: not sent, and no transport made", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeTransport();
    const plugin = pluginOn(fake);
    const error = await failure(
      emailChannel(plugin).deliver(contextOf(plugin, SETTINGS, controller.signal), ALERT, {
        where: "ops@example.com",
      }),
    );
    expect(error.failure).toBe("stopped");
    expect(error.message).toBe("the email to ops@example.com was not sent: FacetDB is stopping");
    expect(fake.made).toEqual([]);
  });

  it("stopped while sending: the send's own signal ends the connection, and the words say it may or may not have been sent", async () => {
    const controller = new AbortController();
    let ended = false;
    let closed = 0;
    // As nodemailer's SMTP transport: only the signal given to the send ends its connection
    // (rejecting with EABORT); the transport's close() leaves a send in flight alone.
    const plugin = createEmailPlugin({
      createTransport: () => ({
        send: (_mail, sendSignal) =>
          new Promise<SendResult>((_resolve, reject) => {
            sendSignal.addEventListener("abort", () => {
              ended = true;
              reject(Object.assign(new Error("Message sending aborted"), { code: "EABORT" }));
            });
            controller.abort();
          }),
        close: () => {
          closed += 1;
        },
      }),
    });
    const error = await failure(
      emailChannel(plugin).deliver(contextOf(plugin, SETTINGS, controller.signal), ALERT, {
        where: "ops@example.com",
      }),
    );
    expect(error.failure).toBe("stopped");
    expect(error.message).toBe(
      "FacetDB stopped while the email to ops@example.com was being sent; it may or may not have been sent",
    );
    expect(ended).toBe(true);
    expect(closed).toBe(1);
  });

  it("nodemailer's own transport, made with these options, honours the send's signal without opening a socket", async () => {
    const options = transportOptions(
      pluginOn(fakeTransport()).manifest.config.parse({
        host: "127.0.0.1",
        port: 9,
        from: "alerts@example.com",
      }) as EmailSettings,
    );
    const transport = nodemailerTransport(options);
    const controller = new AbortController();
    controller.abort();
    const thrown = await transport
      .send(
        { from: "alerts@example.com", to: "ops@example.com", subject: "Critical: x", text: "x" },
        controller.signal,
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    transport.close();
    // An aborted signal is refused before any connection; without it this would try port 9.
    expect(thrown).toMatchObject({ code: "EABORT" });
  });
});

describe("the plugin passes the loader's and the host's checks", () => {
  const plugin = pluginOn(fakeTransport());
  const notFound = (specifier: string) =>
    Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });

  it("loads by its short name as @facetdb/email, a channel plugin whose one secret is the password", async () => {
    const loaded = await loadPlugin("email", {
      coreVersion: VERSION,
      importModule: async (specifier) => {
        if (specifier === "@facetdb/email") {
          return import("./index.ts");
        }
        throw notFound(specifier);
      },
    });
    expect(loaded.manifest).toMatchObject({
      name: "email",
      kinds: ["channel"],
      secrets: ["password"],
      coreVersions: ">=0.0.0 <1.0.0",
    });
    expect(Object.keys(loaded.channels)).toEqual(["email"]);
  });

  it("matches its registry entry", async () => {
    const entry: unknown = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../../registry/plugins/email.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(entry).toMatchObject({
      name: "email",
      package: "@facetdb/email",
      kinds: plugin.manifest.kinds,
      facetdb: plugin.manifest.coreVersions,
    });
  });

  function project(settings: PluginSettings) {
    return facetdb({
      model: "jev-1.14.0",
      plugins: { email: settings },
      alerts: { channels: ["email:ops@example.com"] },
      sources: [
        {
          name: "tickets",
          api: true,
          read: ["body"],
          questions: { urgent: noul("Is this urgent?") },
        },
      ],
    });
  }

  function host(settings: PluginSettings) {
    return createPluginHost({
      config: project(settings),
      env: { EMAIL_PASSWORD: PASSWORD },
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: async (specifier) => {
        if (specifier === "@facetdb/email") {
          return { default: plugin };
        }
        throw notFound(specifier);
      },
      builtins: {},
    });
  }

  async function refusal(built: Promise<unknown>): Promise<PluginHostError> {
    const thrown = await built.then(
      () => {
        throw new Error("the host was built, and a refusal was expected");
      },
      (caught: unknown) => caught,
    );
    expect((thrown as Error).name).toBe("PluginHostError");
    expectNoPassword(thrown);
    return thrown as PluginHostError;
  }

  it("reads the password from the variable the config names, and delivers with it", async () => {
    const fake = fakeTransport();
    const hosted = createEmailPlugin({ createTransport: fake.createTransport });
    const built = await createPluginHost({
      config: project({ ...SETTINGS, password: env("EMAIL_PASSWORD") }),
      env: { EMAIL_PASSWORD: PASSWORD },
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: async () => ({ default: hosted }),
      builtins: {},
    });
    expect(built.plugin("email")?.variables).toEqual([
      { path: "password", variable: "EMAIL_PASSWORD", secret: true },
    ]);
    const ctx = built.contextFor("email", signal) as PluginContext<EmailSettings>;
    await emailChannel(hosted).deliver(ctx, ALERT, { where: "ops@example.com" });
    expect(fake.made[0]?.auth).toEqual({ user: USER, pass: PASSWORD });
  });

  it("refuses a password written into the config file", async () => {
    const refused = await refusal(host({ ...SETTINGS, password: "hunter2-literal" }));
    expect(refused.code).toBe("plugin-secret-literal");
    expect(refused.fix).toContain('password: env("EMAIL_PASSWORD")');
  });

  it("refuses a from that is not one address, and a user with no password, in words naming the setting", async () => {
    const from = await refusal(
      host({ ...SETTINGS, password: env("EMAIL_PASSWORD"), from: "FacetDB <alerts@example.com>" }),
    );
    expect(from.code).toBe("plugin-settings");
    expect(from.message).toContain("plugins.email.from: from holds a display name");

    const { password: _password, ...userOnly } = SETTINGS;
    const user = await refusal(host(userOnly));
    expect(user.message).toContain("plugins.email.password: password is missing: user is set");
  });
});

describe("email.notify writes a record notification down for the worker", () => {
  it("as an action call of @facetdb/email, with the channel and the condition", () => {
    expect(email.notify({ channel: "ops@example.com", when: { urgency: "high" } })).toEqual({
      plugin: "@facetdb/email",
      action: "notify",
      config: { channel: "ops@example.com", when: { urgency: "high" } },
    });
    expect(email.notify({ channel: "ops@example.com" })).toEqual({
      plugin: "@facetdb/email",
      action: "notify",
      config: { channel: "ops@example.com" },
    });
  });
});
