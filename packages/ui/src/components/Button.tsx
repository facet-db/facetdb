import type { ComponentProps, ReactNode } from "react";

// The class every focusable control wears so its focus shows as corner brackets drawn by one
// pseudo-element (focus is never removed). A surface's own links and tabs add it beside their
// classes.
export const focusBrackets = "fdb-brackets";

export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "small" | "medium" | "large";

// The classes a button wears, for a link or a router's anchor that must look like one (its
// variant and size go in data-variant and data-size).
export function buttonClasses(extra?: string): string {
  const base = `fdb-button ${focusBrackets}`;
  return extra === undefined ? base : `${base} ${extra}`;
}

export type ButtonProps = Omit<ComponentProps<"button">, "children"> & {
  children: ReactNode;
  // The one filled action per view is primary; a hairline rectangle is secondary; quiet has no
  // border until hovered.
  variant?: ButtonVariant;
  // 30 px compact, 36 px in the product, 44 px on the site.
  size?: ButtonSize;
  // The single key the action answers to (`y`, `n`, `1`): drawn as a Kbd after the words and
  // announced through aria-keyshortcuts. The key itself is bound by the surface (the review card).
  keyHint?: string;
};

// A key cap: the hint beside an action. Inside a Button it is hidden from the accessibility tree,
// since the button's aria-keyshortcuts says the same once.
export function Kbd({ children, ...rest }: ComponentProps<"kbd">) {
  return (
    <kbd className="fdb-kbd" {...rest}>
      {children}
    </kbd>
  );
}

export function Button({
  variant = "secondary",
  size = "medium",
  keyHint,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const shortcut = keyHint === undefined ? {} : { "aria-keyshortcuts": keyHint };
  return (
    <button
      type={type}
      className={buttonClasses(className)}
      data-variant={variant}
      data-size={size}
      {...shortcut}
      {...rest}
    >
      {children}
      {keyHint === undefined ? null : <Kbd aria-hidden="true">{keyHint}</Kbd>}
    </button>
  );
}
