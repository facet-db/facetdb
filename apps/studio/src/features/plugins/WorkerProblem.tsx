import { Button } from "@facetdb/ui";
import { ApiError } from "../../api/index.ts";

/**
 * What the page could not read from the worker (the mockup's "Worker not answering"): what failed,
 * the fix in one line, and Try again. A refusal is the worker's own words and fix. Where an earlier
 * read is still on the page, the lead says it could not be read "again", and that read stays shown.
 */
export function WorkerProblem({
  what,
  error,
  stale,
  retry,
}: {
  /** What could not be read, as a noun phrase: "The installed plugins". */
  readonly what: string;
  readonly error: Error;
  /** An earlier read is still shown below. */
  readonly stale: boolean;
  readonly retry: () => void;
}) {
  return (
    <div role="alert" className="mb-6 grid justify-items-start gap-2 border-l-2 border-no pl-3">
      <p className="m-0 font-bold">{`${what} could not be read${stale ? " again" : ""}.`}</p>
      <p className="m-0 max-w-[64ch] text-text-2">
        {error instanceof ApiError ? (
          `${error.message} ${error.fix}`
        ) : (
          <>
            The studio cannot reach the worker. Check that it is running (
            <code>facetdb worker</code>) and that this computer is online.
          </>
        )}
      </p>
      <Button size="small" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
