import { focusBrackets } from "@facetdb/ui";
import { type KeyboardEvent, type ReactNode, useId } from "react";

/**
 * The form's controls that packages/ui does not have: a labelled text box or text area with its
 * problem tied to it, and the source tabs. Token classes only; focus shows as the corner brackets,
 * drawn by the wrapper since a text box draws no pseudo-element.
 */

const BOX =
  "w-full min-w-0 border border-hairline bg-transparent px-3 text-text placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent aria-[invalid=true]:border-no";

/** The wrapper that draws a text box's focus brackets. */
function Bracketed({ children }: { readonly children: ReactNode }) {
  return (
    <span className={`${focusBrackets} relative block has-[:focus-visible]:after:opacity-100!`}>
      {children}
    </span>
  );
}

/**
 * A problem under the field it is about: the loader's words, marked by a rule in the error role.
 * It is not a live region; the Wording section's one status line announces the count once.
 */
export function FieldProblem({ id, words }: { readonly id: string; readonly words: string }) {
  return (
    <p id={id} className="m-0 border-l-2 border-no pl-2 text-[13px] text-text">
      {words}
    </p>
  );
}

export function TextField({
  label,
  value,
  onChange,
  problem,
  placeholder,
  rows,
  labelHidden = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The loader's words about this field, tied to it; undefined when it has none. */
  readonly problem?: string | undefined;
  readonly placeholder?: string;
  /** A text area of this many lines; a one-line box without it. */
  readonly rows?: number;
  /** The label is for a screen reader only (a line of a list whose heading says what it is). */
  readonly labelHidden?: boolean;
}) {
  const id = useId();
  const problemId = `${id}-problem`;
  const shared = {
    id,
    value,
    placeholder,
    autoComplete: "off",
    spellCheck: true,
    "aria-invalid": problem !== undefined,
    ...(problem === undefined ? {} : { "aria-describedby": problemId }),
  };
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className={labelHidden ? "sr-only" : "text-[13px] text-text-2"}>
        {label}
      </label>
      <Bracketed>
        {rows === undefined ? (
          <input
            {...shared}
            className={`${BOX} h-9`}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        ) : (
          <textarea
            {...shared}
            rows={rows}
            className={`${BOX} block resize-y py-2.5 leading-normal`}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )}
      </Bracketed>
      {problem === undefined ? null : <FieldProblem id={problemId} words={problem} />}
    </div>
  );
}

/**
 * The sources as tabs (the mockup's): one tab per source, each controlling its panel. The arrows
 * move and choose, Home and End go to the first and the last; only the chosen tab is in the tab
 * order, so Tab goes on into the panel.
 */
export function SourceTabs({
  names,
  chosen,
  onChoose,
  panelId,
  tabId,
}: {
  readonly names: readonly string[];
  readonly chosen: string;
  readonly onChoose: (name: string) => void;
  readonly panelId: (name: string) => string;
  readonly tabId: (name: string) => string;
}) {
  const target = (key: string, index: number): number | undefined => {
    const last = names.length - 1;
    switch (key) {
      case "ArrowRight":
        return index === last ? 0 : index + 1;
      case "ArrowLeft":
        return index === 0 ? last : index - 1;
      case "Home":
        return 0;
      case "End":
        return last;
      default:
        return undefined;
    }
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = target(event.key, index);
    const name = to === undefined ? undefined : names[to];
    if (name === undefined) {
      return;
    }
    event.preventDefault();
    onChoose(name);
    document.getElementById(tabId(name))?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Source"
      // Many sources wrap onto a second line. The list is not a scroller: a scroller counts the
      // tabs' focus brackets as content and shows scrollbars around a single name.
      className="inline-flex max-w-full flex-wrap gap-x-5.5 border-b border-hairline"
    >
      {names.map((name, index) => {
        const selected = name === chosen;
        return (
          <button
            key={name}
            id={tabId(name)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(name)}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChoose(name);
            }}
            onKeyDown={(event) => {
              move(event, index);
            }}
            className={`${focusBrackets} -mb-px h-9 shrink-0 cursor-pointer border-0 border-b-2 border-transparent bg-transparent p-0 font-medium text-text-2 transition-colors hover:text-text aria-selected:border-facet aria-selected:font-bold aria-selected:text-text`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
