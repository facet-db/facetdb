import type { Clock, ProviderRequest, Question, StateValue } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PresetName } from "./presets.ts";
import { selectProvider } from "./select.ts";

/**
 * A real request through a preset: one noul, one choice and one score question on three listings of
 * the listings example (`packages/facetdb/examples/listings-market`), asked through
 * `selectProvider`, the door every composition root uses. Each case reads its server's address from
 * an environment variable. Unset, the case skips and says why on stderr, never silently
 * (`facetdb-testing`); set, the operator meant to run it, so a server that does not answer as
 * expected fails it (Ollama's case alone also skips when no Ollama answers there, or none of its
 * models has the name below). It runs only through `test:live`:
 *
 *   STRANDS_DECIDER_URL=http://127.0.0.1:8000 pnpm --filter @facetdb/model run test:live presets
 *
 * The Strands Decider server (`strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`)
 * does not read the request's `model`: it answers with the checkpoint it serves and names that
 * checkpoint's base name in the response. The config's name below is FacetDB's own exact version
 * for that checkpoint (`v1-2610`), which the request carries; the decision log records the
 * response's name. Ollama reads the request's `model`, so its case needs a local model under the
 * same name (its Strands Decider build needs an Apple silicon Mac).
 */

/** The config's model: one word, a dash and `x.y.z` (core's MODEL_VERSION_PATTERN). */
const MODEL = "strandsdecider-1.2610.0";
/** The checkpoint the Strands Decider server is started with; its response names the base name. */
const CHECKPOINT = "strands-decider-2B-qwen3.5-v1-2610";

