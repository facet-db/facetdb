/**
 * The unified diff Apply shows before it writes `facetdb.config.ts`: `--- a/<path>`, `+++
 * b/<path>`, then hunks of changed lines with three lines of context, as `git diff` prints them, so
 * what the studio shows reads like what the operator's review tools show. Lines are compared whole;
 * a last line without a newline says so.
 */

/** Lines of unchanged text kept around each change. */
export const DIFF_CONTEXT = 3;

/** Past this many line pairs the comparison is not worth its memory: the file is shown replaced whole. */
const MAX_CELLS = 4_000_000;

/** A line's text, marked when it is the file's last and has no newline after it. */
type Line = { readonly text: string; readonly noNewline: boolean };

type Op = { readonly kind: " " | "-" | "+"; readonly line: Line };

function linesOf(text: string): Line[] {
  if (text === "") {
    return [];
  }
  const parts = text.split("\n");
  const ended = parts[parts.length - 1] === "";
  if (ended) {
    parts.pop();
  }
  return parts.map((part, index) => ({
    text: part,
    noNewline: !ended && index === parts.length - 1,
  }));
}

const same = (a: Line, b: Line) => a.text === b.text && a.noNewline === b.noNewline;

/** The edit from `before` to `after` as kept, removed and added lines: a longest common subsequence. */
function operations(before: readonly Line[], after: readonly Line[]): Op[] {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((line): Op => ({ kind: "-", line })),
      ...after.map((line): Op => ({ kind: "+", line })),
    ];
  }
  // lengths[i * (m + 1) + j]: the longest common run of before[i..] and after[j..].
  const lengths = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => lengths[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const a = before[i];
      const b = after[j];
      lengths[i * (m + 1) + j] =
        a !== undefined && b !== undefined && same(a, b)
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const a = before[i];
    const b = after[j];
    if (a !== undefined && b !== undefined && same(a, b)) {
      ops.push({ kind: " ", line: a });
      i += 1;
      j += 1;
    } else if (b === undefined || (a !== undefined && at(i + 1, j) >= at(i, j + 1))) {
      // Removals before additions, as git prints a replaced line.
      ops.push({ kind: "-", line: a as Line });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b });
      j += 1;
    }
  }
  return ops;
}

function rangeOf(start: number, count: number): string {
  // A hunk that holds no line of a side names the line before it, as git does.
  const first = count === 0 ? start - 1 : start;
  return count === 1 ? `${first}` : `${first},${count}`;
}

/**
 * The unified diff of `before` into `after` for the file at `path`; the empty string when the two
 * are the same text.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }
  const ops = operations(linesOf(before), linesOf(after));
  // Each op's line number on both sides (1-based, the next line when the op has none there).
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.kind !== "+") oldLine += 1;
    if (op.kind !== "-") newLine += 1;
  }
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor] as number;
    let last = first;
    // Changes whose contexts touch or overlap share one hunk.
    while (
      cursor + 1 < changed.length &&
      (changed[cursor + 1] as number) - last <= 2 * DIFF_CONTEXT + 1
    ) {
      cursor += 1;
      last = changed[cursor] as number;
    }
    cursor += 1;
    const start = Math.max(0, first - DIFF_CONTEXT);
    const end = Math.min(ops.length, last + DIFF_CONTEXT + 1);
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${rangeOf(oldAt[start] as number, oldCount)} +${rangeOf(newAt[start] as number, newCount)} @@`,
    );
    for (const op of hunk) {
      out.push(`${op.kind}${op.line.text}`);
      if (op.line.noNewline) {
        out.push("\\ No newline at end of file");
      }
    }
  }
  return `${out.join("\n")}\n`;
}
