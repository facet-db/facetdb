import { MODEL_VERSION_PATTERN, ResponseShapeError } from "@facetdb/core";
import { z } from "zod";
import { ModelUnreachableError, UnexpectedStatusError } from "../errors.ts";
import { MODELS_PATH } from "../paths.ts";
import type { CompatibleProvider } from "./compatible.ts";

/** A model name that is not an exact version: an alias such as `jev-latest`, or any other form. */
export class ModelNotPinnedError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`model must be an exact version such as jev-1.14.0, not "${model}"`);
    this.name = "ModelNotPinnedError";
    this.model = model;
  }
}

/** Returns the name when it is an exact version (core's rule), and throws otherwise. */
export function assertPinned(name: string): string {
  if (!MODEL_VERSION_PATTERN.test(name)) {
    throw new ModelNotPinnedError(name);
  }
  return name;
}

/**
 * Where a model list came from: `server` when the server offered `GET /v1/models`, `configured`
 * when it did not (a 404) and the configured model is echoed instead.
 */
export type ModelList = {
  readonly source: "server" | "configured";
  readonly models: readonly string[];
};

// The OpenAI-style list that gateways and Ollama serve; only the ids are read.
const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/**
 * Lists the models a compatible provider offers. A 404 means the server does not offer a list, so
 * the configured model is echoed; any other failure is an error, never a guess. The configured
 * model is checked for a pinned version first, like every model name.
 */
export async function listModels(
  provider: CompatibleProvider,
  configuredModel: string,
): Promise<ModelList> {
  assertPinned(configuredModel);
  let response: Response;
  try {
    response = await provider.fetch(`${provider.baseUrl}${MODELS_PATH}`, {
      method: "GET",
      headers: provider.headers,
    });
  } catch (cause) {
    throw new ModelUnreachableError(cause instanceof Error ? cause.message : "the request failed", {
      cause,
    });
  }
  if (response.status === 404) {
    return { source: "configured", models: [configuredModel] };
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(response.status);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = modelListSchema.safeParse(body);
  if (!parsed.success) {
    throw new ResponseShapeError("models", "is not a list of model ids");
  }
  return { source: "server", models: parsed.data.data.map((model) => model.id) };
}
