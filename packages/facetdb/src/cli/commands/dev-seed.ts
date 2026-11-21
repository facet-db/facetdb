import type { EmbeddedParts } from "../embedded.ts";
import { CliError, EXIT_USAGE, type Workspace } from "../program.ts";

/**
 * `facetdb dev --seed <file>`: the statements of a SQL file (the listings example's seed.sql,
 * Postgres SQL that PGlite runs) run into the embedded database before the install, in one
 * transaction, so a statement that fails leaves nothing. The file is read through the workspace, as
 * every file a command reads is (never through a link), and split into statements here: a `;`
 * outside a string, a quoted name, a comment or a dollar-quoted body ends one. Comments are
 * dropped, so a file of comments alone seeds nothing and says so.
 */

/** A SQL file as dev runs it: its path as `--seed` named it and its statements, comments dropped. */
export type Seed = {
  readonly path: string;
  readonly statements: readonly string[];
};

/** The statements of a Postgres SQL script, in order, each without its trailing `;` and trimmed. */
export function sqlStatements(text: string): readonly string[] {
  const statements: string[] = [];
  let current = "";
  let at = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement !== "") {
      statements.push(statement);
    }
    current = "";
  };
  while (at < text.length) {
    const char = text[at] ?? "";
    const next = text[at + 1] ?? "";
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", at);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      // Postgres nests block comments: each `/*` wants its own `*/`.
      let depth = 0;
      do {
        if (text.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (text.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      } while (depth > 0 && at < text.length);
      current += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const end = quotedEnd(text, at, char);
      current += text.slice(at, end);
      at = end;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(at))?.[0];
      if (tag !== undefined) {
        const close = text.indexOf(tag, at + tag.length);
        const end = close === -1 ? text.length : close + tag.length;
        current += text.slice(at, end);
        at = end;
        continue;
      }
    }
    if (char === ";") {
      flush();
      at += 1;
      continue;
    }
    current += char;
    at += 1;
  }
  flush();
  return statements;
}

/** Where a string or quoted name that opens at `start` ends: past its closing quote (`''` stays inside). */
function quotedEnd(text: string, start: number, quote: string): number {
  // E'…' takes backslash escapes; a plain string doubles its quote instead. The `e` is the prefix
  // only on its own: `date'…'` and `like'…'` end in one and are plain strings.
  const escapes =
    quote === "'" && /(?:^|[^A-Za-z0-9_])[eE]$/.test(text.slice(Math.max(0, start - 2), start));
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (escapes && char === "\\") {
      at += 2;
      continue;
    }
    if (char === quote) {
      if (text[at + 1] === quote) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
  return text.length;
}

/** `create table` and `insert into`: the tables a statement fills, as `schema.table`, lowercased unless quoted. */
const FILLS_TABLE =
  /^(?:create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?|insert\s+into\s+)([^\s(]+)/i;

/** One part of a name as Postgres reads it: a quoted part as written, a bare one folded to lowercase. */
function namePart(part: string): string {
  return part.startsWith('"') && part.endsWith('"')
    ? part.slice(1, -1).replaceAll('""', '"')
    : part.toLowerCase();
}

/** The tables the statements create or insert into, each once, as their engine labels them (`public.listings`). */
export function seededTables(statements: readonly string[]): readonly string[] {
  const tables: string[] = [];
  for (const statement of statements) {
    const name = FILLS_TABLE.exec(statement)?.[1];
    if (name === undefined) {
      continue;
    }
    const parts = name.split(".").map(namePart);
    const label = parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
    if (!tables.includes(label)) {
      tables.push(label);
    }
  }
  return tables;
}

/** The file `--seed` names, read through the workspace and split; refused in words when it cannot be. */
export async function readSeed(workspace: Workspace, path: string): Promise<Seed> {
  const found = await workspace.peek(path);
  if (found.kind !== "file") {
    throw new CliError(
      "seed-file",
      found.kind === "none"
        ? `--seed names ${path}, and there is no such file`
        : `--seed names ${path}, which is a link or a directory, and the seed is read from a regular file`,
      "pass --seed with the path of a SQL file in the project (the listings example ships seed.sql and seed-quick.sql)",
      EXIT_USAGE,
    );
  }
  const lines: string[] = [];
  for await (const line of workspace.lines(path)) {
    lines.push(line);
  }
  const statements = sqlStatements(lines.join("\n"));
  if (statements.length === 0) {
    throw new CliError(
      "seed-empty",
      `${path} holds no SQL statement, so there is nothing to seed`,
      "pass --seed with a file of SQL statements, each ended by a semicolon",
      EXIT_USAGE,
    );
  }
  const control = statements.findIndex((statement) => TRANSACTION_CONTROL.test(statement));
  if (control !== -1) {
    throw new CliError(
      "seed-transaction",
      `statement ${control + 1} of ${path} (${headOf(statements[control] ?? "")}) is transaction control, and the seed runs inside one transaction of facetdb dev's own`,
      `take BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK, SAVEPOINT and their kin out of ${path}: all of it runs as one transaction, or nothing does`,
    );
  }
  return { path, statements };
}

/** A statement that opens, saves, ends or undoes a transaction: none may run inside dev's own. */
const TRANSACTION_CONTROL = /^(?:begin|start|commit|end|rollback|savepoint|release|abort)\b/i;

/** How many statements, in words: "1 statement", "2 statements". */
export function statementWords(count: number): string {
  return `${count} ${count === 1 ? "statement" : "statements"}`;
}

/** A statement's first words, on one line, as a failure names it. */
function headOf(statement: string): string {
  const line = statement.replaceAll(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/**
 * Runs the seed into the embedded database in one transaction: a statement that fails is named
 * with the database's words and nothing stays. Then says how many rows each seeded table holds.
 */
export async function runSeed(
  client: EmbeddedParts["client"],
  seed: Seed,
  print: (line: string) => void,
): Promise<readonly string[]> {
  await client.transaction(async (query) => {
    for (const [index, statement] of seed.statements.entries()) {
      try {
        await query(statement);
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        throw new CliError(
          "seed-failed",
          `statement ${index + 1} of ${seed.path} (${headOf(statement)}) failed: ${said}; the transaction was rolled back, so nothing was seeded`,
          `fix that statement in ${seed.path}, then run facetdb dev --seed ${seed.path} again, or pass --reset to start from an empty database`,
        );
      }
    }
  });
  const tables = seededTables(seed.statements);
  for (const table of tables) {
    const [schema = "public", ...rest] = table.split(".");
    const relation = `"${schema.replaceAll('"', '""')}"."${rest.join(".").replaceAll('"', '""')}"`;
    const rows = await client.query(`select count(*)::int as n from ${relation}`);
    const count = Number(rows[0]?.["n"] ?? 0);
    print(`${seed.path}: ${table} now holds ${count} ${count === 1 ? "row" : "rows"}.`);
  }
  return tables;
}
