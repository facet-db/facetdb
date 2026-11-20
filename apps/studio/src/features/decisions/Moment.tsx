import { utcWords, whenWords, zoneName } from "./when.ts";

/**
 * A time in the viewer's zone, with the UTC time `facetdb explain` prints in its title and the
 * exact instant in `datetime`. Every table and the timeline say the zone once beneath them
 * (`ZoneNote`), so a time is never mistaken for the terminal's.
 */
export function Moment({
  at,
  now,
  seconds,
}: {
  /** ISO 8601. */
  readonly at: string;
  readonly now: Date;
  readonly seconds?: boolean;
}) {
  const instant = new Date(at);
  return (
    <time dateTime={at} title={utcWords(instant)}>
      {whenWords(instant, now, seconds === true ? { seconds } : undefined)}
    </time>
  );
}

/** The one line that names the zone of the times above it. */
export function ZoneNote() {
  return (
    <p className="text-[12.5px] text-text-3">
      {`Times are in your time zone (${zoneName()}); hold the pointer on one to read it in UTC, as facetdb explain prints it.`}
    </p>
  );
}
