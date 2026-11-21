import { Button, ScrollRegion } from "@facetdb/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ApiError, type Migrated, type MigratePlan } from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { ConnectionField, type InstallFailure, installFailure } from "../setup/index.ts";
import { BackfillControls } from "../sources/index.ts";
import { CONFIG_KEY } from "./queries.ts";

/**
 * An added question installed from the page, opened from the block of a source that is written and
 * not running (NotRunning), where the worker's own routes are open to this browser: the operator on
 * the worker's machine, no sign-in. The admin connection string goes in the setup's masked box, for
 * this one install; "Show the SQL" asks the worker for the install exactly as `facetdb migrate
 * --source <name> --dry-run` prints it, and the one button runs only that, once it is on the page.
 * The worker then reloads, and the outcome is said in its words: running with version N (and the
 * block goes), stopped with what ran and what stays, or not known, with what to look at.
 *
 * The string lives in this component's state and nowhere else: not in a query's cache (the calls
 * are mutations whose variables hold no part of it), not in an address, not in storage. Changing it
 * takes the SQL off the page; closing the panel or the dialog drops it; a finished install clears it.
 */

/** The questions in a sentence: "is_vehicle", "is_vehicle and colour". */
function namesOf(questions: readonly string[]): string {
  return questions.length <= 1
    ? (questions[0] ?? "")
    : `${questions.slice(0, -1).join(", ")} and ${questions.at(-1) ?? ""}`;
}

