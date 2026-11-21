import { BlockList, isIP } from "node:net";
import { createTransport } from "nodemailer";
import { type EmailSettings, portOf } from "./settings.ts";

/**
 * How the plugin reaches the SMTP server: the options a transport is made with, and the transport
 * itself as a function the plugin takes (`createEmailPlugin({ createTransport })`), nodemailer's
 * by default and a handwritten fake in tests, so no test opens a socket.
 *
 * TLS: no connection is made without TLS unless the host is a loopback address and no password is
 * sent. `secure: true` is TLS from the first byte; otherwise STARTTLS is required (`requireTLS`),
 * so a server that does not offer it fails the delivery before the login is sent. Certificates are
 * always verified. A loopback host with a login still requires TLS: a password never travels in the
 * clear, even inside the machine.
 */

/** One message, plain text only: no HTML part, no attachment, no header of its own. */
export type OutgoingMail = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
};

/** What the server said of the recipients once the message is sent. */
export type SendResult = {
  readonly accepted: readonly unknown[];
  readonly rejected: readonly unknown[];
};

/**
 * A transport to one SMTP server. `send` opens the connection and must end it when `signal` fires
 * (rejecting); `close` releases the transport once the send is settled, and, as nodemailer's
 * `close()`, is not relied on to end a send still in flight.
 */
export type MailTransport = {
  send(mail: OutgoingMail, signal: AbortSignal): Promise<SendResult>;
  close(): void;
};

/** The options a transport is made with: nodemailer's SMTP options, every one of them set here. */
export type SmtpOptions = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly ignoreTLS: boolean;
  readonly opportunisticTLS: false;
  readonly tls: { readonly rejectUnauthorized: true; readonly minVersion: "TLSv1.2" };
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
  readonly dnsTimeout: number;
  readonly logger: false;
  readonly debug: false;
  readonly transactionLog: false;
  readonly disableFileAccess: true;
  readonly disableUrlAccess: true;
};

export type MakeTransport = (options: SmtpOptions) => MailTransport;

/**
 * How long a delivery waits, so a dead server cannot hang it (nodemailer waits 2 minutes to
 * connect and 10 minutes of silence by default). An alert is awaited by the worker's alert pass:
 * 10 s to open the connection (TCP, and the TLS handshake for `secure`), 10 s for the greeting and
 * 10 s for the name lookup are generous for a working server; 30 s of silence on an open socket
 * leaves room for a server that scans the message before it answers DATA.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
  dnsTimeout: 10_000,
} as const;

/** 127.0.0.0/8 and ::1 (an IPv4-mapped 127.x address included); a name other than `localhost` never counts. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Whether `host` is this machine: `localhost` (in any case) or an address in 127.0.0.0/8 or ::1.
 * Any other name is not, even one that resolves to a loopback address: what a name resolves to
 * can change, and nodemailer asks DNS before the hosts file.
 */
export function isLoopback(host: string): boolean {
  if (host.toLowerCase() === "localhost") {
    return true;
  }
  const family = isIP(host);
  return family !== 0 && LOOPBACK.check(host, family === 4 ? "ipv4" : "ipv6");
}

/** The options of a transport for the plugin's settings; see the TLS rule above. */
export function transportOptions(settings: EmailSettings): SmtpOptions {
  const port = portOf(settings);
  const auth =
    settings.user !== undefined && settings.password !== undefined
      ? { user: settings.user, pass: settings.password }
      : undefined;
  // Without TLS only on this machine and only with no login. `localhost` is connected to as
  // 127.0.0.1, so no name lookup can move a connection in the clear off the machine.
  const plaintext = !settings.secure && auth === undefined && isLoopback(settings.host);
  return {
    host: plaintext && settings.host.toLowerCase() === "localhost" ? "127.0.0.1" : settings.host,
    port,
    secure: settings.secure,
    requireTLS: !plaintext,
    ignoreTLS: plaintext,
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    ...(auth === undefined ? {} : { auth }),
    ...SMTP_TIMEOUTS,
    // nodemailer's own logs carry the SMTP conversation: they stay off.
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * nodemailer's SMTP transport, one connection per delivery. The only place nodemailer is called.
 * The signal goes to `sendMail`: nodemailer 10.5.0's SMTP transport (`supportsAbortSignal`) then
 * ends that send's connection when it fires (`smtp-transport/index.js`, `send`: `onAbort` calls
 * `connection.close()`), while the transporter's own `close()` only drops its OAuth2 listeners
 * and leaves a connection in flight alone.
 */
export const nodemailerTransport: MakeTransport = (options) => {
  const transporter = createTransport({ ...options, tls: { ...options.tls } });
  return {
    send: async (mail, signal) => {
      const info = await transporter.sendMail({ ...mail, signal });
      return { accepted: info.accepted, rejected: info.rejected };
    },
    close: () => transporter.close(),
  };
};
