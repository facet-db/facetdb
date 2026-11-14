/**
 * Quoting for the SQL FacetDB writes into a SQLite file. A plan holds its statements as plain text
 * with every value written as a literal (what prints is what runs), so every identifier goes
 * through `quoteIdent` and every value through `quoteLiteral`, in one place.
 */

/** An identifier in double quotes, a double quote inside it doubled: any table or column name. */
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
 * A string literal: single quotes around it, a single quote inside it doubled. SQLite has no
 * backslash escapes, so nothing else in the text means anything.
 */
export function quoteLiteral(text: string): string {
  if (text.includes("\0")) {
    throw new Error("a literal must not contain a NUL character");
  }
  return `'${text.replaceAll("'", "''")}'`;
}
