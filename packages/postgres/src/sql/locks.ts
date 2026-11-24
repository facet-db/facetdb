import type { PlanLock, PlanStep } from "@facetdb/core";
import type { SqlClient, SqlQuery } from "./client.ts";
import { lockTimeoutStatement } from "./ddl.ts";
import { quoteIdent, quoteLiteral } from "./identifier.ts";

/**
 * What a script locks, read from the script itself. Every statement a plan holds is read here as
 * the text that runs, so the listing cannot drift from the SQL: a statement in a form this reader
 * does not know stops the listing (`UnreadStatementError`) instead of leaving it out, and the tests
 * read every script FacetDB writes. Each statement's lock is the one Postgres's documentation gives
 * its command, checked on a real server by engine/migrate-locks.db.test.ts, which compares the
 * listing with `pg_locks` after each step:
 *
 * | statement | lock on the table | rows it goes through |
 * |---|---|---|
 * | `lock table … in <mode> mode` | that mode | none |
 * | `create table [if not exists]`, `create view` | access exclusive on the new relation; share row exclusive on each table a foreign key references | none (new) |
 * | `create index` | share | every row |
 * | `alter table … add column [if not exists]` (even one that exists), `drop column`, `drop constraint`, `alter column … drop not null` | access exclusive | none (a constant default rewrites nothing) |
 * | `alter table … add constraint` (primary key, check) | access exclusive | every row (checked) |
 * | `alter table … add constraint … foreign key` | share row exclusive, on both tables | every row of the table altered |
 * | `create trigger` | share row exclusive | none |
 * | `drop trigger if exists`, `drop view if exists` | access exclusive, only when there is one to drop | none |
 * | `create policy`, `alter table … enable row level security` | access exclusive | none |
 * | `comment on` | share update exclusive (blocks neither reads nor writes) | none |
 * | `insert`, `update`, `delete` | row exclusive (blocks neither) | — |
 * | `grant`, `revoke`, `select`, `set`, functions, roles, schemas | no table lock | — |
 *
 * A `do` block is read statement by statement, its `execute format(…)` calls rebuilt from their
 * arguments (the transaction's settings read from the script's own `set_config` statements), and a
 * statement under an `if` takes its lock only when the script's own condition holds: the database
 * is asked that condition, read-only, as the plan is made (an index looked up, a column, a
 * constraint, a policy). Only what holds off the application's reads or writes is listed: share
 * and every mode above it.
 */

/** Postgres's table lock modes, weakest first. */
const MODES = [
  "access share",
  "row share",
  "row exclusive",
  "share update exclusive",
  "share",
  "share row exclusive",
  "exclusive",
  "access exclusive",
] as const;

export type LockMode = (typeof MODES)[number];

const rank = (mode: LockMode): number => MODES.indexOf(mode);

/** The weakest mode that holds off a write (it conflicts with row exclusive): share. */
const HOLDS_OFF_WRITES = rank("share");

function isMode(words: string): words is LockMode {
  return (MODES as readonly string[]).includes(words);
}

/** A relation as a statement names it; no schema for an unqualified name (a temp table). */
export type Relation = { readonly schema: string | undefined; readonly name: string };

/** One lock one statement takes, as read from its text. */
export type StatementLock = {
  readonly relation: Relation;
  readonly mode: LockMode;
  /** The statement goes through every row of it: an index built, a constraint checked, a rewrite. */
  readonly everyRow: boolean;
  /** The statement creates the relation. */
  readonly creates: boolean;
  /** The script's own conditions (SQL) under which the statement runs, all of them; none: always. */
  readonly when: readonly string[];
};

/** A statement this reader does not know: its locks cannot be listed, so none are. */
export class UnreadStatementError extends Error {
  constructor(statement: string, why: string) {
    const first = statement.trim().split("\n")[0] ?? "";
    super(`the lock list cannot read this statement (${why}): ${first}`);
    this.name = "UnreadStatementError";
  }
}

/**
 * A value a `format(…)` argument takes only at run time (a loop's row): never a known name. A
 * private-use character, written by its code so it shows in the source.
 */
const UNKNOWN = String.fromCodePoint(0xe000);

type TokenKind = "word" | "ident" | "string" | "dollar" | "number" | "param" | "punct";

