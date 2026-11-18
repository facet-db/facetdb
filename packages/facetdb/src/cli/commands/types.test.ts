import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type QuestionSet,
  REVIEWED_COLUMN,
  STATE_HASH_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { CliError, runInProcess } from "../program.ts";
import { pollingInstallSql } from "../testing.ts";
import {
  ENGINE_NAMES,
  ENGINE_URLS,
  type EngineName,
  onEngine,
  onEveryEngine,
} from "./fixtures/engines.ts";
import { supportMessages } from "./fixtures/support-messages.ts";
import { COMMANDS } from "./index.ts";
import {
  renderDeclaration,
  renderDrizzle,
  renderPrisma,
  runTypes,
  type TypesDeps,
  type TypesOptions,
} from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Promise<string> => readFile(join(here, "fixtures", name), "utf8");

const SOURCE_NAME = "support_messages";

function sourceNamed(name: string) {
  const source = supportMessages.sources.find((candidate) => candidate.name === name);
  if (source === undefined) {
    throw new Error(`the fixture has no source ${name}`);
  }
  return source;
}

/** The question set the install sees for a source: the same inputs the polling install reads. */
function installQuestionSet(name: string): QuestionSet {
  const source = sourceNamed(name);
  return {
    questions: source.questions,
    read: source.read,
    model: supportMessages.model,
    thresholds: source.thresholds,
  };
}

