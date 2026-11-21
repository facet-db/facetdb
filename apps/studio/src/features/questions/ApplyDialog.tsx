import {
  Button,
  Dialog,
  DialogClose,
  focusBrackets,
  ScrollRegion,
  Tag,
  type TagTone,
} from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ApiError, type ApplyDiff, type ApplyReload, type SourceDraft } from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { sameDraft } from "./draft.ts";
import { NotRunning } from "./NotRunning.tsx";
import { CONFIG_KEY, projectConfigQuery } from "./queries.ts";

/**
 * Apply: the page's one `facet` action. It opens on the file's diff, asked without `confirm`
 * (nothing is written), and the write is a second step that sends the plan that very diff named, so
 * nothing is written that was not shown. One write per plan: a second click sends nothing. `force`
 * is sent only when the person ticked the choice the endpoint's own words explain. A file changed
 * since the diff (409 plan_changed) shows the new diff; every other refusal shows its message and
 * its fix.
 */

/** What a reload did to a source, in words, with the square's role. */
const OUTCOMES: Record<
  Extract<ApplyReload, { loaded: true }>["sources"][number]["outcome"],
  { readonly words: string; readonly tone: TagTone }
> = {
  restarted: { words: "restarted with the new question set", tone: "yes" },
  unchanged: { words: "unchanged", tone: "neutral" },
  kept: { words: "kept running what it ran", tone: "review" },
  "not-started": { words: "not started", tone: "review" },
  stopped: { words: "stopped", tone: "no" },
  failed: { words: "could not start anew", tone: "no" },
};

/** What the config read again after an unanswered write says of it. */
function foundWords(found: "reading" | "written" | "not-written" | "unreachable" | null): string {
  switch (found) {
    case "written":
      return "The configuration the worker runs now says what you wrote: the write went through, and the page shows it.";
    case "not-written":
      return "The configuration the worker runs now does not say what you wrote: the write did not land, or the worker has not loaded it. Look at the file and the worker's output, then ask for the diff again.";
    case "unreachable":
      return "The worker still does not answer, so whether the file was written is not known. Look at the file and the worker's output, then ask for the diff again.";
    default:
      return "Reading the configuration the worker runs now, to see whether the write went through.";
  }
}

function DiffText({ diff }: { readonly diff: ApplyDiff }) {
  const lines = diff.diff.split("\n");
  return (
    // A wide diff scrolls, and the keyboard reaches its far columns through the region.
    <ScrollRegion
      aria-label={`The changes to ${diff.path}`}
      className="max-h-[50vh] border border-hairline"
    >
      <pre className="m-0 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed">
        {lines.map((line, index) => {
          const added = line.startsWith("+") && !line.startsWith("+++");
          const removed = line.startsWith("-") && !line.startsWith("---");
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff's line is its place in the text
              key={index}
              className={`block ${added ? "bg-surface-2 text-text" : "text-text-2"} ${removed ? "line-through decoration-text-3" : ""}`}
            >
              {line === "" ? " " : line}
            </span>
          );
        })}
      </pre>
    </ScrollRegion>
  );
}

/**
 * What the written file leaves to do: a source the reload kept on what it ran, or did not start,
 * gets the block of commands above the list. The worker's own list of sources not running the file
 * says which questions to answer again; it is read again after the write, so until that read lands
 * nothing is shown, and where it cannot be read the reload's words stand alone with the install and
 * restart steps. Once it has landed the block stays through every later read (the window focused
 * again, back from the terminal) and follows what each one says: a command is not taken from under
 * the pointer while the list is asked for anew. A read that fails after one that landed changes
 * nothing: the list as last read stands, and a source it no longer named is not said to be waiting
 * again.
 */
function NotRunningFromReload({
  sources,
}: {
  readonly sources: Extract<ApplyReload, { loaded: true }>["sources"];
}) {
  const api = useApi();
  const config = useQuery(projectConfigQuery(api));
  // The write's own read is under way when this first renders (Apply asks for it before it shows
  // the outcome), so the list held until it settles is from before the write: `waiting`. Then the
  // list was `read` since the write, or it is still `unread` because every read since has failed.
  const [list, setList] = useState<"waiting" | "read" | "unread">("waiting");
  if (!config.isFetching) {
    const now = config.isError && list !== "read" ? "unread" : "read";
    if (now !== list) {
      setList(now);
    }
  }
  if (list === "waiting") {
    return null;
  }
  const waiting = sources.filter(
    (source) => source.outcome === "kept" || source.outcome === "not-started",
  );
  return waiting.map((source) => {
    const entry =
      list === "read"
        ? config.data?.pending.find((candidate) => candidate.source === source.source)
        : undefined;
    if (entry !== undefined) {
      return (
        <NotRunning
          key={source.source}
          source={entry.source}
          outcome={entry.outcome}
          why={entry.message}
          migrate={entry.migrate}
          added={entry.added}
          checkAgain={entry.checkAgain}
        />
      );
    }
    // The list was read and no longer names it: the worker runs the file now. Never read since the
    // write: say what the reload said, with the steps every such source takes.
    return list === "unread" ? (
      <NotRunning
        key={source.source}
        source={source.source}
        outcome={source.outcome === "kept" ? "kept" : "not-started"}
        why={source.message ?? "the worker does not run the change yet."}
        migrate
        added={[]}
        checkAgain={false}
      />
    ) : null;
  });
}

