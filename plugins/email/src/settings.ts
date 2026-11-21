import { isIP } from "node:net";
import { type Infer, z } from "facetdb/plugin";
import { addressSchema } from "./address.ts";

/**
 * The email plugin's settings, under `plugins.email` in the config file: the one schema that
 * validates the file and draws the dashboard's settings form. The password is a `z.secret()`, so
 * the host refuses it written in the file and reads it from the variable the file names:
 * `password: env("EMAIL_PASSWORD")`.
 */

/** A host name (letters, digits, dots and dashes) or an IP address, nothing else. */
const HOST_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const host = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? 'host is missing: name your SMTP server, such as host: "smtp.example.com"'
        : 'host is text: the SMTP server\'s name or IP address, such as "smtp.example.com"',
  })
  .superRefine((value, ctx) => {
    if (!(HOST_NAME.test(value) || isIP(value) !== 0)) {
      ctx.addIssue({
        code: "custom",
        message:
          'host is the SMTP server\'s name or IP address alone, with no scheme, port, user or path: write it as "smtp.example.com" and the port under port',
      });
    }
  });

const user = z
  .string({
    error: 'user is text: the login your SMTP server expects, such as "alerts@example.com"',
  })
  .min(1, "user is empty: give the login your SMTP server expects, or leave user out")
  .refine((value) => !CONTROL.test(value), {
    message: "user holds a line break or a control character: write the login on one line",
  });

export const emailSettings = z
  .strictObject({
    host,
    /** Left out: 465 with `secure: true`, 587 otherwise (`portOf`); a port written is always used. */
    port: z
      .number({
        error:
          "port is a whole number from 1 to 65535: 587 for STARTTLS, 465 with secure: true (left out, it is chosen by secure)",
      })
      .int("port is a whole number from 1 to 65535: 587 for STARTTLS, 465 with secure: true")
      .min(1, "port is a whole number from 1 to 65535: 587 for STARTTLS, 465 with secure: true")
      .max(65535, "port is a whole number from 1 to 65535: 587 for STARTTLS, 465 with secure: true")
      .optional(),
    /** TLS from the first byte (port 465); false, the default, sends STARTTLS and requires it. */
    secure: z
      .boolean({
        error:
          "secure is true or false: true for TLS from the first byte (port 465), false for STARTTLS (port 587)",
      })
      .default(false),
    user: user.optional(),
    password: z.secret().optional(),
    from: addressSchema(
      "from",
      'from is missing: FacetDB sends email from one address your SMTP server accepts; add from: "alerts@example.com" to the settings of the plugin',
    ),
  })
  .superRefine((value, ctx) => {
    // Each refusal sits on the setting that is missing, so its words are shown even when the
    // other one is read from a variable (the host hides a reason a variable fed).
    if (value.user !== undefined && value.password === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message:
          'password is missing: user is set, so the SMTP server expects a login; name the variable that holds the password, password: env("EMAIL_PASSWORD"), or take user out for a server that needs no login',
      });
    }
    if (value.password !== undefined && value.user === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["user"],
        message:
          "user is missing: a password is set, so give the login it belongs to, or take password out for a server that needs no login",
      });
    }
  });

export type EmailSettings = Infer<typeof emailSettings>;

/**
 * The port a delivery connects to: the one written, or by nodemailer's own convention 465 for TLS
 * from the first byte and 587 for STARTTLS (not a plain "default 587", taken at review: `secure:
 * true` on 587 fails every delivery at the handshake).
 */
export function portOf(settings: EmailSettings): number {
  return settings.port ?? (settings.secure ? 465 : 587);
}

/** The settings of one email channel, `{ where }`, built by the host from `email:ops@example.com`. */
export const channelSettings = z.strictObject({
  where: addressSchema(
    "where",
    'where is missing: an email channel is written "email:ops@example.com", one address after the colon',
  ),
});

export type ChannelSettings = Infer<typeof channelSettings>;