function capitalized(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

/** What the reload after the install says of `source`, and whether the source now runs it. */
function installedWords(
  done: Migrated,
  source: string,
): { readonly running: boolean; readonly words: string } {
  const reload = done.reload;
  if (!reload.loaded) {
    return {
      running: false,
      words: `Installed on ${done.table}. ${capitalized(reload.message)}. ${reload.fix}`,
    };
  }
  const entry = reload.sources.find((candidate) => candidate.source === source);
  if (entry?.outcome === "restarted" && entry.version !== null) {
    return {
      running: true,
      words: `Installed on ${done.table}. ${source} answers with version ${entry.version} now: ${entry.message ?? "the worker switched it."}`,
    };
  }
  return {
    running: false,
    words: `Installed on ${done.table}. ${entry?.message === null || entry === undefined ? "The worker read facetdb.config.ts again." : capitalized(entry.message)}`,
  };
}

/**
 * What an install from the page left, kept by the page after the block goes: the reload's words,
 * and, when the source runs the new set, the backfill of the questions added, since the records
 * that were there before have no answer for them.
 */
export type Installed = {
  readonly words: string;
  /** The source runs the new set: the added questions to answer the existing records with. */
  readonly backfill: { readonly source: string; readonly questions: readonly string[] } | null;
};

function noteOf(done: Migrated, source: string, questions: readonly string[]): Installed {
  const { running, words } = installedWords(done, source);
  return { words, backfill: running ? { source, questions } : null };
}

/** The install's outcome in words, with the offer to answer the existing records where it applies. */
export function InstalledNote({ note }: { readonly note: Installed }) {
  return (
    <div className="grid gap-3 border-l-2 border-yes pl-3">
      <p role="status" className="m-0 max-w-[64ch]">
        {note.words}
      </p>
      {note.backfill === null ? null : (
        <>
          <p className="m-0 max-w-[64ch]">
            {`The records that were in ${note.backfill.source} before have no answer for ${namesOf(note.backfill.questions)} yet: answering them shows the estimate first.`}
          </p>
          <BackfillControls source={note.backfill.source} questions={note.backfill.questions} />
        </>
      )}
    </div>
  );
}

/** What a run that failed left, in the page's words: never "nothing changed" when it may have. */
function failureWords(failed: InstallFailure, source: string): { title: string; error: Error } {
  switch (failed.kind) {
    case "nothing-ran":
      return { title: "Nothing ran.", error: failed.error };
    case "stopped":
      return { title: "The install stopped.", error: failed.error };
    case "unknown":
      return {
        title: "Whether the install ran is not known.",
        error:
          failed.error instanceof ApiError
            ? failed.error
            : new ApiError(
                0,
                "no_answer",
                `The worker did not answer the install, so it may have run, in whole or not at all; ${source} keeps answering with the version it ran until the worker reloads.`,
                `Look before anything else: run facetdb migrate --source ${source} --dry-run on the machine that runs the worker. Then show the SQL here again.`,
              ),
      };
  }
}

export function InstallQuestion({
  source,
  questions,
  onInstalled,
  onClose,
}: {
  readonly source: string;
  /** The questions the file adds to the source, as the worker's list names them. */
  readonly questions: readonly string[];
  /** The install ran and the worker reloaded: what it left, for after the block goes. */
  readonly onInstalled: (note: Installed) => void;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [shown, setShown] = useState<MigratePlan | null>(null);
  const [failed, setFailed] = useState<InstallFailure | null>(null);
  const [done, setDone] = useState<Migrated | null>(null);
  /** An install was started and did not finish as asked: never "nothing changed" from then on. */
  const [started, setStarted] = useState(false);
  /** The token whose run was sent: one confirmation, one run. */
  const sent = useRef<string | null>(null);

  // `gcTime: 0` on both: TanStack keeps a finished mutation's options, this closure over the admin
  // string included, in its cache for five minutes otherwise, past the dialog's close.
  const plan = useMutation({
    gcTime: 0,
    mutationFn: () => api.migratePlan(source, typed),
    onSuccess: (planned) => {
      setShown(planned);
    },
  });
  const run = useMutation({
    gcTime: 0,
    mutationFn: (token: string) => api.migrateRun(source, typed, token),
    onSuccess: (migrated) => {
      setDone(migrated);
      // The string is not needed any more: dropped from the page at once.
      setTyped("");
      setRevealed(false);
      onInstalled(noteOf(migrated, source, questions));
    },
    onError: (error) => {
      const sorted = installFailure(error);
      setFailed(sorted);
      if (sorted.kind === "nothing-ran") {
        // Nothing ran: the SQL is shown again before anything else may run.
        setShown(null);
        sent.current = null;
      } else {
        setStarted(true);
      }
    },
    onSettled: () => {
      // The worker's list says whether the source still waits: the block goes once it does not.
      void queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const busy = plan.isPending || run.isPending;
  const showSql = () => {
    if (typed.trim() === "" || busy) {
      return;
    }
    setFailed(null);
    run.reset();
    sent.current = null;
    setShown(null);
    plan.mutate();
  };
  const install = () => {
    if (shown === null || busy || sent.current === shown.token) {
      return;
    }
    sent.current = shown.token;
    setFailed(null);
    run.mutate(shown.token);
  };

  const names = namesOf(questions);
  const sqlId = `${id}-sql`;
  const failure = failed === null ? null : failureWords(failed, source);
  const outcome = done === null ? null : noteOf(done, source, questions);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 gap-3 border border-hairline bg-surface p-4"
    >
      <h4 id={`${id}-title`} className="m-0 text-[15px] font-bold">
        {`Install ${names} from this page`}
      </h4>
      {outcome !== null ? (
        <InstalledNote note={outcome} />
      ) : (
        <>
          <p className="m-0 max-w-[64ch] text-text-2">
            {`Paste the connection string of a role that may alter ${source}'s table, such as its owner. It is used for this one install and kept nowhere: not by the worker, and not by this page once you close this.`}
          </p>
          <ConnectionField
            value={typed}
            onChange={(value) => {
              setTyped(value);
              // Another string is another plan: the SQL shown was made with the one before.
              if (shown !== null) {
                setShown(null);
                sent.current = null;
              }
            }}
            problem={plan.error === null ? undefined : <Problem error={plan.error} />}
            onEnter={showSql}
            revealed={revealed}
            onReveal={setRevealed}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={typed.trim() === "" || busy} onClick={showSql}>
              Show the SQL
            </Button>
          </div>
          {plan.isPending ? (
            <p role="status" className="m-0 text-text-2">
              Planning the install with the worker
            </p>
          ) : null}
          {shown === null ? null : (
            <div className="grid gap-3">
              <p id={sqlId} className="m-0 max-w-[64ch] text-text-2">
                {`This runs once on ${shown.table}${shown.transactional ? ", as one transaction: all of it or nothing" : ""}. Read it first: it is the text facetdb migrate --source ${source} --dry-run prints for this source.${shown.storeElsewhere ? " The FacetDB store is another database here, so facetdb migrate also prints the store's part above it (current: nothing to run there)." : ""}`}
              </p>
              <ScrollRegion
                aria-labelledby={sqlId}
                className="max-h-[320px] border border-hairline"
              >
                <pre className="m-0 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre">
                  {shown.sql}
                </pre>
              </ScrollRegion>
            </div>
          )}
          {failure === null ? null : (
            <div className="grid gap-1">
              <p className="m-0 font-semibold">{failure.title}</p>
              <Problem error={failure.error} />
            </div>
          )}
          {started && failed === null && !run.isPending ? (
            <p className="m-0 max-w-[64ch] border-l-2 border-review pl-3">
              {`An install was started here and did not finish as asked: show the SQL again to see what is still to run on ${source}'s table.`}
            </p>
          ) : null}
          <p role="status" className="m-0 text-text-2">
            {run.isPending ? "Installing, then reloading the worker" : ""}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="quiet"
          disabled={run.isPending}
          onClick={() => {
            setTyped("");
            onClose();
          }}
        >
          {outcome === null ? "Cancel" : "Close"}
        </Button>
        {outcome === null ? (
          <Button
            variant="primary"
            disabled={shown === null || busy || sent.current === shown.token}
            onClick={install}
          >
            {`Install ${names}`}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
