/**
 * The comment action's text: a template from the config file over the record's decisions, and the
 * hidden marker that finds the comment again.
 *
 * The template is the config author's own Markdown. What fills a placeholder is data, never
 * markup: yes and no, a probability and a status are words FacetDB writes itself; an option or a
 * level name (any one-line text a config or a pack chose, or a person picked in review) is written
 * as inline code, so it cannot ping anyone (`@team`), link an issue, open HTML, hide text or start
 * a marker. Invisible characters are dropped from it and it is cut to `VALUE_MAX` characters. No
 * record content reaches the comment at all: an action receives decisions, never the record's
 * text.
 *
 * The marker is an HTML comment on the comment's first line, so GitHub renders nothing of it
 * whatever the template holds after it (an unclosed code fence, a table), and every write the
 * action makes starts with it again. A comment is the action's own only when its first line IS
 * the marker, exactly: a value cannot put text before it, and the comment action also checks the
 * comment's author.
 */

/** GitHub's limit on a comment's body, in characters (UTF-16 units here, never fewer than GitHub counts). */
export const COMMENT_MAX = 65_536;

/** The longest value written into a comment, in characters, before it is cut. */
export const VALUE_MAX = 100;

/**
 * The most one placeholder can grow to once written: a cut value (`VALUE_MAX`) plus its marker,
 * between fences one backtick longer than its longest run of backticks, with a space each side.
 */
export const RENDERED_VALUE_MAX = 2 * (VALUE_MAX + 2) + VALUE_MAX + 4;

/** The longest marker: `<!-- facetdb:comment source=… id=… -->` with both at their longest. */
export const MARKER_MAX = 200;

/** What the marker of every comment starts with; a template may not hold it. */
export const MARKER_PREFIX = "<!-- facetdb:comment";

/** One `{{…}}` in a template, the text inside it as written. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The forms a placeholder takes: `{{status}}`, `{{name}}`, `{{name.probability}}`. */
const FORM = /^\s*(?:(status)|([a-z][a-z0-9_]{0,39})(\.probability)?)\s*$/;

/** One placeholder of a template, read. */
type Slot =
  | { readonly kind: "status" }
  | { readonly kind: "value"; readonly question: string }
  | { readonly kind: "probability"; readonly question: string };

/** A template as parts: literal text and the placeholders between. */
export type Template = readonly (string | Slot)[];

/** The template read, or the reasons it is refused, each naming the fix. */
export function parseTemplate(
  body: string,
):
  | { readonly ok: true; readonly template: Template }
  | { readonly ok: false; readonly problems: string[] } {
  const problems: string[] = [];
  const parts: (string | Slot)[] = [];
  let at = 0;
  for (const match of body.matchAll(PLACEHOLDER)) {
    parts.push(body.slice(at, match.index));
    at = match.index + match[0].length;
    const inner = match[1] ?? "";
    const form = FORM.exec(inner);
    if (form === null || (form[2] === "status" && form[3] !== undefined)) {
      problems.push(
        `{{${inner.slice(0, 60)}}} is not a placeholder: write {{status}}, {{<question>}} or {{<question>.probability}}, with a question's name`,
      );
      continue;
    }
    if (form[1] !== undefined) {
      parts.push({ kind: "status" });
    } else if (form[3] === undefined) {
      parts.push({ kind: "value", question: form[2] as string });
    } else {
      parts.push({ kind: "probability", question: form[2] as string });
    }
  }
  parts.push(body.slice(at));
  const literal = parts.filter((part): part is string => typeof part === "string").join("");
  if (literal.includes("{{") || literal.includes("}}")) {
    problems.push(
      "holds a {{ or }} that is not part of a placeholder: write {{status}}, {{<question>}} or {{<question>.probability}}",
    );
  }
  if (body.trim() === "") {
    problems.push("is empty: write the comment's text");
  }
  if (body.toLowerCase().includes(MARKER_PREFIX.slice(5))) {
    problems.push(
      "holds the words of FacetDB's hidden marker (facetdb:comment), which find a comment again: take them out",
    );
  }
  const slots = parts.length - parts.filter((part) => typeof part === "string").length;
  const longest = body.length + slots * RENDERED_VALUE_MAX + MARKER_MAX + 2;
  if (longest > COMMENT_MAX) {
    problems.push(
      `could grow past GitHub's ${COMMENT_MAX.toLocaleString("en-US")} characters with its values and the marker: shorten it (up to ${RENDERED_VALUE_MAX} characters are kept for each placeholder)`,
    );
  }
  return problems.length === 0 ? { ok: true, template: parts } : { ok: false, problems };
}