/** The columns the install SQL adds for a source, read from its `add column` statements. */
function installedColumns(name: string): string[] {
  const source = sourceNamed(name);
  const sql = pollingInstallSql(
    { table: source.table ?? source.name, key: "id" },
    installQuestionSet(name),
  ).join("\n");
  return [...sql.matchAll(/add column if not exists "([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** The property names of the declared `<Table>Answers` type, read from the declaration's AST. */
function declaredKeys(declaration: string, typeName: string): string[] {
  const file = ts.createSourceFile("facetdb.types.d.ts", declaration, ts.ScriptTarget.ES2024, true);
  const alias = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (alias === undefined || !ts.isTypeLiteralNode(alias.type)) {
    throw new Error(`the declaration has no object type ${typeName}`);
  }
  return alias.type.members
    .filter(ts.isPropertySignature)
    .map((member) => member.name.getText(file));
}

/** The errors TypeScript reports for one declaration file, compiled as a strict standalone file. */
function typecheck(declaration: string): string[] {
  const fileName = "/virtual/facetdb.types.d.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const fromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, declaration, languageVersion, true)
      : fromDisk(name, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFileFromDisk = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? declaration : readFileFromDisk(name));
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** One Prisma model's block, from its `model` line to the closing brace on its own line. */
function modelBlock(snippet: string, name: string): string {
  const block = snippet.match(new RegExp(`^model ${name} \\{\\n[\\s\\S]*?^\\}$`, "m"));
  if (block === null) {
    throw new Error(`the Prisma snippet has no model ${name}`);
  }
  return block[0];
}

/** The column names a snippet maps, read from Prisma's @map attributes. */
function prismaColumns(snippet: string): string[] {
  return [...snippet.matchAll(/(?<!@)@map\("([a-z0-9_]+)"\)/g)].map((match) => match[1] ?? "");
}

/** The column names a snippet declares, read from the Drizzle field lines. */
function drizzleColumns(snippet: string): string[] {
  return [...snippet.matchAll(/^ {2}\w+: \w+\("([a-z0-9_]+)"/gm)].map((match) => match[1] ?? "");
}

describe("facetdb types: the support-messages example", () => {
  it("renders the committed declaration, Prisma and Drizzle snippets byte for byte", async () => {
    expect(renderDeclaration(supportMessages)).toBe(await fixture("support-messages.types.d.ts"));
    expect(renderPrisma(supportMessages)).toBe(await fixture("support-messages.prisma"));
    expect(renderDrizzle(supportMessages)).toBe(await fixture("support-messages.drizzle.txt"));
  });

  // Spawns tsc: a few seconds alone, more on a loaded machine (6.3 s seen at load 15, past vitest's
  // 5 s default).
  it("writes a declaration that typechecks under strict settings", () => {
    const declaration = renderDeclaration(supportMessages);
    expect(typecheck(declaration)).toEqual([]);
  }, 30_000);

  it("proves the typecheck can fail, so a clean result means something", () => {
    expect(typecheck("export type Broken = { team: NotAType };")).not.toEqual([]);
  });

  it("declares exactly the install SQL's answer and status columns for the table source", () => {
    const installed = installedColumns(SOURCE_NAME);
    const bookkeeping = [UPDATED_AT_COLUMN, REVIEWED_COLUMN, STATE_HASH_COLUMN];
    expect(declaredKeys(renderDeclaration(supportMessages), "SupportMessagesAnswers")).toEqual(
      installed.filter((name) => !bookkeeping.includes(name)),
    );
  });

  it("maps the ORM snippets onto the install SQL's columns, except the state hash", () => {
    const installed = installedColumns(SOURCE_NAME).filter((name) => name !== STATE_HASH_COLUMN);
    expect(prismaColumns(renderPrisma(supportMessages))).toEqual(installed);
    expect(drizzleColumns(renderDrizzle(supportMessages))).toEqual(installed);
  });

  it("models a side-table source's answers as their own snippet, and leaves the key to the user", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "support_messages",
          table: "support_messages",
          storage: "side-table",
          read: ["subject"],
          questions: { wants_refund: noul("Is it?") },
        },
        {
          name: "orders",
          table: "orders",
          read: ["status"],
          questions: { late: noul("Is it late?") },
        },
      ],
    });
    const answerColumns = [
      "wants_refund",
      "wants_refund_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ];
    const prisma = renderPrisma(config);
    expect(modelBlock(prisma, "Orders")).toContain("model Orders {");
    const prismaSide = modelBlock(prisma, "SupportMessagesAnswers");
    expect(prismaSide).toMatch(/^ {2}@@schema\("facetdb"\)$/m);
    expect(prismaSide).toMatch(/^ {2}@@map\("support_messages_answers"\)$/m);
    expect(prismaColumns(prismaSide)).toEqual(answerColumns);
    const drizzle = renderDrizzle(config);
    expect(drizzle).toContain("export const supportMessagesAnswersFacetdb");
    expect(drizzle).toContain('facetdbSchema.table("support_messages_answers"');
    expect(drizzle).toContain("export const ordersFacetdb");
    const drizzleSide = drizzle.slice(
      drizzle.indexOf("export const supportMessagesAnswersFacetdb"),
      drizzle.indexOf("export const ordersFacetdb"),
    );
    expect(drizzleColumns(drizzleSide)).toEqual(answerColumns);
    expect(drizzleColumns(drizzle.slice(drizzle.indexOf("export const ordersFacetdb")))).toEqual([
      "late",
      "late_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
  });

  it("gives different column names different ORM fields, even when camelCase would merge them", () => {
    const names = ["a_1", "a1", "a_b", "a__b", "a_"];
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "edge",
          table: "edge",
          read: ["x"],
          questions: Object.fromEntries(names.map((name) => [name, noul("Is it?")])),
        },
      ],
    });
    const prismaFields = [...renderPrisma(config).matchAll(/^ {2}(\S+) /gm)].map((m) => m[1]);
    const drizzleFields = [...renderDrizzle(config).matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    expect(new Set(prismaFields).size).toBe(prismaFields.length);
    expect(new Set(drizzleFields).size).toBe(drizzleFields.length);
    expect(prismaFields).toContain("a_1");
    expect(prismaFields).toContain("a1");
    expect(prismaFields).toContain("a_B");
    expect(prismaFields).toContain("aB");
  });

  it("writes the choice and score unions from the option and level names", () => {
    const declaration = renderDeclaration(supportMessages);
    expect(declaration).toContain('team: "billing" | "shipping" | "returns" | null;');
    expect(declaration).toContain('urgency: "low" | "medium" | "high" | null;');
  });

  it("spells no answer-column suffix in the command: they come from core's helper", async () => {
    const source = await readFile(join(here, "types.ts"), "utf8");
    for (const suffix of ["_probability", "_confidence", "_expected", "_probabilities"]) {
      expect(source).not.toContain(suffix);
    }
  });
});