type Token = {
  readonly kind: TokenKind;
  /** A word lower-cased, an identifier or a string unquoted, a dollar-quoted body as written. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

/** The quoted text from `open` to its closing `quote`, a doubled quote standing for one. */
function quoted(text: string, open: number, quote: string): { value: string; end: number } {
  let value = "";
  let at = open + 1;
  for (;;) {
    const close = text.indexOf(quote, at);
    if (close < 0) {
      throw new UnreadStatementError(text, `an unclosed ${quote}`);
    }
    value += text.slice(at, close);
    if (text[close + 1] === quote) {
      value += quote;
      at = close + 2;
      continue;
    }
    return { value, end: close + 1 };
  }
}

const TWO_CHARACTER = new Set(["::", ":=", "||", "<>", ">=", "<=", "!=", "=>"]);

/** SQL (and plpgsql) as tokens: comments and white space dropped, quotes resolved. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const char = text[at] ?? "";
    if (/\s/.test(char)) {
      at += 1;
    } else if (rest.startsWith("--")) {
      const newline = text.indexOf("\n", at);
      at = newline < 0 ? text.length : newline + 1;
    } else if (rest.startsWith("/*")) {
      const close = text.indexOf("*/", at + 2);
      if (close < 0) {
        throw new UnreadStatementError(text, "an unclosed comment");
      }
      at = close + 2;
    } else if (char === "'" || char === '"') {
      const { value, end } = quoted(text, at, char);
      tokens.push({ kind: char === "'" ? "string" : "ident", value, start: at, end });
      at = end;
    } else if (char === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)?.[0];
      const param = /^\$\d+/.exec(rest)?.[0];
      if (tag !== undefined) {
        const close = text.indexOf(tag, at + tag.length);
        if (close < 0) {
          throw new UnreadStatementError(text, `an unclosed ${tag} body`);
        }
        const end = close + tag.length;
        tokens.push({ kind: "dollar", value: text.slice(at + tag.length, close), start: at, end });
        at = end;
      } else if (param !== undefined) {
        tokens.push({ kind: "param", value: param, start: at, end: at + param.length });
        at += param.length;
      } else {
        throw new UnreadStatementError(text, "a lone $");
      }
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)?.[0];
      const number = /^\d+(?:\.\d+)?/.exec(rest)?.[0];
      const pair = rest.slice(0, 2);
      const [kind, length]: readonly [TokenKind, number] =
        word !== undefined
          ? ["word", word.length]
          : number !== undefined
            ? ["number", number.length]
            : TWO_CHARACTER.has(pair)
              ? ["punct", 2]
              : ["punct", 1];
      const raw = text.slice(at, at + length);
      tokens.push({
        kind,
        value: kind === "word" ? raw.toLowerCase() : raw,
        start: at,
        end: at + length,
      });
      at += length;
    }
  }
  return tokens;
}

/** The script's transaction settings, as its `set_config(key, value, true)` statements set them. */
type Settings = Map<string, string>;

/** A read through one statement's tokens. */
class Reader {
  at = 0;
  readonly tokens: readonly Token[];
  /** The text the tokens were read from: a condition is a slice of it. */
  readonly text: string;
  /** The whole statement, for the error's words. */
  readonly statement: string;

  constructor(tokens: readonly Token[], text: string, statement: string) {
    this.tokens = tokens;
    this.text = text;
    this.statement = statement;
  }

