import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actionCall,
  ConfigError,
  choice,
  configFileSource,
  facetdb,
  fromProjectJson,
  loadConfig,
  noul,
  type ProjectInput,
  parseProjectConfig,
  type SourceInput,
  score,
  toProjectJson,
} from "./index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const packageDir = join(fixtures, "..", "..", "..");
const CONNECTION = "postgres://app:s3cret@db.example.com:5432/shop";

const originalDatabaseUrl = process.env["DATABASE_URL"];
const scratch: string[] = [];

beforeEach(() => {
  process.env["DATABASE_URL"] = CONNECTION;
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalDatabaseUrl;
  }
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-config-"));
  scratch.push(dir);
  return dir;
}

const env = () => process.env;

/** Loads a config from a project directory with the warnings left unprinted. */
function load(projectDir: string, path = "facetdb.config.ts") {
  return loadConfig(path, { projectDir, env: env(), stderr: { write: () => true }, quiet: true });
}

function messagesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
  return [];
}

/** A project that passes, with one API source; a test overrides what it wants to break. */
function valid(overrides: Partial<SourceInput> = {}): ProjectInput {
  return {
    model: "jev-1.14.0",
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgency: score("How urgent is this?", ["low", "high"]) },
        ...overrides,
      },
    ],
  };
}

describe("the DSL", () => {
  it("names the questions, fills the defaults and moves per-question thresholds to the source", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "orders",
          api: true,
          read: ["note"],
          questions: {
            rush: noul("Is it a rush order?", { thresholds: { yesAbove: 0.9, noBelow: 0.1 } }),
            kind: choice("What kind?", { a: "Alpha", b: "Beta" }, { storeProbabilities: true }),
          },
        },
      ],
    });
    const source = config.sources[0];
    expect(config.onCapReached).toBe("pause");
    expect(source?.storage).toBe("inline");
    expect(source?.onChange).toBe("reset");
    expect(source?.onOutage).toBe("hold");
    expect(source?.questions.map((question) => question.name)).toEqual(["rush", "kind"]);
    expect(source?.thresholds).toEqual({ rush: { yesAbove: 0.9, noBelow: 0.1 } });
    expect(parseProjectConfig(config).ok).toBe(true);
  });

  it("lets the source-level thresholds win over a question's own", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "orders",
          api: true,
          read: ["note"],
          questions: { rush: noul("Rush?", { thresholds: { yesAbove: 0.9 } }) },
          thresholds: { rush: { yesAbove: 0.8 } },
        },
      ],
    });
    expect(config.sources[0]?.thresholds).toEqual({ rush: { yesAbove: 0.8 } });
  });
});