describe("facetdb types: edge cases", () => {
  it("quotes a choice option that is not a plain identifier", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "tickets",
          table: "tickets",
          read: ["subject"],
          questions: {
            channel: {
              type: "choice",
              instructions: "Where did it come from?",
              options: [
                { name: "e-mail", description: "Sent by email" },
                { name: "web form", description: "Sent through the site" },
              ],
              stakes: "low",
              storeProbabilities: true,
            },
          },
        },
      ],
    });
    const declaration = renderDeclaration(config);
    expect(declaration).toContain('channel: "e-mail" | "web form" | null;');
    expect(declaration).toContain(
      'channel_probabilities: { "e-mail": number; "web form": number } | null;',
    );
    expect(typecheck(declaration)).toEqual([]);
  });

  it("refuses two sources whose tables give the same type name", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        { name: "a", table: "support_messages", read: ["x"], questions: { ok: noul("Is it ok?") } },
        { name: "b", table: "support-messages", read: ["x"], questions: { ok: noul("Is it ok?") } },
      ],
    });
    expect(() => renderDeclaration(config)).toThrow(/both become the type SupportMessagesAnswers/);
  });

  it("refuses a source whose two questions write the same column, in every snippet", () => {
    // `a` (noul) adds `a_probability`; the question `a_probability` adds a column of that name too.
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "tickets",
          table: "tickets",
          read: ["subject"],
          questions: { a: noul("Is it a?"), a_probability: noul("Is it a probability?") },
        },
      ],
    });
    const collision = /two columns named "a_probability"/;
    expect(() => renderDeclaration(config)).toThrow(collision);
    expect(() => renderPrisma(config)).toThrow(collision);
    expect(() => renderDrizzle(config)).toThrow(collision);
  });
});

