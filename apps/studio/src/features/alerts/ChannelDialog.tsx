import { Button, Dialog, DialogClose } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type AlertChannel,
  type AlertChannelEntry,
  type AlertsDraft,
  ApiError,
  type ApplyWritten,
} from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { CommandLine, DiffText, ReplaceAnyway } from "../questions/index.ts";
import {
  ChannelFields,
  FormActions,
  KindField,
  type KindOption,
  kindValue,
  NotInstalled,
} from "./ChannelForm.tsx";
import {
  type ChannelChange,
  type ChannelForm,
  draftOf,
  formOfEntry,
  hasProblems,
  indexInFile,
  newForm,
  placeOf,
  problemsOf,
} from "./draft.ts";
import { channelPluginsQuery, channelsToAddQuery } from "./queries.ts";
import { channelTitle } from "./words.ts";

/**
 * Add a channel, and Edit one: one dialog that opens on the form and moves to Apply's diff, as the
 * mockup's two dialogs do, Back returning to the form as it was left. The change is a project
 * draft's `alerts`, built over the channels as facetdb.config.ts writes them; nothing is written
 * before the diff was shown, and the write sends the plan that very diff named. The worker reloads
 * the file and puts the channels in force with no restart; the page says so, or says why not in the
 * reload's own words.
 */

export type ChannelDialogMode =
  | { readonly kind: "add" }
  /** A listed channel, and its place in the list (how one whose address is withheld is found). */
  | { readonly kind: "edit"; readonly channel: AlertChannel; readonly position: number };

type Step = { readonly kind: "form" } | { readonly kind: "diff"; readonly change: ChannelChange };

/** The channel a change is about, named as the list names it. */
function titleOf(change: ChannelChange, mode: ChannelDialogMode): string {
  if (mode.kind === "edit") {
    return channelTitle(mode.channel);
  }
  const form = change.kind === "remove" ? undefined : change.form;
  return channelTitle({ kind: form?.kind ?? "unknown", name: form?.where?.trim() ?? null });
}

/** The dialog's heading at the diff: what the write does, to which channel. */
function diffHeading(change: ChannelChange, title: string): string {
  switch (change.kind) {
    case "add":
      return `Add ${title}`;
    case "edit":
      return `Change ${title}`;
    case "remove":
      return `Remove ${title}`;
  }
}

/** What the page says once the reload put the change in force. */
function writtenWords(change: ChannelChange, title: string): string {
  switch (change.kind) {
    case "add":
      return `Written. ${title} is in force.`;
    case "edit":
      return `Written. ${title}'s changes are in force.`;
    case "remove":
      return `Written. ${title} is removed.`;
  }
}

/**
 * Apply's step: the diff asked without `confirm` (nothing is written), then the write of the plan
 * it named. One write per plan; `force` only once the person ticked it; a file changed since the
 * diff shows the new diff; a write the worker did not answer is said, and the diff can be asked again.
 */
