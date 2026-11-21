import {
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  parseAnswers,
  type Question,
  ResponseShapeError,
} from "@facetdb/core";
import { assertPinned, RetryableError } from "@facetdb/model";
import { z } from "zod";
import type { PluginProviderRef } from "../config/index.ts";
import type { PluginHost } from "./host.ts";

/**
 * A provider an installed plugin supplies (`provider: "<plugin>/<entry>"`), as a `ModelProvider`
 * the worker wraps in its own backoff and in-flight limit like any other. The plugin is third-party
 * code: the model name is checked before the call and what it returns is judged after it by core's
 * own parser (the one an HTTP provider's response goes through), a failed call is an error and
 * never an answer, and a plugin that holds secrets never has its own words printed.
 */

/** The configured plugin provider cannot be used; says what is wrong and what to do. */
export class PluginProviderError extends Error {
  readonly fix: string;

  constructor(message: string, fix: string) {
    super(message);
    this.name = "PluginProviderError";
    this.fix = fix;
  }
}

/** A plugin's provider failed a call or answered outside the rules; the words never quote a secret. */
export class PluginProviderFailure extends Error {
  constructor(provider: string, reason: string) {
    super(`the provider "${provider}" failed: ${reason}`);
    this.name = "PluginProviderFailure";
  }
}

// What a plugin hands back is `ProviderResponse`, the shape core's thresholds consume. Its form is
// judged here; every rule on its values is core's own parser's (`parseAnswers`), the one the HTTP
// providers' responses go through, so a plugin's answer is held to exactly what TypeSafe's is.
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability: z.number() }),
  z.object({ type: z.literal("choice"), top: z.string(), probabilities: z.array(z.number()) }),
  z.object({
    type: z.literal("score"),
    probabilities: z.array(z.number()),
    confidence: z.number(),
    expected: z.number(),
  }),
]);

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
});

type PluginAnswer = z.infer<typeof answerSchema>;

/**
 * One plugin answer as the System One response writes it, so core's parser can judge it: a
 * choice's probabilities keyed by option name, a score's by level index. A list that is not one
 * per option or level cannot be keyed and is refused here, as a missing or extra key is by core.
 */
function wireAnswer(name: string, answer: PluginAnswer, question: Question | undefined): unknown {
  const field = `answers.${name}.probabilities`;
  switch (answer.type) {
    case "noul":
      return { noul: answer.probability };
    case "choice": {
      const keys = question?.type === "choice" ? question.options.map((option) => option.name) : [];
      if (question?.type === "choice" && answer.probabilities.length !== keys.length) {
        throw new ResponseShapeError(
          field,
          `has ${answer.probabilities.length} entries, not one for each of the ${keys.length} options`,
        );
      }
      return {
        choice: answer.top,
        probabilities: Object.fromEntries(keys.map((key, at) => [key, answer.probabilities[at]])),
      };
    }
    case "score": {
      const keys = question?.type === "score" ? question.levels.map((_, at) => String(at)) : [];
      if (question?.type === "score" && answer.probabilities.length !== keys.length) {
        throw new ResponseShapeError(
          field,
          `has ${answer.probabilities.length} entries, not one for each of the ${keys.length} levels`,
        );
      }
      return {
        score: answer.expected,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(keys.map((key, at) => [key, answer.probabilities[at]])),
      };
    }
  }
}

/**
 * The plugin's response, judged by core's parser: every question answered once and none unknown,
 * a choice's `top` one of its options and at its highest probability, probabilities in range, the
 * token counts whole. Throws `ResponseShapeError`, naming the field.
 */
function judgedResponse(request: ProviderRequest, raw: unknown): ProviderResponse {
  const shaped = responseSchema.safeParse(raw);
  if (!shaped.success) {
    const issue = shaped.error.issues[0];
    throw new ResponseShapeError(
      issue === undefined || issue.path.length === 0 ? "response" : issue.path.join("."),
      "is not the shape a provider returns",
    );
  }
  const { model, answers, usage } = shaped.data;
  const byName = new Map(request.questions.map((question) => [question.name, question]));
  const wire = {
    model,
    answers: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [
        name,
        wireAnswer(name, answer, byName.get(name)),
      ]),
    ),
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
  return parseAnswers(
    {
      questions: request.questions,
      read: Object.keys(request.state),
      model: request.model,
      thresholds: {},
    },
    wire,
  );
}

/**
 * The failure's words. A plugin that holds secrets never has its own words printed (they could
 * quote one, in a form no replacement would find): fixed words name the provider, and a `status`
 * the error carries is kept. A plugin with none has its message shown as it wrote it.
 */
