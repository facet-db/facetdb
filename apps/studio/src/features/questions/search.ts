/**
 * What the Questions page keeps in the address: the source whose tab is open, so a reload and a
 * shared link open the same one. `source` reaches the validator as written (routes/search.ts); any
 * other key is dropped, and a name the config lacks falls back to the first source on the page.
 */
export type QuestionsSearch = { readonly source?: string };

export function questionsSearch(search: Record<string, unknown>): QuestionsSearch {
  const source = search["source"];
  return typeof source === "string" && source !== "" ? { source } : {};
}
