import { focusBrackets } from "@facetdb/ui";
import { useId } from "react";
import type { UncommittedState } from "../../api/index.ts";

/**
 * Why the file is replaced only on the person's say-so: what git says of facetdb.config.ts, in
 * words a person who has never used git reads at once, and the choice under it. The worker's own
 * words name `force` and commits, for the terminal; the page says only what is at stake, by the
 * state the worker reports. Without one (the write was refused although the diff said git keeps the
 * file) the words that hold for every state are said.
 */
export function keptCopyWords(state: UncommittedState | null): string {
  switch (state) {
    case "ignored":
      return "Git keeps no copy of this file, so the version you have now cannot be brought back.";
    case "modified":
      return "This file has changes git has not saved.";
    case "untracked":
      return "Git does not track this file yet.";
    default:
      return "No copy of this file is kept anywhere else.";
  }
}

export function ReplaceAnyway({
  state,
  refused = false,
  checked,
  onChange,
}: {
  readonly state: UncommittedState | null;
  /** The write was just refused for it: the words are announced. */
  readonly refused?: boolean;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2 border-l-2 border-review pl-3">
      <p role={refused ? "alert" : undefined} className="m-0">
        {keptCopyWords(state)}
      </p>
      <span
        className={`${focusBrackets} relative inline-flex w-fit has-[:focus-visible]:after:opacity-100!`}
      >
        <input
          id={id}
          type="checkbox"
          className="accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <label htmlFor={id} className="pl-2">
          Replace it anyway
        </label>
      </span>
    </div>
  );
}
