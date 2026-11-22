import { focusBrackets } from "@facetdb/ui";
import type { ReactNode } from "react";

/**
 * The page's text boxes, as the studio's other forms draw them (packages/ui has no input): a
 * hairline rectangle, the focus shown as corner brackets on its wrapper, since an input draws no
 * pseudo-element of its own.
 */

export const BOX =
  "h-9 w-full min-w-0 border border-hairline bg-transparent px-3 text-text placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent aria-[invalid=true]:border-no";

/**
 * The wrapper that draws a box's focus brackets: as wide as the box, or with `full` the width it is
 * given, and with `narrow` no more than a setting's value needs (the mockup's 320 px).
 */
export function Bracketed({
  children,
  full = false,
  narrow = false,
}: {
  readonly children: ReactNode;
  readonly full?: boolean;
  readonly narrow?: boolean;
}) {
  return (
    <span
      className={`${focusBrackets} relative ${full ? "block" : "inline-flex w-fit"} ${narrow ? "max-w-[320px]" : ""} has-[:focus-visible]:after:opacity-100!`}
    >
      {children}
    </span>
  );
}