function ApplyStep({
  draft,
  onBack,
  onWritten,
}: {
  readonly draft: AlertsDraft;
  readonly onBack: () => void;
  /** The write landed: the reload's outcome, for the page to say. */
  readonly onWritten: (written: Extract<ApplyWritten, { written: true }>) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [moved, setMoved] = useState(false);
  const [force, setForce] = useState(false);
  const sent = useRef<string | null>(null);
  const diff = useQuery({
    queryKey: ["alert-channels", "diff", JSON.stringify(draft), attempt],
    queryFn: () => api.applyAlertsDiff(draft),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const write = useMutation({
    mutationFn: (confirm: { readonly plan: string; readonly force: boolean }) =>
      api.applyAlertsWrite(draft, confirm),
    onSuccess: (written) => {
      // The file is written and the worker reloaded it: the channels and the file are read again.
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      if (written.written && written.reload.loaded) {
        onWritten(written);
      }
    },
  });
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
            // Nothing was written: the diff as the file is now, to be read and confirmed anew.
            sent.current = null;
            setMoved(true);
            setForce(false);
            write.reset();
            setAttempt((count) => count + 1);
          } else if (error instanceof ApiError && error.code === "uncommitted_changes") {
            sent.current = null;
          }
        },
      },
    );
  };

  const data = diff.data;
  const writeError = write.error;
  const refusedUncommitted =
    writeError instanceof ApiError && writeError.code === "uncommitted_changes";
  const unknownOutcome = writeError !== null && !(writeError instanceof ApiError);
  const uncommitted = data?.uncommitted ?? null;
  const offerForce = uncommitted !== null || refusedUncommitted;
  const written = write.data;
  const reading = diff.isFetching;
  return (
    <div className="grid gap-4.5">
      {reading ? (
        <p role="status" className="m-0 text-text-2">
          Reading facetdb.config.ts and making the diff
        </p>
      ) : null}
      {diff.isError ? <Problem error={diff.error} /> : null}
      {moved && data !== undefined && !reading ? (
        <p role="alert" className="m-0 border-l-2 border-review pl-3">
          {`${data.path} changed since the diff you read, so nothing was written. This is the diff now.`}
        </p>
      ) : null}
      {data === undefined || reading ? null : data.changed ? (
        <>
          <p className="m-0 text-text-2">{`Writes ${data.path}. In force at once, with no restart.`}</p>
          <DiffText diff={data} />
        </>
      ) : (
        <p className="m-0">{`${data.path} already says this, so there is nothing to write.`}</p>
      )}
      {offerForce && written === undefined && data?.changed === true && !reading ? (
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
          <span className="text-text-2">
            Whether it was written is not known. The channels above are read again; ask for the diff
            again to see the file as it is now.
          </span>
        </p>
      ) : null}
      {written === undefined ? null : !written.written ? (
        <p role="status" className="m-0">
          {`Nothing was written: ${written.path} already says this.`}
        </p>
      ) : written.reload.loaded ? null : (
        <p role="alert" className="m-0 grid gap-1 border-l-2 border-no pl-3">
          <span>{`${written.path} was written, but the worker keeps the channels it had. ${written.reload.message}`}</span>
          <span className="text-text-2">{written.reload.fix}</span>
        </p>
      )}
      <div className="fdb-dialog-actions">
        {written === undefined ? (
          <Button variant="quiet" onClick={onBack} disabled={write.isPending}>
            Back
          </Button>
        ) : (
          <DialogClose asChild>
            <Button variant="quiet">Close</Button>
          </DialogClose>
        )}
        {unknownOutcome ? (
          <Button
            variant="primary"
            onClick={() => {
              write.reset();
              sent.current = null;
              setAttempt((count) => count + 1);
            }}
          >
            Ask for the diff again
          </Button>
        ) : null}
        {data?.changed === true && written === undefined && !unknownOutcome && !reading ? (
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

export function ChannelDialog({
  mode,
  open,
  onOpenChange,
  entries,
  entriesFailed,
  fileDiffers,
  workerZone,
  onWritten,
}: {
  readonly mode: ChannelDialogMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The channels in force, as the config in force writes them; undefined while they are read. */
  readonly entries: readonly AlertChannelEntry[] | undefined;
  /** The read of the file's channels failed, and none was read before. */
  readonly entriesFailed: boolean;
  /** facetdb.config.ts names other channels than the ones in force: no draft until Check again. */
  readonly fileDiffers: boolean;
  readonly workerZone: string | null;
  /** The write landed and the reload put it in force: the words the page says. */
  readonly onWritten: (words: string) => void;
}) {
  const api = useApi();
  const plugins = useQuery(channelPluginsQuery(api));
  const toAdd = useQuery({ ...channelsToAddQuery(api), enabled: mode.kind === "add" });
  const [step, setStep] = useState<Step>({ kind: "form" });
  /** The form as the person left it; null until they change a field (the file's channel stands). */
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  /** Each refused Apply: the focus then goes to the first field with a problem. */
  const [refusals, setRefusals] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  /** The edited channel's place in the file's list; -1 when the file no longer lists it so. */
  const index =
    mode.kind === "edit" && entries !== undefined
      ? indexInFile(entries, mode.channel, mode.position)
      : undefined;
  const editEntry = index === undefined ? undefined : entries?.[index];

  const kinds: readonly KindOption[] = [
    ...(plugins.data ?? []).map((plugin) => ({ kind: plugin.name, installed: true as const })),
    ...(toAdd.data ?? []).map((entry) => ({
      kind: entry.kind,
      installed: false as const,
      command: entry.command,
    })),
  ];
  // The add form opens on the first kind the worker hosts; the person's choice wins once made.
  const first = kinds[0];
  const kindChosen = chosen ?? (first === undefined ? null : kindValue(first));
  const option =
    mode.kind === "add" ? kinds.find((each) => kindValue(each) === kindChosen) : undefined;
  /** The kind chosen has no plugin here: its command stands instead of the form. */
  const notInstalled = option !== undefined && !option.installed ? option : undefined;
  const current: ChannelForm | null =
    mode.kind === "edit"
      ? (form ??
        (editEntry === undefined ? null : formOfEntry(editEntry, mode.channel.name === null)))
      : option === undefined || !option.installed
        ? null
        : form !== null && form.kind === option.kind
          ? form
          : newForm(option.kind);
  const plugin = plugins.data?.find((each) => each.name === current?.kind);
  const place = placeOf(plugin);
  const problems = current === null || !tried ? {} : problemsOf(current, place.label, workerZone);

  // After a refused Apply, the focus goes to the first field with a problem.
  useEffect(() => {
    if (refusals > 0) {
      formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
    }
  }, [refusals]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (current === null || entries === undefined) {
      return;
    }
    setTried(true);
    if (hasProblems(problemsOf(current, place.label, workerZone))) {
      setRefusals((count) => count + 1);
      return;
    }
    if (mode.kind === "add") {
      setStep({ kind: "diff", change: { kind: "add", form: current } });
    } else if (index !== undefined && index >= 0) {
      setStep({ kind: "diff", change: { kind: "edit", index, form: current } });
    }
  };

  const formTitle = mode.kind === "add" ? "Add a channel" : `Edit ${channelTitle(mode.channel)}`;
  const title =
    step.kind === "diff" ? diffHeading(step.change, titleOf(step.change, mode)) : formTitle;
  const lost = index === -1;

  return (
    <Dialog title={title} open={open} onOpenChange={onOpenChange}>
      {fileDiffers && step.kind === "form" ? (
        // The draft is built over the channels in force: one the file adds by hand, not yet in
        // force, would be dropped from the whole list. The file is read again first.
        <div className="grid gap-4.5">
          <p role="alert" className="m-0 border-l-2 border-review pl-3">
            facetdb.config.ts names other channels than the ones in force: press Check again first.
          </p>
          <div className="fdb-dialog-actions">
            <DialogClose asChild>
              <Button>Close</Button>
            </DialogClose>
          </div>
        </div>
      ) : step.kind === "diff" && entries !== undefined ? (
        <ApplyStep
          draft={draftOf(entries, step.change)}
          onBack={() => {
            setStep({ kind: "form" });
          }}
          onWritten={() => {
            onWritten(writtenWords(step.change, titleOf(step.change, mode)));
            onOpenChange(false);
          }}
        />
      ) : (
        <form ref={formRef} noValidate onSubmit={apply} className="grid gap-4.5">
          {mode.kind === "add" ? (
            plugins.isPending ? (
              <p role="status" className="m-0 text-text-2">
                Reading the channel kinds.
              </p>
            ) : kinds.length === 0 ? (
              <NoKind failed={plugins.isError} />
            ) : (
              <KindField
                kinds={kinds}
                value={kindChosen ?? ""}
                onChange={(value) => {
                  setChosen(value);
                  setTried(false);
                }}
              />
            )
          ) : null}
          {lost ? (
            <p role="alert" className="m-0 border-l-2 border-no pl-3">
              This channel is no longer in facetdb.config.ts as listed. Close, and open it again
              from the list.
            </p>
          ) : null}
          {notInstalled !== undefined ? (
            <NotInstalled kind={notInstalled.kind} command={notInstalled.command} />
          ) : current === null ? null : (
            <ChannelFields
              form={current}
              onChange={setForm}
              place={place}
              problems={problems}
              workerZone={workerZone}
            />
          )}
          {entries !== undefined || notInstalled !== undefined ? null : entriesFailed ? (
            <p role="alert" className="m-0 border-l-2 border-no pl-3">
              The channels in facetdb.config.ts could not be read. Close, and try again in a moment.
            </p>
          ) : (
            <p role="status" className="m-0 text-text-2">
              Reading the channels in facetdb.config.ts.
            </p>
          )}
          {current === null || notInstalled !== undefined ? (
            <div className="fdb-dialog-actions">
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
            </div>
          ) : (
            <FormActions
              onRemove={
                index === undefined || index < 0
                  ? null
                  : () => {
                      setStep({ kind: "diff", change: { kind: "remove", index } });
                    }
              }
              onCancel={() => {
                onOpenChange(false);
              }}
              applyDisabled={entries === undefined}
            />
          )}
        </form>
      )}
    </Dialog>
  );
}

/** No channel plugin is hosted, and the registry offered none: the way to get one. */
function NoKind({ failed }: { readonly failed: boolean }) {
  return (
    <div className="grid gap-2">
      <p className="m-0">
        {failed
          ? "The channel plugins could not be read. Close, and try again in a moment."
          : "No channel plugin is installed. Run this in the project's folder:"}
      </p>
      {failed ? null : <CommandLine command="facetdb add slack" />}
    </div>
  );
}