  get done(): boolean {
    return this.at >= this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  /** Whether the next tokens are these words, in order. */
  sees(...words: readonly string[]): boolean {
    return words.every((word, index) => {
      const token = this.peek(index);
      return token?.kind === "word" && token.value === word;
    });
  }

  /** Takes these words when they come next, and says whether they did. */
  take(...words: readonly string[]): boolean {
    if (!this.sees(...words)) {
      return false;
    }
    this.at += words.length;
    return true;
  }

  expect(...words: readonly string[]): void {
    if (!this.take(...words)) {
      throw this.unread(`expected ${words.join(" ")}`);
    }
  }

  next(): Token {
    const token = this.peek();
    if (token === undefined) {
      throw this.unread("it ends too early");
    }
    this.at += 1;
    return token;
  }

  /** A name: an identifier as quoted, or a bare word as Postgres folds it. */
  name(): string {
    const token = this.next();
    if (token.kind !== "ident" && token.kind !== "word") {
      throw this.unread(`expected a name, found ${token.value}`);
    }
    return token.value;
  }

  /** `schema.name` or a bare `name`. */
  relation(): Relation {
    const first = this.name();
    if (this.peek()?.value === ".") {
      this.at += 1;
      return { schema: first, name: this.name() };
    }
    return { schema: undefined, name: first };
  }

  /** The index of the next token at paren depth 0 that `matches`, from here; the end when none. */
  find(matches: (token: Token) => boolean): number {
    let depth = 0;
    for (let index = this.at; index < this.tokens.length; index += 1) {
      const token = this.tokens[index] as Token;
      if (depth === 0 && matches(token)) {
        return index;
      }
      if (token.value === "(" || token.value === "[") {
        depth += 1;
      } else if (token.value === ")" || token.value === "]") {
        depth -= 1;
      }
    }
    return this.tokens.length;
  }

  /** The source text of tokens `from` (inclusive) to `to` (exclusive). */
  slice(from: number, to: number): string {
    const first = this.tokens[from];
    const last = this.tokens[to - 1];
    return first === undefined || last === undefined ? "" : this.text.slice(first.start, last.end);
  }

  unread(why: string): UnreadStatementError {
    return new UnreadStatementError(this.statement, why);
  }
}

const isWord = (word: string) => (token: Token) => token.kind === "word" && token.value === word;

/** The relation's name as `to_regclass` reads it: each part quoted. */
function qualified(relation: Relation): string {
  return relation.schema === undefined
    ? quoteIdent(relation.name)
    : `${quoteIdent(relation.schema)}.${quoteIdent(relation.name)}`;
}

/** The relation as a literal for `to_regclass` in a condition. */
function regclass(relation: Relation): string {
  return quoteLiteral(qualified(relation));
}

type Context = {
  readonly settings: Settings;
  /** The conditions the statement runs under (an enclosing `if`). */
  readonly when: readonly string[];
  readonly statement: string;
};

function lock(
  context: Context,
  relation: Relation,
  mode: LockMode,
  more: { readonly everyRow?: boolean; readonly creates?: boolean; readonly when?: string } = {},
): StatementLock {
  // A lock the list would show must name a table it can find: never an unqualified name (a temp
  // table's, which no application shares) nor one a loop's row fills in at run time.
  if (
    holdsOff(mode) &&
    (relation.schema === undefined || `${relation.schema}.${relation.name}`.includes(UNKNOWN))
  ) {
    throw new UnreadStatementError(
      context.statement,
      `a lock on ${relation.name.replaceAll(UNKNOWN, "?")} that names no table the list can find`,
    );
  }
  return {
    relation,
    mode,
    everyRow: more.everyRow === true,
    creates: more.creates === true,
    when: more.when === undefined ? context.when : [...context.when, more.when],
  };
}

/** The `set_config('key', 'value', true)` calls of a `select`: the script's transaction settings. */
function readSettings(reader: Reader, settings: Settings): void {
  const { tokens } = reader;
  for (let index = 0; index < tokens.length; index += 1) {
    const [call, open, key, comma, value] = tokens.slice(index, index + 5);
    if (
      call?.kind === "word" &&
      call.value === "set_config" &&
      open?.value === "(" &&
      key?.kind === "string" &&
      comma?.value === "," &&
      value?.kind === "string"
    ) {
      settings.set(key.value, value.value);
    }
  }
}

/** `lock table a, b in <mode> mode`: that mode on each (access exclusive when none is named). */
function lockTable(reader: Reader, context: Context): StatementLock[] {
  reader.take("table");
  reader.take("only");
  const relations = [reader.relation()];
  while (reader.peek()?.value === ",") {
    reader.at += 1;
    relations.push(reader.relation());
  }
  let mode: LockMode = "access exclusive";
  if (reader.take("in")) {
    const until = reader.find(isWord("mode"));
    const words = reader.tokens
      .slice(reader.at, until)
      .map((token) => token.value)
      .join(" ");
    if (!isMode(words)) {
      throw reader.unread(`no lock mode ${words}`);
    }
    mode = words;
  }
  return relations.map((relation) => lock(context, relation, mode));
}

/** The tables a statement's `references` clauses name, from the reader's place on. */
function referenced(reader: Reader): Relation[] {
  const relations: Relation[] = [];
  const { tokens } = reader;
  for (let index = reader.at; index < tokens.length; index += 1) {
    if (isWord("references")(tokens[index] as Token)) {
      const inner = new Reader(tokens, reader.text, reader.statement);
      inner.at = index + 1;
      relations.push(inner.relation());
    }
  }
  return relations;
}

function create(reader: Reader, context: Context): StatementLock[] {
  reader.take("or", "replace");
  const temporary = reader.take("temporary") || reader.take("temp");
  if (reader.take("unique")) {
    reader.expect("index");
    return createIndex(reader, context);
  }
  if (reader.take("index")) {
    return createIndex(reader, context);
  }
  if (reader.take("schema") || reader.take("role") || reader.take("function")) {
    return [];
  }
  if (reader.take("table")) {
    const ifAbsent = reader.take("if", "not", "exists");
    const table = reader.relation();
    if (temporary) {
      return [];
    }
    // `if not exists` on a table that is there locks nothing, its foreign keys included.
    const when = ifAbsent ? `to_regclass(${regclass(table)}) is null` : undefined;
    const also = when === undefined ? {} : { when };
    return [
      lock(context, table, "access exclusive", { creates: true, ...also }),
      ...referenced(reader).map((other) => lock(context, other, "share row exclusive", also)),
    ];
  }
  if (reader.take("view")) {
    return [lock(context, reader.relation(), "access exclusive", { creates: true })];
  }
  if (reader.take("trigger")) {
    reader.name();
    reader.at = reader.find(isWord("on")) + 1;
    return [lock(context, reader.relation(), "share row exclusive")];
  }
  if (reader.take("policy")) {
    reader.name();
    reader.expect("on");
    return [lock(context, reader.relation(), "access exclusive")];
  }
  throw reader.unread("a create of an unknown kind");
}

function createIndex(reader: Reader, context: Context): StatementLock[] {
  const concurrently = reader.take("concurrently");
  reader.take("if", "not", "exists");
  if (!reader.sees("on")) {
    reader.name();
  }
  reader.expect("on");
  reader.take("only");
  return [
    lock(context, reader.relation(), concurrently ? "share update exclusive" : "share", {
      everyRow: true,
    }),
  ];
}

/** Whether a `default` in a column definition is a constant: adding it rewrites no row (Postgres 11+). */
function constantDefault(tokens: readonly Token[]): boolean {
  const at = tokens.findIndex(isWord("default"));
  if (at < 0) {
    return true;
  }
  const value = tokens[at + 1];
  const after = tokens[at + 2];
  const constant =
    value !== undefined &&
    (value.kind === "string" ||
      value.kind === "number" ||
      (value.kind === "word" && ["true", "false", "null"].includes(value.value)));
  // A constant may carry a cast (`'[]'::jsonb`); anything else after it ends the default.
  return constant && (after === undefined || after.kind === "word" || after.value === "::");
}

/** One action of an `alter table`: its mode on the table, whether it goes through every row, and the tables it references. */
function alterAction(action: Reader): {
  readonly mode: LockMode;
  readonly everyRow: boolean;
  readonly references: Relation[];
} {
  const words = action.tokens.map((token) => token.value);
  const has = (word: string) => action.tokens.some(isWord(word));
  const notValid = action.tokens.some((token, index) => {
    const after = action.tokens[index + 1];
    return isWord("not")(token) && after !== undefined && isWord("valid")(after);
  });
  if (action.take("add", "constraint") || (action.sees("add") && has("foreign"))) {
    const references = referenced(action);
    const foreign = has("foreign");
    if (!foreign && !["primary", "unique", "check"].some(has)) {
      throw action.unread(`a constraint of an unknown kind: ${words.join(" ")}`);
    }
    return {
      mode: foreign ? "share row exclusive" : "access exclusive",
      everyRow: !notValid,
      references,
    };
  }
  if (action.take("add")) {
    action.take("column");
    // A key, a check or a reference on a new column reads every row; a constant default reads none.
    const checked = ["primary", "unique", "check", "references", "generated"].some(has);
    return {
      mode: "access exclusive",
      everyRow: checked || !constantDefault(action.tokens),
      references: referenced(action),
    };
  }
  if (action.take("drop")) {
    // `drop constraint`, `drop column` (or a bare `drop <column>`): marked gone, no row rewritten.
    return { mode: "access exclusive", everyRow: false, references: [] };
  }
  if (action.take("alter")) {
    action.take("column");
    action.name();
    if (action.take("drop", "not", "null") || action.take("drop", "default")) {
      return { mode: "access exclusive", everyRow: false, references: [] };
    }
    if (action.take("set", "default")) {
      return { mode: "access exclusive", everyRow: false, references: [] };
    }
    if (action.take("set", "not", "null") || action.take("type") || action.take("set", "data")) {
      return { mode: "access exclusive", everyRow: true, references: [] };
    }
  }
  if (
    (action.take("enable") || action.take("disable") || action.take("force")) &&
    action.sees("row", "level", "security")
  ) {
    return { mode: "access exclusive", everyRow: false, references: [] };
  }
  if (action.take("no", "force", "row", "level", "security") || action.take("owner", "to")) {
    return { mode: "access exclusive", everyRow: false, references: [] };
  }
  throw action.unread(`an alter table action of an unknown kind: ${words.join(" ")}`);
}

function alter(reader: Reader, context: Context): StatementLock[] {
  if (reader.take("function") || reader.take("role") || reader.take("default", "privileges")) {
    return [];
  }
  reader.expect("table");
  reader.take("if", "exists");
  reader.take("only");
  const table = reader.relation();
  const actions: Reader[] = [];
  while (!reader.done) {
    const end = reader.find((token) => token.value === ",");
    actions.push(new Reader(reader.tokens.slice(reader.at, end), reader.text, reader.statement));
    reader.at = end + 1;
  }
  if (actions.length === 0) {
    throw reader.unread("an alter table with no action");
  }
  const read = actions.map(alterAction);
  const mode = read.map((one) => one.mode).reduce((a, b) => (rank(a) >= rank(b) ? a : b));
  return [
    lock(context, table, mode, { everyRow: read.some((one) => one.everyRow) }),
    ...read.flatMap((one) =>
      one.references.map((other) => lock(context, other, "share row exclusive")),
    ),
  ];
}

function comment(reader: Reader, context: Context): StatementLock[] {
  reader.expect("on");
  if (reader.take("column")) {
    // `schema.table.column`: the table is the first two names.
    const first = reader.name();
    reader.next();
    const second = reader.name();
    if (reader.peek()?.value === ".") {
      return [lock(context, { schema: first, name: second }, "share update exclusive")];
    }
    return [lock(context, { schema: undefined, name: first }, "share update exclusive")];
  }
  if (reader.take("table") || reader.take("view")) {
    return [lock(context, reader.relation(), "share update exclusive")];
  }
  if (reader.take("function") || reader.take("schema") || reader.take("role")) {
    return [];
  }
  throw reader.unread("a comment on an unknown kind of object");
}

function drop(reader: Reader, context: Context): StatementLock[] {
  if (reader.take("trigger")) {
    const ifThere = reader.take("if", "exists");
    const trigger = reader.name();
    reader.expect("on");
    const table = reader.relation();
    // Postgres 17, measured: with no such trigger, `drop trigger if exists` locks nothing.
    const when = ifThere
      ? `exists (select 1 from pg_catalog.pg_trigger where tgrelid = to_regclass(${regclass(table)}) and tgname = ${quoteLiteral(trigger)})`
      : undefined;
    return [lock(context, table, "access exclusive", when === undefined ? {} : { when })];
  }
  if (reader.take("policy")) {
    const ifThere = reader.take("if", "exists");
    const policy = reader.name();
    reader.expect("on");
    const table = reader.relation();
    const when = ifThere
      ? `exists (select 1 from pg_catalog.pg_policy where polrelid = to_regclass(${regclass(table)}) and polname = ${quoteLiteral(policy)})`
      : undefined;
    return [lock(context, table, "access exclusive", when === undefined ? {} : { when })];
  }
  if (reader.take("view") || reader.take("table") || reader.take("materialized", "view")) {
    const ifThere = reader.take("if", "exists");
    const relation = reader.relation();
    const when = ifThere ? `to_regclass(${regclass(relation)}) is not null` : undefined;
    return [lock(context, relation, "access exclusive", when === undefined ? {} : { when })];
  }
  if (reader.take("function")) {
    return [];
  }
  throw reader.unread("a drop of an unknown kind");
}

/** `current_setting('key')` replaced by the value the script set, so the condition reads alone. */
function withSettings(condition: string, settings: Settings): string {
  return condition.replaceAll(
    /current_setting\('((?:[^']|'')*)'(?:,\s*true)?\)/g,
    (call, key: string) => {
      const value = settings.get(key.replaceAll("''", "'"));
      return value === undefined ? call : quoteLiteral(value);
    },
  );
}