const questions: readonly Question[] = [
  { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  {
    type: "choice",
    name: "category",
    instructions: "Which category is this listing?",
    options: [
      { name: "car", description: "A car, van or motorbike" },
      { name: "flat", description: "A flat, house or room to rent or buy" },
      { name: "bike", description: "A bicycle or its parts" },
    ],
    stakes: "low",
    storeProbabilities: false,
  },
  {
    type: "score",
    name: "upfront",
    instructions: "How much payment does the seller ask for before the buyer can see the item?",
    levels: [
      { name: "none", description: "None: the buyer sees the item before paying anything" },
      { name: "deposit", description: "A deposit, with a viewing still possible" },
      { name: "before_viewing", description: "Payment before any viewing, or no viewing at all" },
    ],
    stakes: "low",
  },
];

/** Rows 98, 99 and 100 of the example's seeds: the three a `facetdb preview --limit 3` reads. */
const listings: readonly { readonly id: number; readonly state: Record<string, StateValue> }[] = [
  {
    id: 98,
    state: {
      title: "Trek mountain bike, 29 inch #98",
      description:
        "Good condition, a few scratches, recently serviced. Collection only, happy to show it running before you pay.",
    },
  },
  {
    id: 99,
    state: {
      title: "Honda CB500 motorbike, serviced #99",
      description:
        "Full service history, MOT until next year, two keys. Viewing welcome at my home address, cash or bank transfer on collection.",
    },
  },
  {
    id: 100,
    state: {
      title: "Room in a shared house, bills included #100",
      description:
        "URGENT. Owner abroad, item is at a shipping agent. Pay the deposit by gift card or crypto today and we deliver tomorrow. No viewing possible, contact only on WhatsApp +00 000 000.",
    },
  },
];

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * What the address the operator set holds: a server ready for the case (with what it said about
 * itself), nothing to run against (the case skips loudly), or something that is not the server the
 * case expects (the case fails: a set variable means the operator meant to run it).
 */
type Readiness =
  | { readonly kind: "ready"; readonly about: string }
  | { readonly kind: "absent"; readonly why: string }
  | { readonly kind: "wrong"; readonly why: string };

type LiveCase = {
  readonly preset: PresetName;
  /** The variable that holds the server's base URL; unset, the case skips loudly. */
  readonly variable: string;
  readonly ready: (address: string) => Promise<Readiness>;
  /** The model names the response may carry. */
  readonly answeredBy: readonly string[];
  /** Whether the server counts one output token per question (Strands Decider: one slot each). */
  readonly outputTokenPerQuestion: boolean;
};

async function getJson(url: string): Promise<{ status: number; body: unknown } | string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const strandsHealth = z.object({
  model: z.string(),
  checkpoint: z.string(),
  base_model: z.string(),
  device: z.string(),
});

const ollamaTags = z.object({ models: z.array(z.object({ name: z.string() })) });

const cases: readonly LiveCase[] = [
  {
    preset: "strands-decider",
    variable: "STRANDS_DECIDER_URL",
    // Only an unset variable skips: an address that was set and does not answer as a Strands
    // Decider server fails, whatever the reason.
    async ready(address) {
      const health = await getJson(`${address}/health`);
      if (typeof health === "string") {
        return { kind: "wrong", why: `nothing answers at ${address}/health (${health})` };
      }
      if (health.status !== 200) {
        return { kind: "wrong", why: `${address}/health answered status ${health.status}` };
      }
      const parsed = strandsHealth.safeParse(health.body);
      return parsed.success
        ? {
            kind: "ready",
            about: `checkpoint=${parsed.data.checkpoint} base=${parsed.data.base_model} device=${parsed.data.device}`,
          }
        : { kind: "wrong", why: `${address}/health is not a Strands Decider server's health` };
    },
    answeredBy: [CHECKPOINT],
    outputTokenPerQuestion: true,
  },
  {
    preset: "ollama",
    variable: "OLLAMA_URL",
    // Skips when no Ollama answers at all, or when the Ollama there has no Strands Decider under
    // the name (its build needs an Apple silicon Mac); an answer that is not Ollama's fails.
    async ready(address) {
      const tags = await getJson(`${address}/api/tags`);
      if (typeof tags === "string") {
        return { kind: "absent", why: `nothing answers at ${address}/api/tags (${tags})` };
      }
      if (tags.status !== 200) {
        return { kind: "wrong", why: `${address}/api/tags answered status ${tags.status}` };
      }
      const parsed = ollamaTags.safeParse(tags.body);
      if (!parsed.success) {
        return { kind: "wrong", why: `${address}/api/tags is not Ollama's model list` };
      }
      const names = parsed.data.models.map((model) => model.name);
      const has = names.length === 0 ? "none" : names.join(", ");
      return names.includes(MODEL) || names.includes(`${MODEL}:latest`)
        ? { kind: "ready", about: `models=${names.join(",")}` }
        : {
            kind: "absent",
            why:
              `no Ollama model is named ${MODEL} (it has: ${has}); on an Apple silicon Mac: ` +
              `ollama pull strands-decider && ollama cp strands-decider ${MODEL}`,
          };
    },
    // Not yet run: Ollama is expected to echo the name it was asked, with or without its tag.
    answeredBy: [MODEL, `${MODEL}:latest`],
    outputTokenPerQuestion: false,
  },
];

/** The server's own timing, when its response carries one (Strands Decider's `latency_ms`). */
const serverTiming = z.object({ latency_ms: z.number() });

/** The exchange the preset made, read beside the provider's parsed answer. */
type Exchange = { url: string; sent: unknown; serverMs: number | undefined };

function recordingFetch(exchanges: Exchange[]): typeof fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const raw: unknown = await response
      .clone()
      .json()
      .catch(() => undefined);
    const timing = serverTiming.safeParse(raw);
    exchanges.push({
      url: input instanceof Request ? input.url : String(input),
      sent: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      serverMs: timing.success ? timing.data.latency_ms : undefined,
    });
    return response;
  };
}

