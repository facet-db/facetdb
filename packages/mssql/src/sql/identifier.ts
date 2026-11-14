/**
 * The one quoting door of the T-SQL FacetDB writes (every identifier passes through one quoting
 * helper). A name from the config or the catalog is written in brackets with `]` doubled; a value
 * written into the text is a Unicode literal with `'` doubled. Nothing else ever puts a name or a
 * value into SQL text.
 */

/** A name as SQL Server reads it in brackets: `[listings]`, and `[a]]b]` for `a]b`. */
export function quoteName(name: string): string {
  return `[${name.replaceAll("]", "]]")}]`;
}

/** A value as a Unicode literal: `N'Listings'`, and `N'O''Brien'` for `O'Brien`. */
export function quoteString(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

/** A schema-qualified name: `[dbo].[listings]`. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteName(schema)}.${quoteName(name)}`;
}