function failureWords(
  error: unknown,
  secrets: Readonly<Record<string, string>>,
  field: string | undefined,
): string {
  const holdsSecrets = Object.keys(secrets).length > 0;
  const status = (error as { status?: unknown } | null)?.status;
  const kept = typeof status === "number" ? ` (status ${status})` : "";
  if (field !== undefined) {
    return holdsSecrets ? `its response was refused at ${field}` : (error as Error).message;
  }
  if (holdsSecrets) {
    return `the plugin's own words are not shown, as they could quote a secret${kept}`;
  }
  return `${error instanceof Error ? error.message : "it rejected the call"}${kept}`;
}

/** A plugin signals a rate limit or an overload with `status` 429 or 529, as the other providers do. */
function retryable(error: unknown): RetryableError | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { status, retryAfterMs } = error as { status?: unknown; retryAfterMs?: unknown };
  if (status !== 429 && status !== 529) {
    return undefined;
  }
  return new RetryableError(status, typeof retryAfterMs === "number" ? retryAfterMs : undefined);
}

export type PluginProviderOptions = {
  /** The config's `provider`, as written: the name in every refusal. */
  readonly provider: string;
  readonly ref: PluginProviderRef;
  readonly host: PluginHost;
  /** Aborted when the process stops; the plugin's calls receive it. */
  readonly signal: AbortSignal;
};

/** The entry the config's `provider` names, and the settings of its one use; throws what is wrong. */
function resolveEntry(options: Omit<PluginProviderOptions, "signal">) {
  const { provider, ref, host } = options;
  const hosted = host.plugin(ref.plugin);
  if (hosted === undefined) {
    throw new PluginProviderError(
      `provider names the plugin "${ref.plugin}", which the config did not load`,
      `check provider in facetdb.config.ts, then run the command again`,
    );
  }
  const entry = Object.hasOwn(hosted.plugin.providers, ref.entry)
    ? hosted.plugin.providers[ref.entry]
    : undefined;
  if (entry === undefined) {
    const supplied = Object.keys(hosted.plugin.providers);
    throw new PluginProviderError(
      `provider names "${ref.entry}", and the plugin "${hosted.packageName}" supplies ${supplied.length === 0 ? "no provider" : `only ${supplied.join(", ")}`}`,
      supplied.length === 0
        ? "name a plugin that supplies a provider, or use a built-in provider"
        : `use ${supplied.map((name) => `"${ref.plugin}/${name}"`).join(" or ")} as provider`,
    );
  }
  // One use of a provider has no settings of its own in the config: its schema must hold with none
  // (every field defaulted or optional); what the plugin needs is its `plugins` settings.
  const settings = entry.config.safeParse({});
  if (!settings.success) {
    throw new PluginProviderError(
      `the provider "${provider}" needs settings of its own (${settings.error.issues.map((issue) => issue.path.join(".")).join(", ")}), and the config has no place for them`,
      `ask the plugin's author to read its provider's settings from the plugin's own config, or give them defaults`,
    );
  }
  return { entry, settings: settings.data };
}

/** Throws a `PluginProviderError` when the config's `provider` names no entry the plugin supplies. */
export function checkPluginProvider(options: Omit<PluginProviderOptions, "signal">): void {
  resolveEntry(options);
}

/**
 * The plugin's entry as a `ModelProvider`: the model must be an exact version before the call, a
 * 429 or 529 (a `status` on what the plugin throws) is retried by the worker's backoff, any other
 * failure is an error, and the response must be the shape the questions expect.
 */
export function createPluginProvider(options: PluginProviderOptions): ModelProvider {
  const { provider, ref, host, signal } = options;
  const { entry, settings } = resolveEntry(options);
  return {
    async ask(request: ProviderRequest): Promise<ProviderResponse> {
      assertPinned(request.model);
      const context = host.contextFor(ref.plugin, signal);
      let raw: unknown;
      try {
        raw = await entry.ask(context, request, settings);
      } catch (error) {
        const again = retryable(error);
        if (again !== undefined) {
          throw again;
        }
        throw new PluginProviderFailure(provider, failureWords(error, context.secrets, undefined));
      }
      try {
        return judgedResponse(request, raw);
      } catch (error) {
        if (error instanceof ResponseShapeError) {
          throw new PluginProviderFailure(
            provider,
            failureWords(error, context.secrets, error.field),
          );
        }
        throw error;
      }
    },
  };
}