for (const live of cases) {
  const variable = process.env[live.variable];
  const address =
    variable === undefined || variable === "" ? undefined : variable.replace(/\/+$/, "");
  const readiness: Readiness =
    address === undefined
      ? { kind: "absent", why: `${live.variable} is not set` }
      : await live.ready(address);
  if (readiness.kind === "absent") {
    process.stderr.write(
      `\n${live.preset} live: SKIPPED, nothing was proven: ${readiness.why}.\n` +
        `Once its server is ready: ${live.variable}=<its base URL> pnpm --filter @facetdb/model run test:live presets\n\n`,
    );
  } else if (readiness.kind === "ready") {
    process.stderr.write(`${live.preset} live: ${address} ${readiness.about}\n`);
  }

  describe.skipIf(readiness.kind === "absent")(`${live.preset} preset live`, () => {
    if (readiness.kind === "wrong") {
      it(`reaches the server ${live.variable} names`, () => {
        throw new Error(
          `${live.variable} is set, so this case was meant to run, but ${readiness.why}`,
        );
      });
      return;
    }
    it.each(listings)("answers listing $id in the documented shape", async ({ id, state }) => {
      const exchanges: Exchange[] = [];
      const provider = selectProvider({
        provider: live.preset,
        modelUrl: address,
        // A preset reads only its own key variable; a local server needs none.
        env: process.env,
        fetch: recordingFetch(exchanges),
        clock: systemClock,
      });
      const request: ProviderRequest = { model: MODEL, state, questions };

      const started = performance.now();
      const response = await provider.ask(request);
      const wallMs = performance.now() - started;

      // One request to the preset's address, carrying the config's exact version.
      expect(exchanges).toHaveLength(1);
      const [exchange] = exchanges;
      expect(exchange?.url).toBe(`${address}/v1/systemone`);
      expect(exchange?.sent).toMatchObject({ model: MODEL });

      // The model the response names is what the decision log records.
      expect(live.answeredBy).toContain(response.model);

      // The spending cap counts input tokens; a real call never costs nothing.
      expect(Number.isInteger(response.usage.inputTokens)).toBe(true);
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(Number.isInteger(response.usage.outputTokens)).toBe(true);
      if (live.outputTokenPerQuestion) {
        expect(response.usage.outputTokens).toBe(questions.length);
      } else {
        expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
      }

      // The shapes the thresholds consume, already validated by parseAnswers at the boundary.
      expect(Object.keys(response.answers).sort()).toEqual(["category", "is_scam", "upfront"]);

      const isScam = response.answers["is_scam"];
      if (isScam?.type !== "noul") {
        throw new Error(`is_scam is not a noul answer: ${JSON.stringify(isScam)}`);
      }
      expect(isScam.probability).toBeGreaterThanOrEqual(0);
      expect(isScam.probability).toBeLessThanOrEqual(1);

      const category = response.answers["category"];
      if (category?.type !== "choice") {
        throw new Error(`category is not a choice answer: ${JSON.stringify(category)}`);
      }
      expect(["car", "flat", "bike"]).toContain(category.top);
      expect(category.probabilities).toHaveLength(3);
      expect(category.probabilities.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 2);

      const upfront = response.answers["upfront"];
      if (upfront?.type !== "score") {
        throw new Error(`upfront is not a score answer: ${JSON.stringify(upfront)}`);
      }
      expect(upfront.probabilities).toHaveLength(3);
      expect(upfront.probabilities.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 2);
      expect(upfront.confidence).toBeGreaterThanOrEqual(0);
      expect(upfront.confidence).toBeLessThanOrEqual(1);
      expect(upfront.expected).toBeGreaterThanOrEqual(0);
      // The probability-weighted level, between the lowest (0) and the highest.
      expect(upfront.expected).toBeLessThanOrEqual(upfront.probabilities.length - 1);

      // What the run records. Never a key.
      const fixed = (values: readonly number[]) => values.map((p) => p.toFixed(3)).join(", ");
      process.stderr.write(
        `${live.preset} live: listing ${id} sent model=${MODEL} answered model=${response.model} ` +
          `input_tokens=${response.usage.inputTokens} output_tokens=${response.usage.outputTokens} ` +
          `wall=${wallMs.toFixed(0)}ms server=${exchange?.serverMs ?? "n/a"}ms ` +
          `is_scam=${isScam.probability.toFixed(3)} category=${category.top} [${fixed(category.probabilities)}] ` +
          `upfront=${upfront.expected.toFixed(3)} [${fixed(upfront.probabilities)}] confidence=${upfront.confidence.toFixed(3)}\n`,
      );
    });
  });
}
