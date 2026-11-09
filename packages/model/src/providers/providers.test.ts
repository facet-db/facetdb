import type { ProviderRequest, Question } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { ModelUnreachableError, UnexpectedStatusError } from "../errors.ts";
import { createCompatibleProvider } from "./compatible.ts";
import { assertPinned, listModels, ModelNotPinnedError } from "./models.ts";
import { createPresetProvider, PROVIDER_PRESETS, type PresetName } from "./presets.ts";
import { selectProvider } from "./select.ts";

const question: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing a scam?",
  criteria: { true: "asks for payment outside the platform" },
  stakes: "high",
};

const request: ProviderRequest = {
  model: "jev-1.14.0",
  state: { body: "Pay by gift card" },
  questions: [question],
};

const answerBody = (model: string) => ({
  model,
  answers: { scam: { noul: 0.9 } },
  usage: { input_tokens: 40, output_tokens: 0 },
});

type Seen = { url: string; method: string; headers: Record<string, string> };

/** One header of a recorded call, by name (a variable key keeps the index-signature rule happy). */
function header(call: Seen | undefined, name: string): string | undefined {
  return call?.headers[name];
}

/** A fetch that records every call and answers with `respond`. */
function fakeFetch(respond: (url: string) => Response = () => json(200, answerBody("jev-1.14.0"))) {
  const seen: Seen[] = [];
  const fetchFake = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    return Promise.resolve(respond(String(url)));
  }) as typeof fetch;
  return { fetchFake, seen };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const clock = new FakeClock(0);

describe("provider presets", () => {
  it.each([
    ["openrouter", "https://openrouter.ai/api/v1/systemone", "authorization", "Bearer sk-user"],
    [
      "vercel-ai-gateway",
      "https://ai-gateway.vercel.sh/v1/systemone",
      "authorization",
      "Bearer sk-user",
    ],
    [
      "cloudflare-ai-gateway",
      "https://gateway.example/v1/systemone",
      "cf-aig-authorization",
      "Bearer sk-user",
    ],
    ["ollama", "http://localhost:11434/v1/systemone", undefined, undefined],
    ["strands-decider", "https://decider.example/v1/systemone", "authorization", "Bearer sk-user"],
    ["solar-decide", "https://solar.example/v1/systemone", "authorization", "Bearer sk-user"],
  ] as const)(
    "%s posts to its base URL with its key header and no other key",
    async (name, url, keyHeader, keyValue) => {
      const { fetchFake, seen } = fakeFetch();
      // The two hosts this build does not know, and the account-bound gateway, take `modelUrl`.
      const provider = createPresetProvider(name as PresetName, {
        modelUrl: url.replace("/v1/systemone", ""),
        apiKey: keyValue === undefined ? undefined : "sk-user",
        fetch: fetchFake,
        clock,
      });
      await provider.ask(request);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(url);
      expect(seen[0]?.method).toBe("POST");
      if (keyHeader === undefined) {
        expect(seen[0]?.headers).not.toHaveProperty("authorization");
      } else {
        expect(seen[0]?.headers[keyHeader]).toBe(keyValue);
      }
      expect(seen[0]?.headers["content-type"]).toBe("application/json");
    },
  );

  it("uses a preset's own base URL when no modelUrl is given", async () => {
    const { fetchFake, seen } = fakeFetch();
    const provider = createPresetProvider("openrouter", {
      apiKey: "sk-user",
      fetch: fetchFake,
      clock,
    });
    await provider.ask(request);
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
  });

  it.each(["cloudflare-ai-gateway", "strands-decider", "solar-decide"] as const)(
    "%s refuses to start without a modelUrl, since this build has no base URL for it",
    (name) => {
      const { fetchFake } = fakeFetch();
      expect(() => createPresetProvider(name, { fetch: fetchFake, clock })).toThrow(/modelUrl/);
    },
  );

  it("no preset contains a secret or a default key", () => {
    const allowed = new Set(["baseUrl", "keyHeader"]);
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      for (const field of Object.keys(preset)) {
        expect(allowed.has(field), `${name} has the field ${field}`).toBe(true);
      }
      expect(JSON.stringify(preset), name).not.toMatch(/sk-|Bearer|key=|token|secret/i);
    }
  });

  it("sends no key header when the caller gives no key, so no default key is ever sent", async () => {
    const { fetchFake, seen } = fakeFetch();
    const provider = createPresetProvider("openrouter", { fetch: fetchFake, clock });
    await provider.ask(request);
    expect(seen[0]?.headers).not.toHaveProperty("authorization");
  });
});

