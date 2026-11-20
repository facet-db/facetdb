import { defaultParseSearch } from "@tanstack/react-router";

/**
 * How the router reads the address's search. It parses every value as JSON, so a key someone
 * types into a URL changes on the way in: `?q=1e3` becomes the number 1000, `?q=1.0` the number 1,
 * `?q=9007199254740993` a number that is no longer that key, `?q=true` a flag. A value that is
 * text by nature (a source's name, a record's key, a question's name, a reviewer) is therefore
 * read as it was written. The router also quotes a string it would otherwise mistake
 * (`q=%221e3%22`) when it writes an address; that quoting is its own mark and is taken off, which
 * also means a hand-typed `?q="abc"` loses its quotes and searches for abc.
 * Everything else is parsed as before.
 */
export const WRITTEN_TEXT_KEYS = ["source", "q", "question", "reviewer"] as const;

function asWritten(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export function parseSearch(searchStr: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = { ...defaultParseSearch(searchStr) };
  const written = new URLSearchParams(searchStr);
  for (const key of WRITTEN_TEXT_KEYS) {
    const value = written.get(key);
    if (value !== null) {
      parsed[key] = asWritten(value);
    }
  }
  return parsed;
}
