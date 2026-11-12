import type { WebhookPayload } from "./action.ts";
import { verify } from "./sign.ts";

/**
 * The receiver snippet of the docs (sign.ts points here), kept as code: `pnpm typecheck` compiles
 * it and webhooks.test.ts runs it, so the documented receiver cannot drift from `verify`. In your
 * app the import is `import { verify } from "@facetdb/server"`. The handler takes a web `Request`
 * (Hono, Next.js route handlers, Bun, Deno, Node through an adapter) and returns a `Response`.
 *
 * The secret is read on every request, not when the module loads: an unset
 * `FACETDB_WEBHOOK_SECRET` is typed (`string | undefined`) and answered with a 500 that says what
 * to set, never a throw that keeps the app from starting. `env` and `now` are parameters only so
 * a test can pass its own; your app leaves them out.
 */
export async function receiveFacetdbWebhook(
  request: Request,
  apply: (event: WebhookPayload) => Promise<void>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now(),
): Promise<Response> {
  const secret = env["FACETDB_WEBHOOK_SECRET"]; // string | undefined
  if (secret === undefined || secret === "") {
    return new Response("Set FACETDB_WEBHOOK_SECRET to the project's webhook secret.", {
      status: 500,
    });
  }
  const body = await request.text(); // the exact bytes FacetDB sent, never a re-serialised object
  const result = verify(secret, request.headers.get("facetdb-signature"), body, now);
  if (!result.ok) {
    return new Response(result.reason, { status: 400 });
  }
  // Every field is under the signature: { event, delivery, source, id, status, decidedAt, answers }.
  const event = JSON.parse(body) as WebhookPayload;
  // Be idempotent: `delivery` is the same on every retry of one webhook (the `facetdb-delivery`
  // header repeats it), and a retried older webhook can land after a newer one, so keep the one
  // with the later `decidedAt`.
  await apply(event);
  // Answer 2xx quickly: anything else is retried with backoff for 24 hours.
  return new Response(null, { status: 204 });
}