/** The SQL an `execute format('…', a, b)` runs, its `%I`, `%L` and `%s` filled from what is known. */
function formatted(reader: Reader, settings: Settings): string | undefined {
  if (!reader.take("format")) {
    const literal = reader.peek();
    return literal?.kind === "string" && reader.tokens.length === reader.at + 1
      ? literal.value
      : undefined;
  }
  if (reader.next().value !== "(") {
    return undefined;
  }
  const close = reader.find((token) => token.value === ")");
  const args: Reader[] = [];
  while (reader.at < close) {
    const end = Math.min(
      close,
      reader.find((token) => token.value === ","),
    );
    args.push(new Reader(reader.tokens.slice(reader.at, end), reader.text, reader.statement));
    reader.at = end + 1;
  }
  const [template, ...values] = args.map((arg): string | undefined => {
    const [first, second, third] = arg.tokens;
    if (arg.tokens.length === 1 && first?.kind === "string") {
      return first.value;
    }
    if (first?.value === "current_setting" && second?.value === "(" && third?.kind === "string") {
      return settings.get(third.value);
    }
    return undefined;
  });
  if (template === undefined) {
    return undefined;
  }
  let next = 0;
  return template.replaceAll(/%([%ILs])/g, (_, spec: string) => {
    if (spec === "%") {
      return "%";
    }
    const value = values[next] ?? UNKNOWN;
    next += 1;
    return spec === "I" ? quoteIdent(value) : spec === "L" ? quoteLiteral(value) : value;
  });
}

