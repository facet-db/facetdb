import { focusBrackets } from "@facetdb/ui";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/index.ts";
import { whenWords } from "./when.ts";

/**
 * The page's small controls that packages/ui does not have: the underlined choices (the mockups'
 * tabs: a choice of the view held by the address, not panels), a text filter, and a problem in the
 * surface's two sentences. Token classes only.
 */

/**
 * A few plain choices, one chosen, underlined in `facet`. A group of buttons, not a tab list: the
 * choice changes what the page shows and nothing is hidden behind it, so each button says whether
 * it is pressed and the keys are the buttons' own.
 */
export function Choices<Value extends string>({
  label,
  options,
  value,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly value: Value;
  readonly onPick: (value: Value) => void;
}) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 gap-5.5 border-0 border-b border-solid border-hairline p-0">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onPick(option.value);
          }}
          className={`${focusBrackets} -mb-px h-9 cursor-pointer border-0 border-b-2 border-transparent bg-transparent p-0 font-medium text-text-2 transition-colors hover:text-text aria-pressed:border-facet aria-pressed:font-bold aria-pressed:text-text`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A text box that applies on Enter and on leaving it, so a log of thousands is asked once for a
 * key and not once for each letter. `value` is the view's; it is remounted (a new `key`) when the
 * address changes it, which drops a half-typed draft.
 */
export function TextFilter({
  label,
  placeholder,
  value,
  onApply,
  search = false,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string | undefined;
  readonly onApply: (value: string | undefined) => void;
  /** The box that finds a record: its form is the page's search landmark. */
  readonly search?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const apply = () => {
    const text = draft.trim();
    const next = text === "" ? undefined : text;
    if (next !== value) {
      onApply(next);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply();
  };
  return (
    <form {...(search ? { role: "search" } : {})} onSubmit={submit} className="min-w-0">
      {/* The brackets of every focused control; an input draws no pseudo-element, so its wrapper does. */}
      <span className="fdb-brackets relative block has-[:focus-visible]:after:opacity-100!">
        <input
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={apply}
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-44 max-w-full border border-hairline bg-transparent px-3 text-text outline-offset-2 placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent"
        />
      </span>
    </form>
  );
}

/**
 * What stands under a problem when the page still holds an older good answer: the rows are kept,
 * marked with the time of the last good read. While it shows, no count and no "nothing older" is
 * said as current. It goes with the next good answer, which clears the query's error.
 */
export function StaleNote({
  what,
  readAt,
  now,
}: {
  /** "These rows were", "This history was". */
  readonly what: string;
  /** When the last good answer arrived, in epoch milliseconds. */
  readonly readAt: number;
  readonly now: Date;
}) {
  return (
    <p role="status" className="text-[12.5px] text-text-2">
      {`${what} last read ${whenWords(new Date(readAt), now)} and may be out of date.`}
    </p>
  );
}

/** A refusal or a failure in the surface's own words: what happened, then what to do about it. */
export function Problem({ error }: { readonly error: Error }) {
  return (
    <p role="alert" className="grid gap-1 border-l-2 border-no pl-3">
      <span>{error.message}</span>
      {error instanceof ApiError ? <span className="text-text-2">{error.fix}</span> : null}
    </p>
  );
}
