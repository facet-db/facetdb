import { Button, Dialog, DialogClose } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, type PluginsDraft } from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { DiffText, Reloaded, ReplaceAnyway } from "../questions/index.ts";
import { INSTALLED_PLUGINS_KEY, installedPluginsQuery } from "./queries.ts";

/**
 * A plugin's settings saved as Settings saves the spending cap: the dialog opens on the diff the
 * draft makes to facetdb.config.ts, asked without `confirm` (nothing is written), and the write is
 * the second step that sends the plan that diff named. One write per plan; `force` only when the
 * person ticked it; a file changed since the diff shows the new diff. The reload after the write
 * puts the settings in force with no restart and says so in its own words; the plugins are then
 * read again.
 */

type Found = "reading" | "written" | "not-written" | "unreachable" | null;

/** What the plugins read again after an unanswered write say of it. */
function foundWords(found: Found): string {
  switch (found) {
    case "written":
      return "The worker runs these settings now: the write went through.";
    case "not-written":
      return "The worker does not run these settings: the write did not land, or the reload refused them. Look at the file and the worker's output, then apply again.";
    case "unreachable":
      return "The worker still does not answer, so whether the file was written is not known. Look at the file and the worker's output, then apply again.";
    default:
      return "Reading the plugin's settings again, to see whether the write went through.";
  }
}

function PluginApplyBody({
  plugin,
  draft,
  opened,
}: {
  /** The plugin's key in `plugins`. */
  readonly plugin: string;
  readonly draft: PluginsDraft;
  readonly opened: number;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [moved, setMoved] = useState(false);
  const [force, setForce] = useState(false);
  const [found, setFound] = useState<Found>(null);
  const diff = useQuery({
    queryKey: ["plugins", "apply-diff", plugin, opened, attempt],
    queryFn: () => api.applyPluginsDiff(draft),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const write = useMutation({
    mutationFn: (confirm: { readonly plan: string; readonly force: boolean }) =>
      api.applyPluginsWrite(draft, confirm),
    onSuccess: () => {
      // The file is written and the worker reloaded it: the plugins as it runs them now, and the
      // project JSON the other pages read.
      void queryClient.invalidateQueries({ queryKey: INSTALLED_PLUGINS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });
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
            // No answer: the write may have landed. Read what the worker runs now and say so.
            setFound("reading");
            void queryClient.fetchQuery({ ...installedPluginsQuery(api), staleTime: 0 }).then(
              (installed) => {
                const now = installed.plugins.find((one) => one.key === plugin);
                setFound(
                  now !== undefined &&
                    JSON.stringify(now.settings.values) === JSON.stringify(draft[plugin])
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
            {`Writes ${data.path}. The worker reloads it with no restart.`}
          </p>
          <DiffText diff={data} />
        </>
      ) : (
        <p className="m-0">{`${data.path} already holds these settings, so there is nothing to write.`}</p>
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
            Written.
          </p>
          <Reloaded reload={written.reload} />
        </div>
      ) : (
        <p role="status" className="m-0">
          {`Nothing was written: ${written.path} already holds these settings.`}
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
            {`Write ${data.path}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The dialog Apply opens on a plugin's settings: no trigger of its own, the form's Apply opens it. */
export function PluginApplyDialog({
  name,
  plugin,
  draft,
  opened,
  onOpenChange,
}: {
  /** The plugin's short name, for the title. */
  readonly name: string;
  /** Its key in `plugins`. */
  readonly plugin: string;
  readonly draft: PluginsDraft;
  /** How many times the dialog has opened: each opening asks a fresh diff. */
  readonly opened: number;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog title={`Apply ${name}'s settings`} open onOpenChange={onOpenChange}>
      <PluginApplyBody key={opened} plugin={plugin} draft={draft} opened={opened} />
    </Dialog>
  );
}