/** A plpgsql block's statements until `end`, `elsif` or `else`, each under `when`. */
function blockStatements(reader: Reader, context: Context, inLoop: boolean): StatementLock[] {
  const locks: StatementLock[] = [];
  while (
    !reader.done &&
    !reader.sees("end") &&
    !reader.sees("elsif") &&
    !reader.sees("else") &&
    !reader.sees("exception")
  ) {
    if (reader.take("if")) {
      locks.push(...ifStatement(reader, context, inLoop));
      continue;
    }
    if (reader.sees("for") || reader.sees("while") || reader.sees("loop")) {
      reader.at = reader.find(isWord("loop")) + 1;
      // A loop's statements run once per row it finds: when, the listing cannot say.
      locks.push(...blockStatements(reader, context, true));
      reader.expect("end", "loop");
      reader.at = reader.find((token) => token.value === ";") + 1;
      continue;
    }
    const end = reader.find((token) => token.value === ";");
    const statement = new Reader(
      reader.tokens.slice(reader.at, end),
      reader.text,
      reader.statement,
    );
    reader.at = end + 1;
    locks.push(
      ...plpgsqlStatement(statement, context).map((one) => {
        if (inLoop && rank(one.mode) >= HOLDS_OFF_WRITES) {
          throw reader.unread("a lock taken inside a loop");
        }
        return one;
      }),
    );
  }
  return locks;
}

