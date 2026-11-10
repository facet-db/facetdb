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

/** A table as the source names it: a schema (default `public`) and a name, both quoted. */
export function quoteTable(table: {
  readonly schema?: string | undefined;
  readonly name: string;
}): string {
  return `${quoteIdent(table.schema ?? "public")}.${quoteIdent(table.name)}`;
}