describe("the example config", () => {
  it("loads from the fixture and round-trips through the project JSON", async () => {
    const { config } = await load(fixtures);
    expect(config.model).toBe("jev-1.14.0");
    expect(config.sources.map((source) => source.name)).toEqual([
      "support_messages",
      "support_tickets",
    ]);
    const messages = config.sources[0];
    expect(messages?.database).toBe(CONNECTION);
    expect(messages?.databaseEnv).toBe("DATABASE_URL");
    expect(messages?.questions.map((question) => question.name)).toEqual([
      "urgency",
      "team",
      "wants_refund",
    ]);
    expect(messages?.questions[2]).toMatchObject({ type: "noul", stakes: "high" });
    expect(messages?.thresholds).toEqual({ urgency: { confidenceAtLeast: 0.6 } });
    expect(messages?.actions).toEqual([
      actionCall("@facetdb/slack", "notify", {
        channel: "#support-urgent",
        when: { urgency: "high" },
      }),
    ]);
    expect(config.sources[1]?.api).toBe(true);

    const json = toProjectJson(config);
    expect(JSON.stringify(json)).not.toContain("s3cret");
    expect(json.sources[0]?.database).toEqual({ env: "DATABASE_URL" });
    const imported = fromProjectJson(JSON.parse(JSON.stringify(json)), env());
    expect(toProjectJson(imported)).toEqual(json);
    expect(imported).toEqual(config);
  });

  it("exports a config file that loads to an equal project", async () => {
    const { config } = await load(fixtures);
    const dir = await scratchDir();
    // The exported file imports "facetdb"; this link is what `pnpm add facetdb` would put there.
    await mkdir(join(dir, "node_modules"));
    await symlink(packageDir, join(dir, "node_modules", "facetdb"));
    await writeFile(join(dir, "facetdb.config.ts"), configFileSource(config));
    const { config: reloaded } = await load(dir);
    expect(reloaded).toEqual(config);
  });

  it("writes the exported file the way a developer would", async () => {
    const { config } = await load(fixtures);
    const source = configFileSource(config);
    expect(source).toContain('import { actionCall, choice, facetdb, noul, score } from "facetdb";');
    expect(source).toContain("database: process.env.DATABASE_URL,");
    expect(source).toContain(
      'wants_refund": noul("Is the customer asking for their money back?", { stakes: "high" })',
    );
    expect(source).toContain('actionCall("@facetdb/slack", "notify", ');
    expect(source).not.toContain("s3cret");
  });

  it("round-trips every setting a source and a project can carry", async () => {
    const config = facetdb({
      model: "jev-1.14.0",
      modelUrl: "http://localhost:11434",
      alerts: { channels: ["slack:#ops"] },
      spendingCap: 5_000_000,
      onCapReached: "continue",
      sources: [
        {
          name: "orders",
          database: CONNECTION,
          table: "public.orders",
          read: ["note"],
          storage: "side-table",
          onChange: "keep",
          onOutage: "release",
          maxStateTokens: 40_000,
          model: "jev-1.15.0",
          questions: {
            kind: choice("Which number?", [
              { name: "1", description: "The first" },
              { name: "2", description: "The second" },
            ]),
            level: score("How bad?", [{ name: "low", description: "Barely" }, "high"]),
            rush: noul("Rush?", { criteria: { true: "Says today", false: "No date" } }),
          },
        },
      ],
    });
    const source = config.sources[0];
    if (source === undefined) throw new Error("fixture has a source");
    const withEnv = { ...config, sources: [{ ...source, databaseEnv: "DATABASE_URL" }] };
    const parsed = parseProjectConfig(withEnv);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const json = toProjectJson(parsed.config);
    expect(toProjectJson(fromProjectJson(json, env()))).toEqual(json);

    const dir = await scratchDir();
    await mkdir(join(dir, "node_modules"));
    await symlink(packageDir, join(dir, "node_modules", "facetdb"));
    await writeFile(join(dir, "facetdb.config.ts"), configFileSource(parsed.config));
    const { config: reloaded } = await load(dir);
    expect(toProjectJson(reloaded)).toEqual(json);
  });

  it("refuses to export a connection string it cannot name a variable for", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        { name: "orders", database: CONNECTION, table: "orders", read: ["a"], questions: {} },
      ],
    });
    expect(() => toProjectJson(config)).toThrow(/never carry the string/);
  });
});