/** `if c1 then … elsif c2 then … else … end if;`: each branch under its own conditions. */
function ifStatement(reader: Reader, context: Context, inLoop: boolean): StatementLock[] {
  const locks: StatementLock[] = [];
  const earlier: string[] = [];
  let branch = true;
  while (branch) {
    const then = reader.find(isWord("then"));
    const condition = withSettings(reader.slice(reader.at, then), context.settings);
    reader.at = then + 1;
    const when = [...context.when, ...earlier.map((one) => `not (${one})`), condition];
    locks.push(...blockStatements(reader, { ...context, when }, inLoop));
    earlier.push(condition);
    branch = reader.take("elsif");
  }
  if (reader.take("else")) {
    const when = [...context.when, ...earlier.map((one) => `not (${one})`)];
    locks.push(...blockStatements(reader, { ...context, when }, inLoop));
  }
  reader.expect("end", "if");
  reader.at = reader.find((token) => token.value === ";") + 1;
  return locks;
}

/** One plpgsql statement: dynamic SQL rebuilt and read, plain SQL read, the rest locking nothing. */
function plpgsqlStatement(reader: Reader, context: Context): StatementLock[] {
  if (reader.done) {
    return [];
  }
  if (reader.take("execute")) {
    const until = reader.find((token) => isWord("into")(token) || isWord("using")(token));
    const call = new Reader(reader.tokens.slice(reader.at, until), reader.text, reader.statement);
    const sql = formatted(call, context.settings);
    if (sql === undefined) {
      throw reader.unread("dynamic SQL the listing cannot rebuild");
    }
    return read(sql, context);
  }
  if (
    reader.sees("perform") ||
    reader.sees("raise") ||
    reader.sees("return") ||
    reader.sees("null") ||
    reader.tokens.slice(0, 4).some((token) => token.value === ":=")
  ) {
    return [];
  }
  return read(reader.slice(0, reader.tokens.length), context);
}

