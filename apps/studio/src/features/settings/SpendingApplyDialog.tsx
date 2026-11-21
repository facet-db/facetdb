import { Button, Dialog, DialogClose } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, homeQuery, type SpendingDraft, spendingConfigQuery } from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { DiffText, Reloaded, ReplaceAnyway } from "../questions/index.ts";

/**
 * Settings' save of the spending cap, as the Questions page's Apply works: the dialog opens on the
 * diff the draft makes to facetdb.config.ts, asked without `confirm` (nothing is written), and the
 * write is the second step that sends the plan that diff named. One write per plan; `force` only
 * when the person ticked it; a file changed since the diff shows the new diff. The write's reload
 * puts the cap in force at once: after it the `config` and `home` queries are read again, so the
 * figures above show the new cap. A cap below this month's usage pauses the project as soon as it
 * lands, and the dialog says so before the write.
 */

type Found = "reading" | "written" | "not-written" | "unreachable" | null;

/** What the cap read again after an unanswered write says of it. */
function foundWords(found: Found): string {
  switch (found) {
    case "written":
      return "facetdb.config.ts now sets the cap you saved: the write went through. If the cap the worker enforces does not show it, press Apply the file's cap above.";
    case "not-written":
      return "facetdb.config.ts does not set the cap you saved: the write did not land. Look at the file and the worker's output, then save again.";
    case "unreachable":
      return "The worker still does not answer, so whether the file was written is not known. Look at the file and the worker's output, then save again.";
    default:
      return "Reading the cap in facetdb.config.ts again, to see whether the write went through.";
  }
}

