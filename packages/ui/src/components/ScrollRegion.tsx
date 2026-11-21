import type { ComponentProps } from "react";
import { focusBrackets } from "./Button.tsx";

export type ScrollRegionProps = Omit<ComponentProps<"section">, "tabIndex"> & {
  // Classes for the frame around the scroller: its margins and its place in the layout.
  frameClassName?: string;
};

// A region that scrolls (a record's fields, a diff, a script) and takes the focus, so a keyboard
// can scroll it. The frame around the scroller draws the focus brackets: on the scroller itself
// they overhang its edge by their 5 px, which the scroller counts as content, and it then shows
// scrollbars over text that fits. The caller names the region (aria-label or aria-labelledby) and
// gives the scroller its limits (a max-height, a border) through className.
export function ScrollRegion({ frameClassName, className, children, ...rest }: ScrollRegionProps) {
  const frame = `fdb-scroll-frame ${focusBrackets}`;
  return (
    <div className={frameClassName === undefined ? frame : `${frame} ${frameClassName}`}>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard to be read
        tabIndex={0}
        className={className === undefined ? "fdb-scroll" : `fdb-scroll ${className}`}
        {...rest}
      >
        {children}
      </section>
    </div>
  );
}