describe("what the schema refuses", () => {
  it("refuses an alias and names the pinned form", () => {
    const messages = messagesOf(() =>
      fromProjectJson({ ...toProjectJson(facetdb(valid())), model: "jev-latest" }),
    );
    expect(messages).toEqual([
      "model: model must be an exact version such as jev-1.14.0; jev-latest moves when TypeSafe ships a release",
    ]);
  });

  it("refuses an alias on a source too, at the source", () => {
    const aliased = parseProjectConfig(facetdb(valid({ model: "jev-preview" })));
    expect(aliased).toMatchObject({ ok: false });
    if (!aliased.ok) {
      expect(aliased.issues.map((issue) => issue.path)).toEqual(["sources[0].model"]);
      expect(aliased.issues[0]?.message).toContain("jev-1.14.0");
    }
  });

  it("refuses a model that is missing", () => {
    const { model: _model, ...config } = facetdb(valid());
    const result = parseProjectConfig(config);
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "model",
          message: 'model is required: pin an exact version such as model: "jev-1.14.0"',
        },
      ],
    });
  });

  it("refuses a table that is two sources", async () => {
    const dir = await scratchDir();
    const source = (name: string) => ({
      name,
      api: false,
      database: CONNECTION,
      table: "orders",
      read: ["note"],
      storage: "inline",
      onChange: "reset",
      onOutage: "hold",
      questions: [{ type: "noul", name: "rush", instructions: "Rush?", stakes: "low" }],
      thresholds: {},
      actions: [],
    });
    await writeFile(
      join(dir, "facetdb.config.ts"),
      `export default ${JSON.stringify({ model: "jev-1.14.0", onCapReached: "pause", sources: [source("first"), source("second")] })};\n`,
    );
    const error = await load(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      {
        path: "sources[1].table",
        message:
          'the table "orders" is already the source "first"; one table is exactly one source, so put its questions in that source',
      },
    ]);
  });

  it("refuses a credential written into an action, so the JSON export never carries one", () => {
    const leaky = facetdb(
      valid({
        actions: [
          actionCall("@facetdb/slack", "notify", {
            channel: "#ops",
            webhookToken: "xoxb-123",
            nested: { apiKey: "sk-live" },
          }),
        ],
      }),
    );
    const result = parseProjectConfig(leaky);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "sources[0].actions[0].config.webhookToken",
        "sources[0].actions[0].config.nested.apiKey",
      ]);
      expect(result.issues[0]?.message).toContain("environment variable");
    }
    // The import door judges the same way.
    const imported = messagesOf(() =>
      fromProjectJson({
        ...toProjectJson(facetdb(valid())),
        sources: [
          {
            ...toProjectJson(facetdb(valid())).sources[0],
            actions: [
              { plugin: "@facetdb/slack", action: "notify", config: { password: "hunter2" } },
            ],
          },
        ],
      }),
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]).toContain("actions[0].config.password");
  });

  it("refuses a literal under a key ending in Env: the key names a variable, never holds the value", () => {
    const leaky = facetdb(
      valid({
        actions: [
          actionCall("@facetdb/slack", "notify", {
            tokenEnv: "xoxb-literal",
            nested: { apiKeyEnv: 42 },
          }),
        ],
      }),
    );
    const result = parseProjectConfig(leaky);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "sources[0].actions[0].config.tokenEnv",
        "sources[0].actions[0].config.nested.apiKeyEnv",
      ]);
      expect(result.issues[0]?.message).toContain("must name an environment variable");
    }
  });

  it("refuses a URL with a username or password in it, in modelUrl and in any action argument", () => {
    const leakyModel = parseProjectConfig(
      facetdb({ ...valid(), modelUrl: "https://ops:hunter2@models.internal" }),
    );
    expect(leakyModel.ok).toBe(false);
    if (!leakyModel.ok) {
      expect(leakyModel.issues.map((issue) => issue.path)).toEqual(["modelUrl"]);
      expect(leakyModel.issues[0]?.message).toContain("username or password");
    }

    const leakyAction = parseProjectConfig(
      facetdb(
        valid({
          actions: [
            actionCall("@facetdb/slack", "notify", {
              webhookUrl: "https://ops:hunter2@hooks.example.com/a",
              plain: "https://hooks.example.com/a",
            }),
          ],
        }),
      ),
    );
    expect(leakyAction.ok).toBe(false);
    if (!leakyAction.ok) {
      expect(leakyAction.issues.map((issue) => issue.path)).toEqual([
        "sources[0].actions[0].config.webhookUrl",
      ]);
    }
  });

  it("refuses a known incoming-webhook URL, which is a secret by itself, anywhere: an action argument, an array item, an alert channel", () => {
    const inAction = parseProjectConfig(
      facetdb(
        valid({
          actions: [
            actionCall("@facetdb/slack", "notify", {
              url: "https://hooks.slack.com/services/T000/B000/XXXX",
              targets: ["https://example.com/ok", "https://ops:hunter2@example.com/x"],
            }),
          ],
        }),
      ),
    );
    expect(inAction.ok).toBe(false);
    if (!inAction.ok) {
      expect(inAction.issues.map((issue) => issue.path)).toEqual([
        "sources[0].actions[0].config.url",
        "sources[0].actions[0].config.targets[1]",
      ]);
      expect(inAction.issues[0]?.message).toContain("incoming-webhook URL");
    }

    const inAlerts = parseProjectConfig(
      facetdb({
        ...valid(),
        alerts: { channels: ["slack:https://discord.com/api/webhooks/1/abc"] },
      }),
    );
    expect(inAlerts.ok).toBe(false);
    if (!inAlerts.ok) {
      expect(inAlerts.issues[0]?.path).toBe("alerts.channels[0]");
      expect(inAlerts.issues[0]?.message).toContain("never a webhook URL");
    }
  });

  it("refuses auth, credential and bearer keys as secrets, but not author", () => {
    const leaky = parseProjectConfig(
      facetdb(
        valid({
          actions: [
            actionCall("@facetdb/slack", "notify", {
              auth: "xoxb-123",
              basicAuth: "u:p",
              credentials: { user: "x" },
              author: "ada",
            }),
          ],
        }),
      ),
    );
    expect(leaky.ok).toBe(false);
    if (!leaky.ok) {
      expect(leaky.issues.map((issue) => issue.path)).toEqual([
        "sources[0].actions[0].config.auth",
        "sources[0].actions[0].config.basicAuth",
        "sources[0].actions[0].config.credentials",
      ]);
    }
  });

  it("judges a source's where and table by shape too, since they are exported", () => {
    const table = {
      api: false,
      database: "postgres://localhost/tickets",
      databaseEnv: "DATABASE_URL",
      table: "tickets",
    } as const;
    const leaky = parseProjectConfig(
      facetdb(valid({ ...table, where: "url = 'https://hooks.slack.com/services/T/B/X'" })),
    );
    // A URL inside a longer expression is not a URL value: it passes.
    expect(leaky.ok ? [] : leaky.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual(
      [],
    );
    const bare = parseProjectConfig(
      facetdb(valid({ ...table, where: "https://ops:hunter2@example.com/filter" })),
    );
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.issues[0]?.path).toBe("sources[0].where");
    }
  });

  it("accepts an action that names the environment variable holding its secret", () => {
    const config = facetdb(
      valid({
        actions: [actionCall("@facetdb/slack", "notify", { tokenEnv: "SLACK_TOKEN" })],
      }),
    );
    const result = parseProjectConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(toProjectJson(result.config))).toContain("SLACK_TOKEN");
    }
  });

  it("refuses two sources with one name", () => {
    const config = facetdb(valid());
    const twice = { ...config, sources: [config.sources[0], config.sources[0]] };
    const result = parseProjectConfig(twice);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(["sources[1].name"]);
    }
  });

  it("names the path of an invalid level count", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "tickets",
          api: true,
          read: ["body"],
          questions: {
            ok: noul("Fine?"),
            urgency: score("How urgent?", ["only"]),
          },
        },
      ],
    });
    const result = parseProjectConfig(config);
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "sources[0].questions.urgency.levels",
          message: "a score question needs at least 2 levels",
        },
      ],
    });
  });

  it("names the path of a threshold on a question that does not exist", () => {
    const result = parseProjectConfig(
      facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "tickets",
            api: true,
            read: ["body"],
            questions: { urgency: score("How urgent?", ["low", "high"]) },
            thresholds: { urgancy: { confidenceAtLeast: 0.5 } },
          },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("sources[0].thresholds.urgancy");
    }
  });

  it("refuses a secret written into the file and says where it belongs", () => {
    const result = parseProjectConfig({ ...facetdb(valid()), apiKey: "sk-123" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues[0]?.message).toContain("TYPESAFE_API_KEY");
    }
  });

  it("refuses an action condition that names no question", () => {
    const result = parseProjectConfig(
      facetdb(
        valid({
          actions: [actionCall("@facetdb/slack", "notify", { when: { urgancy: "high" } })],
        }),
      ),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("sources[0].actions[0].when.urgancy");
    }
  });

  it("refuses an API source with a table and a database source without one", () => {
    const apiWithTable = parseProjectConfig(facetdb(valid({ table: "tickets" })));
    expect(apiWithTable).toMatchObject({ ok: false });
    const noTable = parseProjectConfig(facetdb(valid({ api: false, database: CONNECTION })));
    expect(noTable).toMatchObject({ ok: false });
    if (!noTable.ok) {
      expect(noTable.issues[0]?.path).toBe("sources[0].table");
    }
  });

  it("refuses a connection string in the project JSON", () => {
    const json = toProjectJson(facetdb(valid()));
    const messages = messagesOf(() =>
      fromProjectJson({
        ...json,
        sources: [{ ...json.sources[0], api: false, table: "t", database: CONNECTION }],
      }),
    );
    expect(messages[0]).toContain("sources[0].database");
    expect(messages.join("\n")).not.toContain("s3cret");
  });
});

