import { Button } from "@facetdb/ui";
import { useId, useRef, useState } from "react";
import type { PendingSource } from "../../api/index.ts";
import { useDeps } from "../../deps.tsx";

/**
 * A source whose loop does not run facetdb.config.ts as last loaded: the file holds a change the
 * worker has not taken up, and a person who has never seen a terminal command must read what state
 * that is and exactly what to run. One block, the same in the Apply dialog right after the write
 * and in the source's panel on the Questions page for as long as the worker's list names the
 * source. It starts and installs nothing: the commands are the person's, each on its own line with
 * a Copy that says it copied.
 */

type CopyState = "idle" | "copied" | "select";

/** The clipboard first, in the click itself; the command selected for the reader when it says no. */
function useCopy(command: string) {
  const { clipboard } = useDeps();
  const field = useRef<HTMLElement>(null);
  const [state, setState] = useState<CopyState>("idle");
  const copy = () => {
    let copying: Promise<void>;
    try {
      copying = clipboard(command);
    } catch {
      // No clipboard at all on this page: the same road as one that refuses.
      copying = Promise.reject(new Error("the clipboard is not available"));
    }
    void copying.then(
      () => {
        setState("copied");
      },
      () => {
        setState("select");
        if (field.current !== null) {
          window.getSelection()?.selectAllChildren(field.current);
        }
      },
    );
  };
  return { field, state, copy };
}

/** A command on a line of its own: it wraps inside the dialog instead of running past it. */
function CommandLine({ command }: { readonly command: string }) {
  const { field, state, copy } = useCopy(command);
  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <code
          ref={field}
          className="min-w-0 border border-hairline bg-surface-2 px-3 py-2 font-mono text-[13px] wrap-anywhere text-text"
        >
          {command}
        </code>
        <Button
          size="small"
          aria-label={`${state === "copied" ? "Copied" : "Copy"} ${command}`}
          onClick={copy}
        >
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <p role="status" className="m-0 text-[12.5px] text-text-2">
        {state === "copied"
          ? "Copied. Paste it into the terminal."
          : state === "select"
            ? "This browser did not allow copying. The command is selected: press Ctrl+C or Cmd+C."
            : ""}
      </p>
    </div>
  );
}

function capitalized(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

type Step = { readonly words: string; readonly command?: string };

/** The steps in the order they are run: install, restart, then answer the rows already there. */
function stepsOf(pending: Pick<PendingSource, "source" | "outcome" | "migrate" | "added">): Step[] {
  const { source, outcome, migrate, added } = pending;
  return [
    ...(migrate
      ? [
          {
            words:
              "Install the change in your database. It prints the SQL first and asks before it runs.",
            command: `facetdb migrate --source ${source}`,
          },
        ]
      : []),
    {
      words:
        "Restart the worker: press Ctrl+C in the terminal where facetdb studio or facetdb worker runs, then start it again.",
    },
    // Only a table is backfilled: a source that answers through the check API (nothing to migrate)
    // has no rows of its own to go back over, and the CLI refuses the command for one.
    ...(outcome === "kept" && migrate && added.length > 0
      ? [
          {
            words: `Answer the records already in the table with the new ${added.length === 1 ? "question" : "questions"}. It shows an estimate first and asks before it starts.`,
            command: `facetdb backfill --source ${source} --question ${added.join(",")}`,
          },
        ]
      : []),
  ];
}

export function NotRunning({
  source,
  outcome,
  why,
  migrate,
  added,
}: Pick<PendingSource, "source" | "outcome" | "migrate" | "added"> & {
  /** The reload's own words for it. */
  readonly why: string;
}) {
  const id = useId();
  const steps = stepsOf({ source, outcome, migrate, added });
  return (
    <section aria-labelledby={id} className="grid gap-3 border-l-2 border-review pl-3.5">
      <h3 id={id} className="m-0 text-base font-bold">
        {`${source} is written to facetdb.config.ts and is not running yet`}
      </h3>
      <p className="m-0 max-w-[64ch] text-text-2">{capitalized(why)}</p>
      <p className="m-0">
        In a terminal, in the folder that holds facetdb.config.ts, one after the other:
      </p>
      <ol className="m-0 grid list-decimal gap-3 pl-5">
        {steps.map((step) => (
          <li key={step.words} className="grid gap-2 pl-1">
            <span>{step.words}</span>
            {step.command === undefined ? null : <CommandLine command={step.command} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