function SpendingApplyBody({
  draft,
  opened,
}: {
  readonly draft: SpendingDraft;
  /** This opening of the dialog: each one asks a fresh diff. */
  readonly opened: number;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [moved, setMoved] = useState(false);
  const [force, setForce] = useState(false);
  const [found, setFound] = useState<Found>(null);
  const diff = useQuery({
    queryKey: ["settings", "spending-diff", opened, attempt],
    queryFn: () => api.applySpendingDiff(draft),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const write = useMutation({
    mutationFn: (confirm: { readonly plan: string; readonly force: boolean }) =>
      api.applySpendingWrite(draft, confirm),
    onSuccess: () => {
      // The file is written and the worker reloaded it, taking the cap up: the cap the file sets,
      // the project JSON the other pages read, and the cap in force are read again.
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["home"] });
    },
  });
  /** This month's usage, to say when the cap saved is already behind it. */
  const spent = useQuery(homeQuery(api)).data?.spending.inputTokens;
  const behind =
    draft.spendingCap !== null && spent !== undefined && spent >= draft.spendingCap
      ? draft.onCapReached === "pause"
        ? "This month's usage is already past this cap, so the project pauses as soon as it is applied, until the month resets or the cap is raised."
        : "This month's usage is already past this cap; the project keeps answering, as the choice says, and the cap's alerts go out."
      : null;
  /** The plan whose write was sent: one confirmation, one write. */
  const sent = useRef<string | null>(null);

  const confirm = (plan: string) => {
    if (sent.current === plan) {
      return;
    }
    sent.current = plan;
    write.mutate(
      { plan, force },
      {
        onError: (error) => {
          if (error instanceof ApiError && error.code === "plan_changed") {
            // Nothing was written: show the diff as the file is now, to be read and confirmed anew.
            sent.current = null;
            setMoved(true);
            setForce(false);
            write.reset();
            setAttempt((count) => count + 1);
          } else if (error instanceof ApiError && error.code === "uncommitted_changes") {
            sent.current = null;
          } else if (!(error instanceof ApiError)) {
            // No answer: the write may have landed. Read what the file sets now and say so.
            setFound("reading");
            void queryClient.fetchQuery({ ...spendingConfigQuery(api), staleTime: 0 }).then(
              (file) => {
                setFound(
                  file.tokens === draft.spendingCap && file.onCapReached === draft.onCapReached
                    ? "written"
                    : "not-written",
                );
              },
              () => {
                setFound("unreachable");
              },
            );
          }
        },
      },
    );
  };

  const writeError = write.error;
  const refusedUncommitted =
    writeError instanceof ApiError && writeError.code === "uncommitted_changes";
  const unknownOutcome = writeError !== null && !(writeError instanceof ApiError);
  const data = diff.data;
  const uncommitted = data?.uncommitted ?? null;
  const offerForce = uncommitted !== null || refusedUncommitted;
  const written = write.data;

  return (
    <div className="grid gap-4.5">
      {diff.isFetching ? (
        <p role="status" className="m-0 text-text-2">
          Reading facetdb.config.ts and making the diff
        </p>
      ) : null}
      {diff.isError ? <Problem error={diff.error} /> : null}
      {moved && data !== undefined && !diff.isFetching ? (
        <p role="alert" className="m-0 border-l-2 border-review pl-3">
          {`${data.path} changed since the diff you read, so nothing was written. This is the diff now: read it before writing.`}
        </p>
      ) : null}
      {data === undefined || diff.isFetching ? null : data.changed ? (
        <>
          <p className="m-0 text-text-2">
            The worker uses this cap as soon as it is applied.
            {behind === null ? "" : ` ${behind}`}
          </p>
          <DiffText diff={data} />
        </>
      ) : (
        <p className="m-0">{`${data.path} already sets this cap, so there is nothing to write.`}</p>
      )}
      {offerForce && written === undefined && data?.changed === true && !diff.isFetching ? (
        <ReplaceAnyway
          state={uncommitted?.state ?? null}
          refused={refusedUncommitted}
          checked={force}
          onChange={setForce}
        />
      ) : null}
      <p role="status" className="m-0 text-text-2">
        {write.isPending ? "Writing the file and reloading the worker" : ""}
      </p>
      {writeError !== null && !refusedUncommitted && !unknownOutcome ? (
        <Problem error={writeError} />
      ) : null}
      {unknownOutcome ? (
        <p role="alert" className="m-0 grid gap-1 border-l-2 border-no pl-3">
          <span>{`The worker did not answer the write of ${data?.path ?? "the file"}.`}</span>
          <span className="text-text-2">{foundWords(found)}</span>
        </p>
      ) : null}
      {written === undefined ? null : written.written ? (
        <div className="grid gap-2">
          <p role="status" className="m-0">
            Applied. The worker uses the new cap now.
          </p>
          <Reloaded reload={written.reload} />
        </div>
      ) : (
        <p role="status" className="m-0">
          {`Nothing was written: ${written.path} already sets this cap.`}
        </p>
      )}
      <div className="fdb-dialog-actions">
        <DialogClose asChild>
          <Button variant="quiet">{written === undefined ? "Cancel" : "Close"}</Button>
        </DialogClose>
        {unknownOutcome ? (
          <Button
            variant="primary"
            onClick={() => {
              write.reset();
              sent.current = null;
              setFound(null);
              setAttempt((count) => count + 1);
            }}
          >
            Ask for the diff again
          </Button>
        ) : null}
        {data?.changed === true && written === undefined && !unknownOutcome && !diff.isFetching ? (
          <Button
            variant="primary"
            disabled={
              write.isPending ||
              (writeError !== null && !refusedUncommitted) ||
              (offerForce && !force)
            }
            onClick={() => {
              confirm(data.plan);
            }}
          >
            Apply
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The dialog Save opens: no trigger of its own, since Save first checks the form. */
export function SpendingApplyDialog({
  draft,
  open,
  opened,
  onOpenChange,
}: {
  readonly draft: SpendingDraft;
  readonly open: boolean;
  /** How many times the dialog has opened: each opening asks a fresh diff. */
  readonly opened: number;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog title="Save the spending cap" open={open} onOpenChange={onOpenChange}>
      <SpendingApplyBody key={opened} draft={draft} opened={opened} />
    </Dialog>
  );
}
