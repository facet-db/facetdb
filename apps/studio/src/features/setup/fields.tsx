import { Button, focusBrackets } from "@facetdb/ui";
import { type CSSProperties, type ReactNode, useId, useState } from "react";

/**
 * The setup flow's own controls: the connection string's box, which no browser may remember,
 * correct or send away to check its spelling; a checkbox with its label; and a step's frame, its
 * number beside its heading as the mockup draws it. Token classes only.
 */

const BOX =
  "h-9 w-full min-w-0 border border-hairline bg-transparent px-3 font-mono text-[13px] text-text placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent aria-[invalid=true]:border-no";

/**
 * The masking as an inline style, which no stylesheet build can drop. React's style types do not
 * list this vendor property, so it is built from its name.
 */
const MASKED: CSSProperties = Object.fromEntries([["WebkitTextSecurity", "disc"]]);

/**
 * Whether the browser masks a text box's characters by `-webkit-text-security` (Chromium and
 * WebKit do; a browser that does not gets a `password` box instead, so the string is never shown).
 */
function textSecurity(): boolean {
  try {
    return CSS.supports("-webkit-text-security", "disc");
  } catch {
    return false;
  }
}

/**
 * The admin connection string's box, masked as the mockup draws it until the person shows it
 * (review block D). Masked by `-webkit-text-security` on a text box rather than `type="password"`:
 * a browser takes a password box that leaves the page after a request (the box does, once the
 * connection holds) for a sign-in and offers to keep it among its saved passwords, and Chromium and
 * Firefox save a password box whatever `autocomplete` says. Only where the browser cannot mask a
 * text box is it a `password` box, under `autocomplete="off"` and no form. No autocomplete, no spell
 * check (a browser's own may send the text to a server), no autocorrect.
 */
export function ConnectionField({
  value,
  onChange,
  problem,
  onEnter,
  revealed,
  onReveal,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Why the last connection failed, tied to the box; undefined when it did not. */
  readonly problem: ReactNode | undefined;
  readonly onEnter: () => void;
  /** The person chose to see the string; masked otherwise. */
  readonly revealed: boolean;
  readonly onReveal: (revealed: boolean) => void;
}) {
  const id = useId();
  const [masking] = useState(textSecurity);
  const masked = !revealed;
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-[13px] text-text-2">
        Connection string
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`${focusBrackets} relative block min-w-0 flex-1 has-[:focus-visible]:after:opacity-100!`}
        >
          <input
            id={id}
            type={masked && !masking ? "password" : "text"}
            data-masked={masked}
            value={value}
            placeholder="postgresql://user:password@host:5432/database?sslmode=require"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            aria-invalid={problem !== undefined}
            {...(problem === undefined ? {} : { "aria-describedby": `${id}-problem` })}
            className={BOX}
            // Inline, not a utility class: a build that dropped the rule would show the string.
            style={masked && masking ? MASKED : undefined}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.repeat) {
                event.preventDefault();
                onEnter();
              }
            }}
          />
        </span>
        <Button
          variant="quiet"
          size="small"
          // The name holds the word on the button, in both states (label in name).
          aria-label={revealed ? "Hide the connection string" : "Show the connection string"}
          aria-controls={id}
          onClick={() => {
            onReveal(!revealed);
          }}
        >
          {revealed ? "Hide" : "Show"}
        </Button>
      </div>
      {problem === undefined ? null : <div id={`${id}-problem`}>{problem}</div>}
    </div>
  );
}

export function Check({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  /** A few words after the label, in the faint role: what the column is. */
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <span
        className={`${focusBrackets} relative inline-flex has-[:focus-visible]:after:opacity-100!`}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          className="size-4 accent-facet"
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      </span>
      <label htmlFor={id} className="font-mono text-[13px]">
        {label}
        {hint === undefined ? null : <span className="ml-2 font-sans text-text-3">{hint}</span>}
      </label>
    </div>
  );
}

/** One numbered step: its number, its heading, and what it holds or what it waits for. */
export function Step({
  number,
  title,
  current,
  onReached,
  children,
}: {
  readonly number: number;
  readonly title: string;
  /** The first step not done yet: its number is drawn in the accent and it is the current step. */
  readonly current: boolean;
  /** The person moved into this step (its focus): the steps before it are behind them. */
  readonly onReached?: (number: number) => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <li
      onFocus={() => {
        onReached?.(number);
      }}
      {...(current ? { "aria-current": "step" as const } : {})}
      className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-5 border-t border-hairline py-7 first:border-t-0 first:pt-0"
    >
      <span
        aria-hidden="true"
        className={`font-mono text-[22px] leading-none font-semibold ${current ? "text-facet-text" : "text-text-3"}`}
      >
        {number}
      </span>
      <section aria-labelledby={id} className="grid min-w-0 gap-4">
        <h2 id={id} className="text-[19px] font-bold tracking-tight">
          {title}
        </h2>
        {children}
      </section>
    </li>
  );
}

/** What a step waits for, in the muted role. */
export function Waiting({ children }: { readonly children: ReactNode }) {
  return <p className="text-text-3">{children}</p>;
}
