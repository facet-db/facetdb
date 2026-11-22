import type { ProviderRequest, Question } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { ModelNotPinnedError } from "./models.ts";
import {
  isPresetName,
  keyWithheld,
  mayCarryKey,
  PRESET_KEYS,
  PRESET_NAMES,
  PROVIDER_PRESETS,
} from "./presets.ts";
import { ProviderKeyMissingError, selectProvider, UnknownProviderError } from "./select.ts";

/**
 * The config's `provider`: each preset's address, key header and key variable, the TypeSafe key
 * sent nowhere but to TypeSafe, a missing key named by its variable. No request leaves the test: a
 * recording fetch answers.
 */

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

const answerBody = {
  model: "jev-1.14.0",
  answers: { scam: { noul: 0.9 } },
  usage: { input_tokens: 40, output_tokens: 0 },
};

type Seen = { url: string; headers: Record<string, string> };

/** A fetch that records every call and answers one scam question. */
function recordingFetch() {
  const seen: Seen[] = [];
  const fetchFake = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    return Promise.resolve(
      new Response(JSON.stringify(answerBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetchFake, seen };
}

const clock = new FakeClock(0);
const TYPESAFE_KEY = "tsk-typesafe-s3cret";

/** What each preset sends, as its vendor documents it (the base URL a test gives where this build has none). */
const PRESETS = [
  {
    name: "vercel-ai-gateway",
    modelUrl: undefined,
    url: "https://ai-gateway.vercel.sh/v1/systemone",
    header: "authorization",
    prefix: "Bearer ",
    variable: "AI_GATEWAY_API_KEY",
  },
  {
    name: "cloudflare-ai-gateway",
    modelUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw",
    url: "https://gateway.ai.cloudflare.com/v1/acct/gw/v1/systemone",
    header: "cf-aig-authorization",
    prefix: "Bearer ",
    variable: "CF_AIG_TOKEN",
  },
  {
    name: "ollama",
    modelUrl: undefined,
    url: "http://localhost:11434/v1/systemone",
    header: "authorization",
    prefix: "Bearer ",
    variable: "OLLAMA_API_KEY",
  },
  {
    name: "strands-decider",
    modelUrl: "https://decider.internal:8080",
    url: "https://decider.internal:8080/v1/systemone",
    header: "authorization",
    prefix: "Bearer ",
    variable: "STRANDS_DECIDER_API_KEY",
  },
  {
    name: "solar-decide",
    modelUrl: "https://solar.example",
    url: "https://solar.example/v1/systemone",
    header: "authorization",
    prefix: "Bearer ",
    variable: "UPSTAGE_API_KEY",
  },
] as const;

describe("every preset", () => {
  it("is covered by this table, once", () => {
    expect(PRESETS.map((preset) => preset.name).sort()).toEqual([...PRESET_NAMES].sort());
  });

  it.each(PRESETS)(
    "$name asks $url with its key in $header, read from $variable",
    async (preset) => {
      const { fetchFake, seen } = recordingFetch();
      const provider = selectProvider({
        provider: preset.name,
        modelUrl: preset.modelUrl,
        apiKey: TYPESAFE_KEY,
        env: { [preset.variable]: "vendor-s3cret", TYPESAFE_API_KEY: TYPESAFE_KEY },
        fetch: fetchFake,
        clock,
      });
      await provider.ask(request);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(preset.url);
      expect(seen[0]?.headers[preset.header]).toBe(`${preset.prefix}vendor-s3cret`);
      expect(PRESET_KEYS[preset.name].variable).toBe(preset.variable);
    },
  );

  it.each(PRESETS)(
    "$name never sends the TypeSafe key, in any header or the body",
    async (preset) => {
      const { fetchFake, seen } = recordingFetch();
      const bodies: string[] = [];
      const spying = ((url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return fetchFake(url, init);
      }) as typeof fetch;
      await selectProvider({
        provider: preset.name,
        modelUrl: preset.modelUrl,
        apiKey: TYPESAFE_KEY,
        env: { [preset.variable]: "vendor-s3cret", TYPESAFE_API_KEY: TYPESAFE_KEY },
        fetch: spying,
        clock,
      }).ask(request);
      expect(JSON.stringify(seen)).not.toContain(TYPESAFE_KEY);
      expect(bodies.join("")).not.toContain(TYPESAFE_KEY);
    },
  );

  it.each(PRESETS)(
    "$name sends no TypeSafe key when its own variable is unset, only the refusal or no key",
    async (preset) => {
      const { fetchFake, seen } = recordingFetch();
      const make = () =>
        selectProvider({
          provider: preset.name,
          modelUrl: preset.modelUrl,
          apiKey: TYPESAFE_KEY,
          env: { TYPESAFE_API_KEY: TYPESAFE_KEY },
          fetch: fetchFake,
          clock,
        });
      if (PRESET_KEYS[preset.name].required) {
        expect(make).toThrow(ProviderKeyMissingError);
      } else {
        await make().ask(request);
      }
      expect(JSON.stringify(seen)).not.toContain(TYPESAFE_KEY);
      expect(seen.every((call) => call.headers[preset.header] === undefined)).toBe(true);
    },
  );

  it.each(PRESETS.filter((preset) => PRESET_KEYS[preset.name].required))(
    "$name with no key names $variable, never the TypeSafe key's variable",
    (preset) => {
      const { fetchFake } = recordingFetch();
      const error = (() => {
        try {
          selectProvider({
            provider: preset.name,
            modelUrl: preset.modelUrl,
            apiKey: TYPESAFE_KEY,
            env: { [preset.variable]: "" },
            fetch: fetchFake,
            clock,
          });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(ProviderKeyMissingError);
      expect((error as Error).message).toBe(
        `${preset.variable} is not set, so the ${preset.name} provider has no key`,
      );
      expect((error as Error).message).not.toContain("TYPESAFE");
    },
  );

  it("is marked not run until a live run proves it", () => {
    for (const name of PRESET_NAMES) {
      expect(PRESET_KEYS[name].proven, name).toBe(false);
    }
  });

  it.each(["jev-latest", "jev-preview", "jev-1.14", "Jev-1.14.0"])(
    "refuses %s before any call, for every preset",
    async (model) => {
      for (const preset of PRESETS) {
        const { fetchFake, seen } = recordingFetch();
        const provider = selectProvider({
          provider: preset.name,
          modelUrl: preset.modelUrl,
          env: { [preset.variable]: "vendor-s3cret" },
          fetch: fetchFake,
          clock,
        });
        const error = await provider.ask({ ...request, model }).catch((caught: unknown) => caught);
        expect(error, preset.name).toBeInstanceOf(ModelNotPinnedError);
        expect(seen, preset.name).toHaveLength(0);
      }
    },
  );
});

describe("the addresses", () => {
  it("a modelUrl beside a preset replaces the preset's address", async () => {
    const { fetchFake, seen } = recordingFetch();
    await selectProvider({
      provider: "vercel-ai-gateway",
      modelUrl: "https://proxy.internal/gateway",
      env: { AI_GATEWAY_API_KEY: "aig-s3cret" },
      fetch: fetchFake,
      clock,
    }).ask(request);
    expect(seen[0]?.url).toBe("https://proxy.internal/gateway/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer aig-s3cret");
  });

  it.each(
    PRESET_NAMES.filter(
      (name) => (PROVIDER_PRESETS[name] as { baseUrl?: string }).baseUrl === undefined,
    ),
  )("%s has no address of its own and needs modelUrl", (name) => {
    const { fetchFake } = recordingFetch();
    expect(() =>
      selectProvider({
        provider: name,
        env: { [PRESET_KEYS[name].variable]: "vendor-s3cret" },
        fetch: fetchFake,
        clock,
      }),
    ).toThrow(/modelUrl/);
  });

  it("refuses a name that is not a preset, listing the presets", () => {
    const { fetchFake } = recordingFetch();
    expect(() => selectProvider({ provider: "openai", env: {}, fetch: fetchFake, clock })).toThrow(
      UnknownProviderError,
    );
    expect(isPresetName("openai")).toBe(false);
    expect(isPresetName("vercel-ai-gateway")).toBe(true);
  });
});

describe("with no provider the behavior is today's", () => {
  it("asks TypeSafe direct with TYPESAFE_API_KEY", async () => {
    const { fetchFake, seen } = recordingFetch();
    await selectProvider({ apiKey: TYPESAFE_KEY, fetch: fetchFake, clock }).ask(request);
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TYPESAFE_KEY}`);
  });

  it("asks the server at modelUrl with TYPESAFE_API_KEY when it is set", async () => {
    const { fetchFake, seen } = recordingFetch();
    await selectProvider({
      modelUrl: "http://localhost:11434",
      apiKey: TYPESAFE_KEY,
      env: { AI_GATEWAY_API_KEY: "aig-s3cret" },
      fetch: fetchFake,
      clock,
    }).ask(request);
    expect(seen[0]?.url).toBe("http://localhost:11434/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TYPESAFE_KEY}`);
    expect(JSON.stringify(seen)).not.toContain("aig-s3cret");
  });

  it("says what to set when nothing is configured", () => {
    const { fetchFake } = recordingFetch();
    expect(() => selectProvider({ fetch: fetchFake, clock })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("refuses an alias for TypeSafe direct too", async () => {
    const { fetchFake, seen } = recordingFetch();
    const error = await selectProvider({ apiKey: TYPESAFE_KEY, fetch: fetchFake, clock })
      .ask({ ...request, model: "jev-latest" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelNotPinnedError);
    expect(seen).toHaveLength(0);
  });
});

describe("a key that is optional", () => {
  it("is sent when the variable is set, even for a local Ollama", async () => {
    const { fetchFake, seen } = recordingFetch();
    await selectProvider({
      provider: "ollama",
      env: { OLLAMA_API_KEY: "ol-s3cret" },
      fetch: fetchFake,
      clock,
    }).ask(request);
    expect(seen[0]?.headers["authorization"]).toBe("Bearer ol-s3cret");
  });

  it("is left out when the variable is empty", async () => {
    const { fetchFake, seen } = recordingFetch();
    await selectProvider({
      provider: "ollama",
      env: { OLLAMA_API_KEY: "" },
      fetch: fetchFake,
      clock,
    }).ask(request);
    expect(seen[0]?.headers).not.toHaveProperty("authorization");
  });

  it.each([
    ["http://localhost:11434", true],
    ["http://127.0.0.1:11434", true],
    ["http://127.4.5.6", true],
    ["http://[::1]:11434", true],
    ["https://ollama.com/api", true],
    ["https://decider.internal", true],
    ["http://decider.internal:8080", false],
    ["http://192.168.1.20:11434", false],
    ["http://localhost.evil.example", false],
    ["http://127.0.0.1.evil.example", false],
    ["not a url", false],
  ])("may %s carry a key: %s", (address, carries) => {
    expect(mayCarryKey(address)).toBe(carries);
  });

  it.each(["ollama", "strands-decider"] as const)(
    "%s is withheld from plain http to another host, and sent over https or to this machine",
    async (name) => {
      const variable = PRESET_KEYS[name].variable;
      const keyHeader = async (modelUrl: string) => {
        const { fetchFake, seen } = recordingFetch();
        await selectProvider({
          provider: name,
          modelUrl,
          env: { [variable]: "opt-s3cret" },
          fetch: fetchFake,
          clock,
        }).ask(request);
        expect(JSON.stringify(seen)).not.toContain(TYPESAFE_KEY);
        return seen[0]?.headers["authorization"];
      };
      expect(await keyHeader("http://decider.internal:8080")).toBeUndefined();
      expect(await keyHeader("http://10.0.0.7:11434")).toBeUndefined();
      expect(await keyHeader("https://decider.internal:8080")).toBe("Bearer opt-s3cret");
      expect(await keyHeader("http://localhost:11434")).toBe("Bearer opt-s3cret");
      expect(keyWithheld(name, "http://decider.internal:8080")).toBe(true);
      expect(keyWithheld(name, "https://decider.internal:8080")).toBe(false);
    },
  );

  it("never withholds a required key: those are the vendor's https addresses, or the user's own", () => {
    expect(keyWithheld("vercel-ai-gateway", "http://proxy.internal")).toBe(false);
    expect(keyWithheld("solar-decide", "http://solar.internal")).toBe(false);
  });
});
