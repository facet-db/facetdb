/**
 * A channel's quiet hours: from one time of day to another on the wall clock of a time zone, the
 * channel's own or the worker machine's. Inside them a warning or an information message is held
 * for the channel and sent with the summary when they end; a critical alert always goes through
 * (alerts.ts).
 *
 * A period is a span of instants: it starts when the zone's wall clock first reads `from` on a day
 * and ends when it next first reads `to` (the same day, or the next one when the hours cross
 * midnight). Across a daylight-saving change the span is as long as the clocks make it: 22:00 to
 * 07:00 lasts eight hours the night the clocks go forward and ten the night they go back. A time the
 * change skips (02:30 the night 02:00 becomes 03:00) is reached when the clock jumps past it; a time
 * it repeats is reached the first time. Node's `Intl` reads the zones; nothing else is needed.
 */

/** A channel's quiet hours as the worker runs them. */
export type QuietWindow = {
  /** `HH:MM` on a 24-hour clock: when they start. */
  readonly from: string;
  /** `HH:MM`: when they end; earlier than `from` for hours that cross midnight. */
  readonly to: string;
  /** The IANA time zone the two times are read in (`Europe/Berlin`): the channel's, else the machine's. */
  readonly zone: string;
};

/** One quiet period: from `start` (inside) to `end` (outside), in ms since the epoch. */
export type QuietPeriod = { readonly start: number; readonly end: number };

const DAY_MS = 86_400_000;

/**
 * The time zone this process runs in as Node names it (`TZ`, else the system's), unjudged: Node
 * names `Etc/Unknown` for an empty `TZ`, and none at all (despite its type) for a `TZ` it does not
 * know. `knownZone` judges it.
 */
export function processZone(): string | undefined {
  const zone: string | undefined = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone;
}

/**
 * `zone` when Node can read wall clocks in it; undefined for none, for `Etc/Unknown` and for any
 * name it does not know. The machine's zone is a boundary (the environment's `TZ`): the channel host
 * judges it at load before any quiet hours are read in it.
 */
export function knownZone(zone: string | undefined): string | undefined {
  if (zone === undefined || zone === "" || zone === "Etc/Unknown") {
    return undefined;
  }
  try {
    formatterOf(zone);
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * The time zone of the machine the worker runs on, what quiet hours with no `zone` are read in;
 * undefined when Node cannot read it (an empty or unknown `TZ`), and the channel host then refuses
 * such quiet hours at load.
 */
export function machineZone(): string | undefined {
  return knownZone(processZone());
}

/** One formatter per zone: building one costs far more than using it. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(zone: string): Intl.DateTimeFormat {
  const known = formatters.get(zone);
  if (known !== undefined) {
    return known;
  }
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  formatters.set(zone, made);
  return made;
}

/** A calendar day on a wall clock. */
type Day = { readonly year: number; readonly month: number; readonly day: number };

/** The wall clock of `zone` at an instant: its day, and the instant's wall time as a UTC count. */
function wallOf(zone: string, at: number): { readonly day: Day; readonly wall: number } {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(zone).formatToParts(new Date(at))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  const day = { year: parts["year"] ?? 0, month: parts["month"] ?? 0, day: parts["day"] ?? 0 };
  const wall = Date.UTC(
    day.year,
    day.month - 1,
    day.day,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return { day, wall };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms (whole seconds). */
function offsetAt(zone: string, at: number): number {
  return wallOf(zone, at).wall - Math.floor(at / 1000) * 1000;
}

/** The day `days` after `day` on the calendar. */
function dayAfter(day: Day, days: number): Day {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * The first instant at which the zone's wall clock reads `minutes` past midnight of `day`, or later:
 * the instant itself; the earlier of two when the clocks go back over it; the change itself when
 * they go forward over it.
 */
function instantOf(zone: string, day: Day, minutes: number): number {
  const wall = Date.UTC(day.year, day.month - 1, day.day, 0, minutes);
  // The offsets a day either side: a change of the clocks near this time lies between them.
  const before = offsetAt(zone, wall - DAY_MS);
  const after = offsetAt(zone, wall + DAY_MS);
  const fits = [before, after]
    .map((offset) => ({ offset, at: wall - offset }))
    .filter(({ offset, at }) => offsetAt(zone, at) === offset)
    .map(({ at }) => at);
  if (fits.length > 0) {
    return Math.min(...fits);
  }
  // The clocks skip this time: it is reached at the change, which lies between the instant it would
  // be under the new offset (earlier, still the old one) and under the old offset (the new one).
  let low = wall - after;
  let high = wall - before;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (offsetAt(zone, middle) === after) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

/** `HH:MM` as minutes past midnight. */
function minutesOf(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** The period that starts on `day`. Empty (start not before end) when the clocks swallow it. */
function periodFrom(window: QuietWindow, day: Day): QuietPeriod {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  return {
    start: instantOf(window.zone, day, from),
    end: instantOf(window.zone, to > from ? day : dayAfter(day, 1), to),
  };
}

/** The periods starting on the days around an instant's own day in the window's zone, oldest first. */
function periodsAround(window: QuietWindow, at: number, days: readonly number[]): QuietPeriod[] {
  const today = wallOf(window.zone, at).day;
  return days
    .map((shift) => periodFrom(window, dayAfter(today, shift)))
    .filter((period) => period.start < period.end);
}

/** The quiet period `at` falls in, or undefined when the channel is not quiet then. */
export function quietPeriodAt(window: QuietWindow, at: number): QuietPeriod | undefined {
  return periodsAround(window, at, [-1, 0]).find((period) => period.start <= at && at < period.end);
}

/** Whether `at` falls inside the channel's quiet hours. */
export function isQuiet(window: QuietWindow, at: number): boolean {
  return quietPeriodAt(window, at) !== undefined;
}

/**
 * The most recent quiet period that ended at or before `at`: the one whose summary is due. Every
 * day has one unless the clocks swallow it, so one ends within the two days before `at`.
 */
export function lastQuietPeriod(window: QuietWindow, at: number): QuietPeriod | undefined {
  return periodsAround(window, at, [-2, -1, 0])
    .filter((period) => period.end <= at)
    .reduce<QuietPeriod | undefined>(
      (latest, period) => (latest === undefined || period.end > latest.end ? period : latest),
      undefined,
    );
}
