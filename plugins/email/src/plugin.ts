import { channel, definePlugin, type PluginContext } from "facetdb/plugin";
import { type AddressSetting, addressProblem } from "./address.ts";
import {
  type DeliveryScene,
  deliveryFailure,
  deliveryStopped,
  EmailDeliveryError,
  recipientNotAccepted,
} from "./delivery-error.ts";
import { bodyOf, type ChannelMessage, subjectOf } from "./message.ts";
import {
  type ChannelSettings,
  channelSettings,
  type EmailSettings,
  emailSettings,
  portOf,
} from "./settings.ts";
import {
  type MailTransport,
  type MakeTransport,
  type SendResult,
  transportOptions,
} from "./transport.ts";

export type EmailPluginOptions = {
  /** Makes the SMTP transport: `nodemailerTransport` in the process, a handwritten fake in tests. */
  readonly createTransport: MakeTransport;
};

/**
 * The email plugin: its settings and its one channel, `email`, which sends each message it is
 * handed to the one address `where` names, as plain text. A channel does not deduplicate: the same
 * message delivered twice is sent twice.
 */
export function createEmailPlugin(options: EmailPluginOptions) {
  return definePlugin({
    name: "email",
    version: "0.0.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: emailSettings,
    channels: {
      email: channel({
        config: channelSettings,
        deliver: (ctx: PluginContext<EmailSettings>, message, settings) =>
          deliverEmail(options.createTransport, ctx, message, settings),
      }),
    },
  });
}

/**
 * The address a header is written with, checked once more where it becomes one: the host parses
 * the settings with the schema, but `deliver` is the contract any caller reaches, and a line break
 * in From or To is a header of the sender's choosing.
 */
function headerAddress(value: string, setting: AddressSetting): string {
  const problem = addressProblem(value, setting);
  if (problem !== undefined) {
    throw new EmailDeliveryError("address-refused", problem);
  }
  return value;
}

/** `sending`, or a rejection the moment the host stops the plugin (the transport ends the connection). */
function untilStopped(
  sending: Promise<SendResult>,
  signal: AbortSignal,
  stopped: EmailDeliveryError,
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(stopped);
    // The host may stop the plugin while `send` was being called, before this listens.
    if (signal.aborted) {
      stop();
      sending.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    sending.then(
      (result) => {
        signal.removeEventListener("abort", stop);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

async function deliverEmail(
  createTransport: MakeTransport,
  ctx: PluginContext<EmailSettings>,
  message: ChannelMessage,
  settings: ChannelSettings,
): Promise<void> {
  const { config, signal } = ctx;
  const scene: DeliveryScene = {
    host: config.host,
    port: portOf(config),
    from: config.from,
    to: settings.where,
    user: config.user,
    password: config.password,
  };
  const mail = {
    from: headerAddress(config.from, "from"),
    to: headerAddress(settings.where, "where"),
    subject: subjectOf(message),
    text: bodyOf(message),
  };
  if (signal.aborted) {
    throw deliveryStopped(scene, false);
  }
  const stopped = deliveryStopped(scene, true);
  let transport: MailTransport | undefined;
  let result: SendResult;
  try {
    transport = createTransport(transportOptions(config));
    // The signal goes to the send itself: nodemailer ends the connection of a send when it fires
    // (closing the transporter does not touch a connection in flight).
    result = await untilStopped(transport.send(mail, signal), signal, stopped);
  } catch (error) {
    // Only this function's own error passes through; anything the transport threw is rebuilt.
    throw error === stopped ? stopped : deliveryFailure(error, scene);
  } finally {
    transport?.close();
  }
  // The server's answer is a boundary: a recipient it did not take is a failed delivery.
  if (
    !Array.isArray(result.accepted) ||
    !Array.isArray(result.rejected) ||
    result.accepted.length === 0 ||
    result.rejected.length > 0
  ) {
    throw recipientNotAccepted(scene);
  }
}