describe("pinned versions in providers", () => {
  it.each(["jev-latest", "jev-preview", "jev-1.14", "Jev-1.14.0"])(
    "refuses %s before any call is made",
    async (model) => {
      const { fetchFake, seen } = fakeFetch();
      const provider = createPresetProvider("openrouter", { apiKey: "k", fetch: fetchFake, clock });
      const error = await provider.ask({ ...request, model }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelNotPinnedError);
      expect(seen).toHaveLength(0);
    },
  );

  it("accepts an exact version and refuses an alias by name", () => {
    expect(assertPinned("jev-1.14.0")).toBe("jev-1.14.0");
    expect(() => assertPinned("jev-latest")).toThrow(/jev-latest/);
  });
});

describe("the logged model is the response's", () => {
  it("returns the model the response named, not the one asked for", async () => {
    const { fetchFake } = fakeFetch(() => json(200, answerBody("jev-1.13.0")));
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    const response = await provider.ask(request);
    expect(response.model).toBe("jev-1.13.0");
    expect(response.answers).toEqual({ scam: { type: "noul", probability: 0.9 } });
  });
});

describe("listModels", () => {
  it("lists the ids the server offers through GET /v1/models", async () => {
    const { fetchFake, seen } = fakeFetch((url) =>
      url.endsWith("/v1/models")
        ? json(200, { object: "list", data: [{ id: "jev-1.13.0" }, { id: "jev-1.14.0" }] })
        : json(200, answerBody("jev-1.14.0")),
    );
    const provider = createPresetProvider("openrouter", { apiKey: "k", fetch: fetchFake, clock });
    const list = await listModels(provider, "jev-1.14.0");
    expect(list).toEqual({ source: "server", models: ["jev-1.13.0", "jev-1.14.0"] });
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(seen[0]?.method).toBe("GET");
    expect(header(seen[0], "authorization")).toBe("Bearer k");
  });

  it("echoes the configured model when the server offers no list", async () => {
    const { fetchFake } = fakeFetch(() => json(404, {}));
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    expect(await listModels(provider, "jev-1.14.0")).toEqual({
      source: "configured",
      models: ["jev-1.14.0"],
    });
  });

  it("refuses an alias as the configured model", async () => {
    const { fetchFake, seen } = fakeFetch();
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    await expect(listModels(provider, "jev-latest")).rejects.toBeInstanceOf(ModelNotPinnedError);
    expect(seen).toHaveLength(0);
  });

  it("treats any other failure as an error, never a guess", async () => {
    const { fetchFake } = fakeFetch(() => json(500, {}));
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    await expect(listModels(provider, "jev-1.14.0")).rejects.toBeInstanceOf(UnexpectedStatusError);
  });

  it("refuses a list that is not in the OpenAI-style shape", async () => {
    const { fetchFake } = fakeFetch(() => json(200, { models: ["x"] }));
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    await expect(listModels(provider, "jev-1.14.0")).rejects.toThrow(/models/);
  });

  it("reports an unreachable server as unreachable", async () => {
    const fetchFake = (() => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = createCompatibleProvider({
      baseUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    await expect(listModels(provider, "jev-1.14.0")).rejects.toBeInstanceOf(ModelUnreachableError);
  });
});

describe("provider selection", () => {
  it("picks a compatible provider when modelUrl is set", async () => {
    const { fetchFake, seen } = fakeFetch();
    const provider = selectProvider({
      modelUrl: "http://localhost:11434",
      fetch: fetchFake,
      clock,
    });
    await provider.ask(request);
    expect(seen[0]?.url).toBe("http://localhost:11434/v1/systemone");
  });

  it("picks TypeSafe direct with its key when modelUrl is absent", async () => {
    const { fetchFake, seen } = fakeFetch();
    const provider = selectProvider({ apiKey: "sk-typesafe", fetch: fetchFake, clock });
    await provider.ask(request);
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(header(seen[0], "authorization")).toBe("Bearer sk-typesafe");
  });

  it("refuses to choose a provider when there is neither a modelUrl nor a key", () => {
    const { fetchFake } = fakeFetch();
    expect(() => selectProvider({ fetch: fetchFake, clock })).toThrow(/TYPESAFE_API_KEY/);
  });
});
