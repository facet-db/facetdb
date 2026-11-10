import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type QuestionSet, REVIEWED_COLUMN, UPDATED_AT_COLUMN } from "@facetdb/core";
import { pollingInstallSql, STATE_HASH_COLUMN } from "@facetdb/postgres";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { facetdb, noul } from "../../config/index.ts";
import { supportMessages } from "./fixtures/support-messages.ts";
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

  // Spawns tsc: a few seconds alone, more on a loaded machine (6.3 s seen at load 15 on
  // 2026-11-01, past vitest's 5 s default).
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