function Reloaded({ reload }: { readonly reload: ApplyReload }) {
  if (!reload.loaded) {
    return (
      <p role="alert" className="m-0 grid gap-1 border-l-2 border-no pl-3">
        <span>{reload.message}</span>
        <span className="text-text-2">{reload.fix}</span>
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      <NotRunningFromReload sources={reload.sources} />
      <ul className="m-0 grid list-none gap-2 p-0">
        {reload.sources.map((source) => {
          const outcome = OUTCOMES[source.outcome];
          return (
            <li key={source.source} className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <strong>{source.source}</strong>
                <Tag tone={outcome.tone}>{outcome.words}</Tag>
              </span>
              {source.message === null ? null : (
                <span className="text-text-2">{source.message}</span>
              )}
            </li>
          );
        })}
      </ul>
      {reload.notes.map((note) => (
        <p key={note} className="m-0 text-text-2">
          {note}
        </p>
      ))}
    </div>
  );
}

function ApplyBody({
  source,
  draft,
  opened,
  changedQuestions,
}: {
  readonly source: string;
  readonly draft: SourceDraft;
  /** This opening of the dialog: each one asks a fresh diff. */
  readonly opened: number;
  /** The questions whose wording the draft changes or adds: what a backfill would re-answer. */
  readonly changedQuestions: readonly string[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const id = useId();
  // The draft as it was when the dialog opened: the diff and the write are of the same one.
  const [asked] = useState(draft);
  const [attempt, setAttempt] = useState(0);
  const [moved, setMoved] = useState(false);
  const [force, setForce] = useState(false);
  /** After a write nobody answered: what the config read again says of it. */
  const [found, setFound] = useState<"reading" | "written" | "not-written" | "unreachable" | null>(
    null,
  );
  const diff = useQuery({
    queryKey: ["questions", "apply-diff", opened, attempt],
    queryFn: () => api.applyDiff(asked),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const write = useMutation({
    mutationFn: (confirm: { readonly plan: string; readonly force: boolean }) =>
      api.applyWrite(asked, confirm),
    onSuccess: () => {
      // The worker reloaded: the config and every source list are read again; the draft follows
      // the config when it says what was written (draft.ts, `reconcile`).
      void queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
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
            // A new diff is a new confirmation, even when its plan has the same name.
            sent.current = null;
            setMoved(true);
            setForce(false);
            write.reset();
            setAttempt((count) => count + 1);
          } else if (error instanceof ApiError && error.code === "uncommitted_changes") {
            // Nothing was written: the person may confirm again, choosing to replace the file.
            sent.current = null;
          } else if (!(error instanceof ApiError)) {
            // No answer: the write may have landed. Read the config the worker runs now (the page
            // reconciles the draft with it) and say what it holds.
            setFound("reading");
            void queryClient.fetchQuery({ ...projectConfigQuery(api), staleTime: 0 }).then(
              (config) => {
                const now = config.sources.find((candidate) => candidate.name === asked.name);
                setFound(now !== undefined && sameDraft(now, asked) ? "written" : "not-written");
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
      {data === undefined || diff.isFetching ? null : (
        <>
          <p className="m-0 text-text-2">
            {`This writes ${data.path}. The worker reloads it and answers records from now on with the draft of ${source}.`}
          </p>
          {data.changed ? (
            <>
              <p className="m-0 text-text-2">
                Apply writes the whole file in FacetDB's own form, as the diff shows: comments and
                code of your own in it do not stay.
              </p>
              <DiffText diff={data} />
              <p className="m-0 text-[12.5px] text-text-2">
                {changedQuestions.length === 0
                  ? "No question's wording changes, so no record is asked again."
                  : `Records already answered keep their answers. Re-answering them is a separate step, with its estimate shown first: facetdb backfill --source ${source} --question ${changedQuestions.join(",")}.`}
              </p>
            </>
          ) : (
            <p className="m-0">{`The draft changes nothing in ${data.path}.`}</p>
          )}
        </>
      )}
      {offerForce && written === undefined && data?.changed === true && !diff.isFetching ? (
        <div className="grid gap-2">
          {refusedUncommitted ? (
            <Problem error={writeError} />
          ) : uncommitted === null ? null : (
            <p className="m-0 grid gap-1 border-l-2 border-review pl-3">
              <span>{uncommitted.message}</span>
              <span className="text-text-2">{uncommitted.fix}</span>
            </p>
          )}
          <span
            className={`${focusBrackets} relative inline-flex w-fit has-[:focus-visible]:after:opacity-100!`}
          >
            <input
              id={`${id}-force`}
              type="checkbox"
              className="accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
              checked={force}
              onChange={(event) => {
                setForce(event.target.checked);
              }}
            />
            <label htmlFor={`${id}-force`} className="pl-2">
              {`Replace ${data.path} anyway: git keeps no copy of it as it is now`}
            </label>
          </span>
        </div>
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
            {`Written. ${written.path} holds the draft, and the worker reloaded it:`}
          </p>
          <Reloaded reload={written.reload} />
        </div>
      ) : (
        <p
          role="status"
          className="m-0"
        >{`Nothing was written: ${written.path} already says this.`}</p>
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
            disabled={write.isPending || (writeError !== null && !refusedUncommitted)}
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

export function ApplyDialog({
  source,
  draft,
  changedQuestions,
  open,
  opened,
  onOpenChange,
}: {
  readonly source: string;
  readonly draft: SourceDraft;
  readonly changedQuestions: readonly string[];
  readonly open: boolean;
  /** How many times the dialog has opened: each opening asks a fresh diff. */
  readonly opened: number;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      title="Apply this draft"
      trigger={<Button variant="primary">Apply</Button>}
      open={open}
      onOpenChange={onOpenChange}
    >
      <ApplyBody
        key={opened}
        source={source}
        draft={draft}
        opened={opened}
        changedQuestions={changedQuestions}
      />
    </Dialog>
  );
}
