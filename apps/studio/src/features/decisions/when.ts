/**
 * Times as the pages say them, in this machine's zone and in English: "2:31 pm" for today,
 * "yesterday 11:02 pm", "Nov 4, 11:20 am", and with the year when it is not this one. The clock
 * is passed in, never read here.
 */

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const CLOCK_SECONDS = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Newer ICU puts a narrow no-break space before "PM"; the page wants a plain space and lower case. */
function plain(text: string): string {
  return text.replace(/[  ]/g, " ").replace("AM", "am").replace("PM", "pm");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function whenWords(at: Date, now: Date, options?: { readonly seconds?: boolean }): string {
  const clock = plain((options?.seconds === true ? CLOCK_SECONDS : CLOCK).format(at));
  if (sameDay(at, now)) {
    return clock;
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(at, yesterday)) {
    return `yesterday ${clock}`;
  }
  const day = (at.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(at);
  return `${day}, ${clock}`;
}

/** A time as `facetdb explain` prints it, in UTC: `YYYY-MM-DD HH:MM UTC`. */
export function utcWords(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The viewer's zone, as the browser names it ("Europe/Berlin"). */
export function zoneName(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The local calendar day, so a page can tell when midnight has passed. */
export function dayKey(at: Date): string {
  return `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;
}

/** Milliseconds from `now` to just after the next local midnight (a second past, so the day has turned). */
export function untilNextDay(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return midnight.getTime() - now.getTime() + 1000;
}

/** How long a run took: "0.8 s", "11.4 s", "2 min 5 s". */
export function tookWords(startedAt: Date, endedAt: Date): string {
  const seconds = Math.max(0, endedAt.getTime() - startedAt.getTime()) / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))} min ${String(whole % 60)} s`;
}