describe("the loader", () => {
  it("refuses a config outside the project directory before evaluating it", async () => {
    const dir = await scratchDir();
    const outside = await load(dir, join(fixtures, "facetdb.config.ts")).catch(
      (caught: unknown) => caught,
    );
    expect(outside).toBeInstanceOf(ConfigError);
    expect((outside as ConfigError).message).toContain("outside the project directory");

    const parent = await load(fixtures, "../facetdb.config.ts").catch((caught: unknown) => caught);
    expect(parent).toBeInstanceOf(ConfigError);
  });

  it("refuses a link inside the project that leads outside it", async () => {
    const dir = await scratchDir();
    await symlink(join(fixtures, "facetdb.config.ts"), join(dir, "facetdb.config.ts"));
    const error = await load(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("outside the project directory");
  });

  it("says what to do when the file is missing", async () => {
    const dir = await scratchDir();
    const error = await load(dir).catch((caught: unknown) => caught);
    expect((error as ConfigError).message).toContain("facetdb init");
  });

  it("refuses a connection string typed into the file", async () => {
    const dir = await scratchDir();
    delete process.env["DATABASE_URL"];
    const config = toProjectJson(facetdb(valid()));
    await writeFile(
      join(dir, "facetdb.config.ts"),
      `export default ${JSON.stringify({
        ...config,
        sources: [
          {
            ...config.sources[0],
            api: false,
            table: "tickets",
            database: "postgres://me:hunter2@localhost/db",
            questions: [{ type: "noul", name: "rush", instructions: "Rush?", stakes: "low" }],
          },
        ],
      })};\n`,
    );
    const error = await load(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues[0]?.path).toBe("sources[0].database");
    expect((error as ConfigError).message).not.toContain("hunter2");
  });

  it("says the variable is not set when the environment reference is empty", async () => {
    delete process.env["DATABASE_URL"];
    const error = await load(fixtures).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues[0]).toMatchObject({ path: "sources[0].database" });
    expect((error as ConfigError).message).toContain("DATABASE_URL");
  });
});