/** A `do` block's body: its declarations skipped, its statements read. */
function doBlock(reader: Reader, context: Context): StatementLock[] {
  reader.take("language", "plpgsql");
  const body = reader.next();
  if (body.kind !== "dollar") {
    throw reader.unread("a do block without a dollar-quoted body");
  }
  const inner = new Reader(tokenize(body.value), body.value, reader.statement);
  if (inner.take("declare")) {
    inner.at = inner.find(isWord("begin"));
  }
  inner.expect("begin");
  const locks = blockStatements(inner, context, false);
  inner.expect("end");
  return locks;
}

/** The locks one statement takes, each under the conditions it runs in. */
function read(statement: string, context: Omit<Context, "statement">): StatementLock[] {
  const reader = new Reader(tokenize(statement), statement, statement);
  const at: Context = { ...context, statement };
  if (reader.done) {
    return [];
  }
  const first = reader.next();
  if (first.kind !== "word") {
    throw reader.unread("it does not begin with a word");
  }
  switch (first.value) {
    case "set":
    case "grant":
    case "revoke":
    case "begin":
    case "commit":
      return [];
    case "select":
      // A read, an advisory lock (on a key, not a table), or the script's own settings.
      readSettings(reader, context.settings);
      return [];
    case "lock":
      return lockTable(reader, at);
    case "create":
      return create(reader, at);
    case "alter":
      return alter(reader, at);
    case "comment":
      return comment(reader, at);
    case "drop":
      return drop(reader, at);
    case "insert":
      reader.expect("into");
      return [lock(at, reader.relation(), "row exclusive")];
    case "update":
      reader.take("only");
      return [lock(at, reader.relation(), "row exclusive")];
    case "delete":
      reader.expect("from");
      return [lock(at, reader.relation(), "row exclusive")];
    case "do":
      return doBlock(reader, at);
    default:
      throw reader.unread(`a statement of an unknown kind (${first.value})`);
  }
}

/**
 * The locks a statement takes, read from its text: `settings` carries the transaction settings the
 * statements before it set, and gains this one's.
 */
export function statementLocks(statement: string, settings: Settings): StatementLock[] {
  return read(statement, { settings, when: [] });
}

/** Whether a lock holds off the application's writes (and reads, for access exclusive). */
export function holdsOff(mode: LockMode): boolean {
  return rank(mode) >= HOLDS_OFF_WRITES;
}

/** The planner's estimate of a relation's rows, and whether it was ever analysed or vacuumed. */
const FACTS_QUERY = `select c.oid is not null as present, c.reltuples::float8 as rows,
       (s.last_analyze is null and s.last_autoanalyze is null
        and s.last_vacuum is null and s.last_autovacuum is null) as never
  from (select to_regclass($1) as oid) r
  left join pg_catalog.pg_class c on c.oid = r.oid
  left join pg_catalog.pg_stat_all_tables s on s.relid = c.oid`;

/** The transaction setting a condition's answer is left in, and the body's dollar tag. */
const ANSWER = "facetdb.lock_condition";
const ANSWER_TAG = "$fdb_lock_condition$";

/**
 * Whether the script's own condition holds now, asked of the database (it only reads the catalog)
 * inside the listing's transaction. A `do` block asks it, so the server itself catches the one
 * failure a condition may meet: it reads a relation or a schema the script makes before it (a side
 * table on a first install), so the statement runs, and its lock falls on what the script has just
 * created. The driver never sees that failure (postgres.js does not carry a transaction past a
 * failed statement), and the answer travels back in a transaction setting (`set_config`, allowed
 * in a read-only transaction). Any other failure is the listing's, and says why.
 */
async function holds(query: SqlQuery, condition: string): Promise<boolean> {
  if (condition.includes(ANSWER_TAG)) {
    throw new UnreadStatementError(condition, `a condition holding ${ANSWER_TAG}`);
  }
  await query(`do ${ANSWER_TAG}
begin
  perform pg_catalog.set_config('${ANSWER}', coalesce((${condition})::text, 'false'), true);
exception when undefined_table or invalid_schema_name then
  perform pg_catalog.set_config('${ANSWER}', 'true', true);
end ${ANSWER_TAG}`);
  const rows = await query(`select pg_catalog.current_setting('${ANSWER}') as runs`);
  return rows[0]?.["runs"] === "true";
}

const key = (relation: Relation) => `${relation.schema ?? ""}.${relation.name}`;

