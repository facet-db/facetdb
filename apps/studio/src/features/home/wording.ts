/**
 * The small wordings the Home page does itself, from what `GET /v1/home` carries: the worker
 * words every figure and check already, so this file only splits, counts and formats. It invents
 * no number the endpoint does not give.
 */

/**
 * A check's words in two parts: the first clause, which the status word carries, and what is left
 * (what happened and what FacetDB did), shown under it. "Worker not running. The worker has not
 * beat..." splits at the full stop; "Three sources, logins as installed; listings: ..." at the
 * semicolon.
 */
export function splitCheck(words: string): { readonly line: string; readonly rest: string } {
  const cut = /[.;] /.exec(words);
  if (cut === null) {
    return { line: words.replace(/\.$/, ""), rest: "" };
  }
  return { line: words.slice(0, cut.index), rest: words.slice(cut.index + 2) };
}

const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** "no sources", "one source", "three sources", "12 sources": the words up to ten. */
export function sourcesWords(count: number): string {
  const number = COUNT_WORDS[count] ?? count.toLocaleString("en-US");
  return `${number} ${count === 1 ? "source" : "sources"}`;
}

/** The line under the page's title: the project, how many sources it watches, and its state. */
export function ledeOf(
  project: string | undefined,
  health: {
    readonly status: "running" | "attention";
    readonly words: string;
    readonly sources: readonly unknown[];
    readonly checks: readonly { readonly name: string; readonly status: string }[];
  },
): string {
  const watched =
    health.sources.length === 0
      ? "no source is installed yet"
      : `${sourcesWords(health.sources.length)} watched`;
  return sentenceOf(project, `${watched}, ${stateOf(health)}.`);
}

/** The lede when the worker could not be asked: nothing about its state is claimed. */
export function unreachableLede(project: string | undefined): string {
  return sentenceOf(
    project,
    "the worker cannot be reached, so these are the last figures it gave.",
  );
}

const CHECK_SUBJECT: Readonly<Record<string, string>> = {
  worker: "the worker",
  model: "the model",
  sources: "the sources",
};

/** Only what is true: "everything running" when every check is ok, else the check that is not. */
function stateOf(health: {
  readonly status: "running" | "attention";
  readonly words: string;
  readonly checks: readonly { readonly name: string; readonly status: string }[];
}): string {
  if (health.status === "attention") {
    return health.words.toLowerCase();
  }
  const warned = health.checks
    .filter((check) => check.status !== "ok")
    .map((check) => CHECK_SUBJECT[check.name] ?? check.name);
  return warned.length === 0
    ? "everything running"
    : `running, with a warning about ${warned.join(" and ")}`;
}

function sentenceOf(project: string | undefined, sentence: string): string {
  return project === undefined
    ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
    : `${project}: ${sentence}`;
}

const AT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * When an alert was raised or resolved, in the viewer's zone: "Nov 5, 2:10 PM". The page has no
 * clock of its own, so it does not say "today" or "yesterday".
 */
export function alertTime(at: string): string {
  return AT.format(new Date(at));
}

/**
 * An alert's link as the page may follow it: an http or https address, or a path on this studio's
 * own origin. The worker writes the link, but anything else (`javascript:`, `data:`) is not
 * followed; the alert then carries no link rather than a dangerous one.
 */
export function followable(link: string, origin: string): string | null {
  try {
    const { protocol } = new URL(link, origin);
    return protocol === "http:" || protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}