/** A decision as the comment reads it: the SDK's `Decision`. */
type Decision =
  | {
      readonly kind: "decided";
      readonly value: boolean | string;
      readonly probabilityOrConfidence: number;
    }
  | { readonly kind: "needs_review" };

/** The words for a question waiting for a person, in place of a value or a probability. */
export const NEEDS_REVIEW = "needs review";

/** Format characters (bidirectional overrides, zero-width spaces and joiners) and control characters. */
const INVISIBLE = /[\p{Cf}\p{Cc}]+/gu;

/**
 * An option's or a level's name as inline code: invisible characters dropped, spaces collapsed,
 * cut to `VALUE_MAX`, between fences longer than any run of backticks it holds (CommonMark), so
 * nothing in it is read as Markdown, HTML, a mention or a reference.
 */
export function asCode(value: string): string {
  const clean = value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const cut =
    Array.from(clean).length > VALUE_MAX
      ? `${Array.from(clean)
          .slice(0, VALUE_MAX - 1)
          .join("")}…`
      : clean;
  if (cut === "") {
    return "(blank)";
  }
  const runs = cut.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return `${fence} ${cut} ${fence}`;
}

/** A probability as two decimals: `0.93`. */
function probability(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "?";
}

/** Why a template cannot be filled for this record: a placeholder names a question it has no decision for. */
export class UnknownQuestion extends Error {
  readonly question: string;

  constructor(question: string) {
    super(`no decision for the question ${question}`);
    this.question = question;
  }
}

/** The template filled with the record's status and decisions. */
export function render(
  template: Template,
  status: string,
  decisions: Readonly<Record<string, Decision>>,
): string {
  return template
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part.kind === "status") {
        return status.replaceAll("_", " ");
      }
      const decision = Object.hasOwn(decisions, part.question)
        ? decisions[part.question]
        : undefined;
      if (decision === undefined) {
        throw new UnknownQuestion(part.question);
      }
      if (decision.kind === "needs_review") {
        return NEEDS_REVIEW;
      }
      if (part.kind === "probability") {
        return probability(decision.probabilityOrConfidence);
      }
      if (typeof decision.value === "boolean") {
        return decision.value ? "yes" : "no";
      }
      return asCode(decision.value);
    })
    .join("");
}

/** A source's name and an action's id as the marker writes them: nothing that could end the comment. */
function markerWord(text: string): string {
  return encodeURIComponent(text).replaceAll("-", "%2D");
}

/** The hidden marker of one comment action on one source. */
export function markerOf(source: string, id: string): string {
  return `${MARKER_PREFIX} source=${markerWord(source)} id=${markerWord(id)} -->`;
}

/** The comment's whole body: the marker on its own first line, a blank line, then the text. */
export function commentBody(marker: string, text: string): string {
  return `${marker}\n\n${text}`;
}

/**
 * Whether a comment's body is one this marker wrote: its first line is the marker, exactly, but
 * for a line ending GitHub may store as `\r\n` and trailing whitespace.
 */
export function carries(body: string, marker: string): boolean {
  const [first] = body.split(/\r?\n/, 1);
  return first?.trimEnd() === marker;
}