describe("facetdb types: each source as its engine keeps it", () => {
  /** The committed declaration, Prisma and Drizzle fixtures of one engine's source. */
  const engineFixtures = (engine: EngineName) =>
    Promise.all([
      fixture(`engines/${engine}.declaration.txt`),
      fixture(`engines/${engine}.prisma`),
      fixture(`engines/${engine}.drizzle.txt`),
    ]);

  /** What a raw driver read of a yes-or-no answer returns, per engine. */
  const BOOLEAN_READ: Readonly<Record<EngineName, string>> = {
    postgres: "boolean",
    cockroachdb: "boolean",
    mysql: "0 | 1",
    mariadb: "0 | 1",
    mssql: "boolean",
    sqlite: "0 | 1",
    libsql: "0 | 1",
    mongodb: "boolean",
    oracle: "0 | 1",
  };

  /** The column names every SQL engine's snippets map, read from the Postgres source's. */
  const sqlColumns = () => prismaColumns(renderPrisma(onEngine("postgres")));

  for (const engine of ENGINE_NAMES) {
    it(`renders the ${engine} source's declaration, Prisma and Drizzle snippets byte for byte`, async () => {
      const config = onEngine(engine);
      const [declaration, prisma, drizzle] = await engineFixtures(engine);
      expect(renderDeclaration(config)).toBe(declaration);
      expect(renderPrisma(config)).toBe(prisma);
      expect(renderDrizzle(config)).toBe(drizzle);
    });
  }

  it("keeps the Postgres output byte for byte when the source names a postgres:// string", async () => {
    const onPostgres = {
      ...supportMessages,
      sources: supportMessages.sources.map((source) =>
        source.table === undefined ? source : { ...source, database: ENGINE_URLS.postgres },
      ),
    };
    expect(renderDeclaration(onPostgres)).toBe(await fixture("support-messages.types.d.ts"));
    expect(renderPrisma(onPostgres)).toBe(await fixture("support-messages.prisma"));
    expect(renderDrizzle(onPostgres)).toBe(await fixture("support-messages.drizzle.txt"));
  });

  it("imports MySQL's and MariaDB's builders from mysql-core, SQLite's and libSQL's from sqlite-core", () => {
    const cores: readonly (readonly [EngineName, string])[] = [
      ["postgres", "pg-core"],
      ["cockroachdb", "pg-core"],
      ["mysql", "mysql-core"],
      ["mariadb", "mysql-core"],
      ["sqlite", "sqlite-core"],
      ["libsql", "sqlite-core"],
    ];
    for (const [engine, core] of cores) {
      const imports = [...renderDrizzle(onEngine(engine)).matchAll(/ from "([^"]+)";$/gm)];
      expect(imports.map((match) => match[1])).toEqual([`drizzle-orm/${core}`]);
    }
  });

  it("imports nothing from Drizzle for SQL Server, Oracle and MongoDB, and says why in one comment", () => {
    const names: Readonly<Record<string, string>> = {
      mssql: "SQL Server",
      oracle: "Oracle",
      mongodb: "MongoDB",
    };
    for (const engine of ["mssql", "oracle", "mongodb"] as const) {
      const drizzle = renderDrizzle(onEngine(engine));
      expect(drizzle).not.toContain("drizzle-orm");
      expect(drizzle).not.toMatch(/^(import|export) /m);
      const lines = drizzle.split("\n").filter((line) => line !== "");
      expect(lines.slice(1)).toEqual([
        expect.stringMatching(
          new RegExp(
            `^// Drizzle has no driver for ${names[engine]}, so the source "support_messages"`,
          ),
        ),
      ]);
    }
  });

  it("writes no Prisma model for Oracle, and says why in one comment", () => {
    const prisma = renderPrisma(onEngine("oracle"));
    expect(prisma).not.toMatch(/^(model|type|datasource) /m);
    expect(prisma.split("\n").filter((line) => line.startsWith("// Prisma has no"))).toEqual([
      expect.stringContaining(
        'Prisma has no provider for Oracle, so the source "support_messages"',
      ),
    ]);
  });

  it("names each engine's Prisma provider above its models", () => {
    const providers: readonly (readonly [EngineName, string])[] = [
      ["cockroachdb", "cockroachdb"],
      ["mysql", "mysql"],
      ["mariadb", "mysql"],
      ["mssql", "sqlserver"],
      ["sqlite", "sqlite"],
      ["libsql", "sqlite"],
      ["mongodb", "mongodb"],
    ];
    for (const [engine, provider] of providers) {
      expect(renderPrisma(onEngine(engine))).toContain(
        `// For a Prisma schema whose datasource has provider = "${provider}"`,
      );
    }
  });

  it("types a yes-or-no answer as each engine's driver returns it: 1 or 0 on Oracle, MySQL and SQLite", () => {
    for (const engine of ENGINE_NAMES) {
      const optional = engine === "mongodb" ? "?" : "";
      expect(renderDeclaration(onEngine(engine))).toContain(
        `  wants_refund${optional}: ${BOOLEAN_READ[engine]} | null;\n`,
      );
    }
  });

  it("maps every SQL engine's snippets onto the same columns", () => {
    for (const engine of ENGINE_NAMES) {
      const config = onEngine(engine);
      if (!["mongodb", "oracle"].includes(engine)) {
        expect(prismaColumns(renderPrisma(config))).toEqual(sqlColumns());
      }
      if (!["mongodb", "oracle", "mssql"].includes(engine)) {
        expect(drizzleColumns(renderDrizzle(config))).toEqual(sqlColumns());
      }
    }
  });

  it("writes a MongoDB source as its facetdb subdocument's fields, which drop the facetdb_ prefix", () => {
    const config = onEngine("mongodb");
    const onPostgres = declaredKeys(
      renderDeclaration(onEngine("postgres")),
      "SupportMessagesAnswers",
    );
    expect(declaredKeys(renderDeclaration(config), "SupportMessagesAnswers")).toEqual(
      onPostgres.map((name) => (name === "facetdb_status" ? "status" : name)),
    );
    const prisma = renderPrisma(config);
    expect(prisma).not.toMatch(/^model /m);
    expect(prisma).toMatch(/^type SupportMessagesFacetdb \{$/m);
    expect(prismaColumns(prisma).slice(-3)).toEqual(["status", "updated_at", "reviewed"]);
  });

  it("types the status of every polled table as nullable: CockroachDB, Oracle, and Postgres under connector: polling", () => {
    const postgres = onEngine("postgres");
    const polled = {
      ...postgres,
      sources: postgres.sources.map((source) => ({ ...source, connector: "polling" as const })),
    };
    for (const config of [onEngine("cockroachdb"), onEngine("oracle"), polled]) {
      const declaration = renderDeclaration(config);
      expect(declaration).toMatch(/^ {2}facetdb_status: .* \| "skipped" \| null;$/m);
      expect(declaration).toMatch(
        /^\/\/ facetdb_status is nullable on .*: a row the poller has not reached yet reads null, which means pending\.$/m,
      );
    }
    expect(renderDeclaration(polled)).toContain("on Postgres, watched by polling:");
    // Reviewed is nullable with a false default on a polled table.
    for (const config of [onEngine("cockroachdb"), polled]) {
      expect(renderPrisma(config)).toContain(
        '  facetdbReviewed Boolean? @default(false) @map("facetdb_reviewed")',
      );
      expect(renderDrizzle(config)).toContain('boolean("facetdb_reviewed").default(false)');
    }
  });

  it("refuses connector: polling on MongoDB, as the engines do", () => {
    const mongodb = onEngine("mongodb");
    const polled = {
      ...mongodb,
      sources: mongodb.sources.map((source) => ({ ...source, connector: "polling" as const })),
    };
    expect(() => renderDeclaration(polled)).toThrow(
      /connector: "polling" scans the rows of a SQL table/,
    );
  });

  it("tells an Oracle application how its clob probabilities come back as text", () => {
    expect(renderDeclaration(onEngine("oracle"))).toContain(
      "oracledb.fetchAsString = [oracledb.CLOB]",
    );
  });

  it("refuses a connection string whose scheme names no database FacetDB connects to", () => {
    const config = onEngine("postgres");
    const [source] = config.sources;
    if (source === undefined) {
      throw new Error("the fixture has no source");
    }
    const unknown = { ...config, sources: [{ ...source, database: "redis://cache:6379" }] };
    for (const render of [renderDeclaration, renderPrisma, renderDrizzle]) {
      expect(() => render(unknown)).toThrow(CliError);
      expect(() => render(unknown)).toThrow(/names no database FacetDB connects to/);
    }
  });

  it("refuses a source whose connection string's variable is not set, naming the variable", () => {
    const config = onEngine("oracle");
    const [source] = config.sources;
    if (source === undefined) {
      throw new Error("the fixture has no source");
    }
    const { database: _unset, ...rest } = source;
    const unset = { ...config, sources: [{ ...rest, databaseEnv: "LISTINGS_URL" }] };
    try {
      renderDeclaration(unset);
      expect.unreachable("an unset connection string is refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).fix).toContain("set LISTINGS_URL");
    }
  });

  it("groups a project on every engine by Drizzle core and by Prisma provider", () => {
    const config = onEveryEngine();
    const drizzle = renderDrizzle(config);
    expect(
      [...drizzle.matchAll(/^import .* from "drizzle-orm\/([a-z-]+)";$/gm)].map((m) => m[1]),
    ).toEqual(["pg-core", "mysql-core", "sqlite-core"]);
    expect(drizzle).toContain("// The sources on Postgres, CockroachDB, for a schema file");
    expect(drizzle.match(/^\/\/ Drizzle has no driver for /gm)).toHaveLength(3);
    const prisma = renderPrisma(config);
    expect([...prisma.matchAll(/provider = "([a-z]+)"/g)].map((m) => m[1])).toEqual([
      "postgresql",
      "cockroachdb",
      "mysql",
      "sqlserver",
      "sqlite",
      "mongodb",
    ]);
    expect(prisma.match(/^\/\/ Prisma has no provider for /gm)).toHaveLength(1);
  });

  // Spawns tsc, as the Postgres declaration's check does.
  it("writes a declaration for a project on every engine that typechecks under strict settings", () => {
    expect(typecheck(renderDeclaration(onEveryEngine()))).toEqual([]);
  }, 30_000);

  it("keeps a MySQL side table beside the table, under the facetdb_ prefix, in no facetdb schema", () => {
    const config = onEngine("mysql");
    const sideTable = {
      ...config,
      sources: config.sources.map((source) => ({ ...source, storage: "side-table" as const })),
    };
    const prisma = renderPrisma(sideTable);
    const model = modelBlock(prisma, "SupportMessagesAnswers");
    expect(model).toMatch(/^ {2}@@map\("facetdb_support_messages_answers"\)$/m);
    expect(model).not.toContain("@@schema");
    const drizzle = renderDrizzle(sideTable);
    expect(drizzle).toContain('mysqlTable("facetdb_support_messages_answers", { ... })');
    expect(drizzle).not.toContain("facetdbSchema");
  });
});

describe("facetdb types: the command", () => {
  function fakeDeps(): { deps: TypesDeps; written: [string, string][]; printed: string[] } {
    const written: [string, string][] = [];
    const printed: string[] = [];
    return {
      written,
      printed,
      deps: {
        writeFile: async (path, text) => {
          written.push([path, text]);
        },
        print: (text) => {
          printed.push(text);
        },
      },
    };
  }

  const options = (overrides: Partial<TypesOptions> = {}): TypesOptions => ({
    out: "facetdb.types.d.ts",
    prisma: false,
    drizzle: false,
    dryRun: false,
    ...overrides,
  });

  it("writes the declaration to --out and prints only what it reports", async () => {
    const { deps, written, printed } = fakeDeps();
    await runTypes(supportMessages, options({ out: "types/facetdb.types.d.ts" }), deps);
    expect(written).toEqual([["types/facetdb.types.d.ts", renderDeclaration(supportMessages)]]);
    expect(printed).toEqual(["wrote types/facetdb.types.d.ts"]);
  });

  it("with --dry-run prints the declaration and writes nothing", async () => {
    const { deps, written, printed } = fakeDeps();
    await runTypes(supportMessages, options({ dryRun: true }), deps);
    expect(written).toEqual([]);
    expect(printed).toEqual([renderDeclaration(supportMessages)]);
  });

  it("prints the Prisma and Drizzle snippets only when asked for them", async () => {
    const { deps, written, printed } = fakeDeps();
    await runTypes(supportMessages, options({ dryRun: true, prisma: true, drizzle: true }), deps);
    expect(written).toEqual([]);
    expect(printed).toEqual([
      renderDeclaration(supportMessages),
      renderPrisma(supportMessages),
      renderDrizzle(supportMessages),
    ]);
  });
});

describe("facetdb types: registered in the program", () => {
  /**
   * The program in this process with a MySQL project: the config is all it reads. No engine is
   * registered and every connection fails the run, so a command that reached a database would say so.
   */
  async function run(
    argv: readonly string[],
    config: ProjectConfig = onEngine("mysql"),
    setup: { readonly files?: Iterable<[string, string]>; readonly links?: readonly string[] } = {},
  ) {
    const files = new Map<string, string>(setup.files ?? []);
    const links = new Set(setup.links ?? []);
    const loaded: string[] = [];
    const result = await runInProcess(
      argv,
      {
        projectDir: "/work/support-app",
        env: {},
        loadConfig: (path) => {
          loaded.push(path);
          return Promise.resolve(config);
        },
        connect: () => {
          throw new Error("facetdb types connects to no database");
        },
        // The disk's rules (main.ts's diskWorkspace, proven in main.test.ts): peek never reads
        // through a link, and the parts replace a file only with `overwrite`.
        workspace: {
          exists: (path) => Promise.resolve(files.has(path) || links.has(path)),
          write: () => Promise.reject(new Error("facetdb types writes its file in parts")),
          writeParts: async (path, parts, { overwrite }) => {
            let text = "";
            for await (const part of parts) {
              text += part;
            }
            if (!overwrite && (files.has(path) || links.has(path))) {
              return "exists";
            }
            links.delete(path);
            files.set(path, text);
            return "written";
          },
          peek: (path) => {
            if (links.has(path)) {
              return Promise.resolve({ kind: "other" });
            }
            const text = files.get(path);
            return Promise.resolve(
              text === undefined
                ? { kind: "none" }
                : { kind: "file", firstLine: text.split("\n")[0] ?? "" },
            );
          },
          hasClaudeCommand: () => false,
        },
      },
      COMMANDS,
    );
    return { ...result, files, loaded };
  }

  it("writes the MySQL source's declaration and prints its mysql-core and Prisma snippets", async () => {
    const result = await run(["types", "--prisma", "--drizzle"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.loaded).toEqual(["facetdb.config.ts"]);
    expect([...result.files]).toEqual([
      ["facetdb.types.d.ts", await fixture("engines/mysql.declaration.txt")],
    ]);
    expect(result.stdout).toBe(
      `wrote facetdb.types.d.ts\n${await fixture("engines/mysql.prisma")}${await fixture("engines/mysql.drizzle.txt")}`,
    );
    expect(result.stdout).toContain('from "drizzle-orm/mysql-core";');
  });

  it("writes the declaration at the path --out names", async () => {
    const result = await run(["types", "--out", "types/facetdb.types.d.ts"]);
    expect(result.code, result.stderr).toBe(0);
    expect([...result.files.keys()]).toEqual(["types/facetdb.types.d.ts"]);
    expect(result.stdout).toBe("wrote types/facetdb.types.d.ts\n");
  });

  it("with --dry-run prints the declaration and writes nothing", async () => {
    const result = await run(["types", "--dry-run"], onEngine("oracle"));
    expect(result.code, result.stderr).toBe(0);
    expect(result.files.size).toBe(0);
    expect(result.stdout).toBe(await fixture("engines/oracle.declaration.txt"));
  });

  it("replaces the declaration an earlier run wrote", async () => {
    const earlier = renderDeclaration(onEngine("postgres"));
    const result = await run(["types"], onEngine("mysql"), {
      files: [["facetdb.types.d.ts", earlier]],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.files.get("facetdb.types.d.ts")).toBe(
      await fixture("engines/mysql.declaration.txt"),
    );
  });

  it("refuses to replace a hand-written declaration at --out, naming it, also on a dry run", async () => {
    const own = "declare global {\n  interface Window { app: string }\n}\nexport {};\n";
    for (const argv of [
      ["types", "--out", "global.d.ts"],
      ["types", "--out", "global.d.ts", "--dry-run"],
    ]) {
      const result = await run(argv, onEngine("mysql"), { files: [["global.d.ts", own]] });
      expect(result.code).toBe(1);
      expect(result.files.get("global.d.ts")).toBe(own);
      expect(result.stderr).toContain("global.d.ts exists and was not written by facetdb types");
      expect(result.stderr).toContain("move global.d.ts away");
    }
  });

  it("refuses a symbolic link at --out rather than write through it", async () => {
    const result = await run(["types"], onEngine("mysql"), { links: ["facetdb.types.d.ts"] });
    expect(result.code).toBe(1);
    expect(result.files.size).toBe(0);
    expect(result.stderr).toContain("facetdb.types.d.ts is a symbolic link or a directory");
  });

  it("refuses an --out that is not a .d.ts file, exit 2, writing nothing", async () => {
    const result = await run(["types", "--out", "src/schema.ts"]);
    expect(result.code).toBe(2);
    expect(result.files.size).toBe(0);
    expect(result.stderr).toContain("pass --out <name>.d.ts");
  });

  it("prints its result as JSON under --json", async () => {
    const result = await run(["types", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      out: "facetdb.types.d.ts",
      written: true,
      prisma: false,
      drizzle: false,
    });
  });
});
