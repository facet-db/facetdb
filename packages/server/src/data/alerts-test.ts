import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson } from "../request.ts";

/**
 * `POST /v1/alerts/test`: one information message marked as a test, sent now through the channel
 * the body names, whatever its quiet hours and what it sends. Parse, one door call, map; the
 * reviewer, and that the request comes from a page of the studio itself or a program, were checked
 * by app.ts's middleware.
 *
 * The route's own words never repeat the address the body names (the config refuses a URL or a
 * credential in an address, and this route does not rely on that). A failure is answered in the
 * words the alert history keeps for a delivery: the channel host's fixed words, or a first-party
 * plugin's own, which repeat no secret its settings read but may name the channel's address
 * (`slack:#ops was not delivered: …`), the config's own words and no secret. Never what any other
 * plugin threw. The test is not an alert: nothing is written to the history.
 */

/** A test message's outcome, as the worker's alerts answer it (core's `ChannelTest`). */
export type AlertTestOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "unknown_channel" }
  | { readonly kind: "failed"; readonly error: string };

/** The CLI's door for the test button: the channels the worker runs, bound to their plugins. */
export type AlertTestDoor = {
  /** False under `facetdb worker --once`, which answers what is queued and exits. */
  readonly available: boolean;
  /** Sends the test message through the channel whose address is `address`. */
  send(address: string): Promise<AlertTestOutcome>;
};

/** The stub of a worker that sends no test message (`--once`), and of a surface given no door. */
export const NO_ALERT_TEST: AlertTestDoor = {
  available: false,
  send: () => Promise.reject(new Error("this worker sends no test message")),
};

/** An address as `alerts.channels` writes one: `slack:#ops`. The body is a boundary. */
const testBody = z.strictObject({
  channel: z
    .string()
    .max(500, "channel is at most 500 characters")
    .regex(
      /^[a-z][a-z0-9-]*:\S/,
      'channel is an address as alerts.channels writes it, such as "slack:#ops"',
    ),
});

export function alertTestRoutes(door: AlertTestDoor): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/alerts/test", async (c) => {
    if (!door.available) {
      throw new ApiError(
        409,
        "alert_test_unavailable",
        "This worker sends no test message: facetdb worker --once answers what is queued and exits.",
        "Run facetdb worker, then send the test from the Alerts page.",
      );
    }
    const body = testBody.safeParse(await readJson(c.req));
    if (!body.success) {
      throw new ApiError(
        400,
        "invalid_request",
        bodyProblems(body.error),
        'Send {"channel": "<address>"}, with an address GET /v1/alerts lists, such as "slack:#ops".',
      );
    }
    const outcome = await door.send(body.data.channel);
    switch (outcome.kind) {
      case "sent":
        return c.json({ sent: true });
      case "unknown_channel":
        throw new ApiError(
          404,
          "unknown_channel",
          "This worker runs no alert channel at that address, so no test message was sent.",
          "Send the address of a channel GET /v1/alerts lists, as alerts.channels in facetdb.config.ts writes it; a channel added to the file is sent to once Apply, or Check again after a hand edit, puts it in force.",
        );
      case "failed":
        throw new ApiError(
          502,
          "channel_failed",
          `The channel did not take the test message: ${outcome.error}.`,
          "Check the channel's settings and its plugin's variables against the plugin's documentation, then send the test again; the worker's alerts go through the same channel.",
        );
    }
  });

  return route;
}
