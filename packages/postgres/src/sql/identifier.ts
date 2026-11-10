/**
 * The one place an identifier from a user (table, column, question name) becomes SQL text: double
 * quotes around it, with any double quote inside doubled. Nothing else in this package builds an
 * identifier by hand. A value never goes through here; values travel as parameters.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error("an identifier must not be empty");
  }
  if (name.includes("\0")) {
    throw new Error("an identifier must not contain a NUL character");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A string literal inside DDL, where no parameter can travel (a trigger's arguments, a `format()`
 * call in a `do` block): single quotes around it, any single quote inside doubled, and a backslash
 * left alone (standard_conforming_strings is on since Postgres 9.1). Only install SQL uses it, and
 * only for names that came from the config; a value a user types still goes as a parameter.
 */
export function quoteLiteral(text: string): string {
  if (text.includes("\0")) {
    throw new Error("a literal must not contain a NUL character");
  }
  return `'${text.replaceAll("'", "''")}'`;
}

/** A table as the source names it: a schema (default `public`) and a name, both quoted. */
export function quoteTable(table: {
  readonly schema?: string | undefined;
  readonly name: string;
}): string {
  return `${quoteIdent(table.schema ?? "public")}.${quoteIdent(table.name)}`;
}
