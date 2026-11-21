/**
 * @facetdb/email: system alerts and record notifications by email, over SMTP with nodemailer. The default export is the plugin the host loads, its
 * transport nodemailer's; `createEmailPlugin` builds it on another transport (a test's fake).
 *
 * ```ts
 * plugins: { email: { host: "smtp.example.com", user: "alerts@example.com",
 *   password: env("EMAIL_PASSWORD"), from: "alerts@example.com" } },
 * alerts: { channels: ["email:ops@example.com"] },
 * ```
 */
import { createEmailPlugin } from "./plugin.ts";
import { nodemailerTransport } from "./transport.ts";

export type { AddressSetting } from "./address.ts";
export { addressProblem } from "./address.ts";
export type { DeliveryFailure } from "./delivery-error.ts";
export { EmailDeliveryError } from "./delivery-error.ts";
export type { ChannelMessage } from "./message.ts";
export { SUBJECT_LIMIT } from "./message.ts";
export type { EmailNotify } from "./notify.ts";
export { email } from "./notify.ts";
export type { EmailPluginOptions } from "./plugin.ts";
export { createEmailPlugin } from "./plugin.ts";
export type { ChannelSettings, EmailSettings } from "./settings.ts";
export type {
  MailTransport,
  MakeTransport,
  OutgoingMail,
  SendResult,
  SmtpOptions,
} from "./transport.ts";
export { isLoopback, nodemailerTransport, SMTP_TIMEOUTS, transportOptions } from "./transport.ts";

/** The one place nodemailer is wired in. */
export default createEmailPlugin({ createTransport: nodemailerTransport });
