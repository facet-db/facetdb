/**
 * The one quoting door for the SQL FacetDB writes into a MySQL or MariaDB database. The same text
 * runs on MySQL 8 and MariaDB 10.5: backticks for names and single quotes for values read alike on
 * both whatever the server's `ANSI_QUOTES`.
 */

/** A name in backticks, a backtick inside it doubled: a table, column, trigger or index name. */
export function quoteIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/** `schema`.`name`: every object FacetDB names is qualified, so the script runs in any session. */
export function quoteTable(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * A value written as a string literal, as the server reads one under its default rules: a quote
 * doubled, a backslash doubled (the install refuses `NO_BACKSLASH_ESCAPES`, under which a backslash
 * is a plain character). The driver escapes the parameters it binds by the same rules.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