export type ScriptLocksOptions = {
  readonly step: PlanStep;
  /**
   * The statements of the step that runs first on the same database, in a transaction of its own
   * committed before this one (the store's step before an install whose plan holds the store's
   * statements): what they create is there by the time this step runs, and a statement of this step
   * that is one of them, word for word, finds its work done and locks nothing.
   */
  readonly after?: readonly string[];
};

/**
 * Every table a script's statements lock against the application, read from the statements and
 * the database as it is now (read-only): one entry per table, in the order the script first locks
 * it, with the strongest mode it takes there, and the rows the step goes through (the planner's
 * estimate, never a count; `none` when no statement reads them; `empty` for a table it creates).
 * The database is read in one read-only transaction that pins the literal rules the scripts pin
 * (`standard_conforming_strings`), so a condition holding a name with a backslash reads as the
 * script reads it whatever the server's or the login's default. Nothing it reads takes a lock on
 * a table (the catalog's rows, `to_regclass`; engine/migrate-locks.db.test.ts plans while another
 * session holds the table in access exclusive mode), and its transaction pins `LIST_LOCK_TIMEOUT`
 * besides, so the planning never queues behind another transaction, nor the application's
 * queries behind it. Throws when a statement cannot be read or the catalog cannot be (that
 * timeout included): the callers that plan a migration turn that into `unlisted`.
 */
export async function scriptLocks(
  client: Pick<SqlClient, "transaction">,
  statements: readonly string[],
  options: ScriptLocksOptions,
): Promise<PlanLock[]> {
  const first = new Set(options.after ?? []);
  const madeFirst = new Set<string>();
  const earlierSettings: Settings = new Map();
  for (const statement of options.after ?? []) {
    for (const one of statementLocks(statement, earlierSettings)) {
      if (one.creates) {
        madeFirst.add(key(one.relation));
      }
    }
  }
  const settings: Settings = new Map();
  const taken: StatementLock[] = [];
  for (const statement of statements) {
    const locks = statementLocks(statement, settings);
    if (!first.has(statement)) {
      taken.push(...locks.filter((one) => holdsOff(one.mode)));
    }
  }
  return client.transaction(async (query) => {
    await query("set transaction read only");
    await query("set local standard_conforming_strings = on");
    await query(lockTimeoutStatement(LIST_LOCK_TIMEOUT));
    return listed(query, taken, madeFirst, options.step);
  });
}

/** How long the listing's reads may wait for a lock: never long, since a plan holds nothing up. */
const LIST_LOCK_TIMEOUT = "1s";

/** The locks that run, folded one entry per table, with what the catalog says of each table. */
async function listed(
  query: SqlQuery,
  taken: readonly StatementLock[],
  madeFirst: ReadonlySet<string>,
  step: PlanStep,
): Promise<PlanLock[]> {
  const verdicts = new Map<string, boolean>();
  const runs = async (one: StatementLock): Promise<boolean> => {
    for (const condition of one.when) {
      let verdict = verdicts.get(condition);
      if (verdict === undefined) {
        verdict = await holds(query, condition);
        verdicts.set(condition, verdict);
      }
      if (!verdict) {
        return false;
      }
    }
    return true;
  };
  const byTable = new Map<string, StatementLock[]>();
  for (const one of taken) {
    if (await runs(one)) {
      byTable.set(key(one.relation), [...(byTable.get(key(one.relation)) ?? []), one]);
    }
  }
  const list: PlanLock[] = [];
  for (const [table, locks] of byTable) {
    const relation = (locks[0] as StatementLock).relation;
    const [facts] = await query(FACTS_QUERY, [qualified(relation)]);
    const present = facts?.["present"] === true;
    const strongest = locks.map((one) => one.mode).reduce((a, b) => (rank(a) >= rank(b) ? a : b));
    // New to this step: absent now, and not made by the step that runs first.
    const created = !present && !madeFirst.has(table);
    list.push({
      step,
      table,
      mode: strongest === "access exclusive" ? "no reads or writes" : "no writes",
      rows: created
        ? "empty"
        : locks.some((one) => one.everyRow)
          ? estimate(present, facts?.["rows"], facts?.["never"])
          : "none",
    });
  }
  return list;
}

/**
 * The planner's estimate as a row count: none for a table never analysed (Postgres 14 and later
 * say -1, 13 and earlier 0); 0 for a table the step before this one makes.
 */
function estimate(present: boolean, rows: unknown, never: unknown): number | "unknown" {
  if (!present) {
    return 0;
  }
  const value = Number(rows);
  return !Number.isFinite(value) || value < 0 || (value === 0 && never !== false)
    ? "unknown"
    : Math.round(value);
}
