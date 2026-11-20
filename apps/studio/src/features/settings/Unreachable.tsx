import { Button } from "@facetdb/ui";
import { ApiError } from "../../api/index.ts";
import { whenWords } from "../decisions/index.ts";

/**
 * Why what a page shows is not current. TanStack keeps a query's last good answer when a refresh
 * fails, so a page that reads the worker says so: the worker's words and the fix when it refused,
 * plain words when it could not be reached, and "Last known" with the time of the last good answer
 * when there is one. Shown whether or not an earlier answer is on the page.
 */
export function Unreachable({
  what,
  error,
  lastKnownAt,
  now,
  retry,
}: {
  /** What the page could not read, as a noun phrase: "The reviewer accounts". */
  readonly what: string;
  readonly error: Error;
  /** When the last good answer arrived (epoch ms); undefined when there never was one. */
  readonly lastKnownAt: number | undefined;
  readonly now: Date;
  readonly retry: () => void;
}) {
  const refused = error instanceof ApiError;
  const lead =
    lastKnownAt === undefined
      ? `${what} could not be read.`
      : `${refused ? "The worker refused the last refresh" : "The worker could not be reached"}. Last known ${whenWords(new Date(lastKnownAt), now)}.`;
  return (
    <div role="alert" className="grid justify-items-start gap-2 border-l-2 border-no pl-3">
      <p className="font-bold">{lead}</p>
      <p className="max-w-[64ch] text-text-2">
        {refused
          ? `${error.message} ${error.fix}`
          : "The studio cannot reach the worker. Check that the worker is still running and that this computer is online."}
      </p>
      <Button size="small" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
