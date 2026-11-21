import { type ReactNode, useEffect } from "react";
import { useDeps } from "../deps.tsx";
import { PHONE_QUERY, useMedia } from "./media.ts";

/**
 * A page's head, as every page of the mockups opens: the title at 28 px and 800, one line under it
 * in `text-2`, the page's actions at the right, a rule beneath. It also names the browser tab after
 * the page.
 *
 * A `sticky` head stays in view while the window scrolls, so a long page keeps its actions at hand
 * (the Questions page's Test and Apply), its rule reading as the bar's edge over the content. On a
 * phone it stops under the top bar: one 36 px row, 10 px above and below, and a 1 px rule
 * (Drawer.tsx). It stays under the dialog's overlay (z-index 9, components.css).
 */
export function PageHead({
  title,
  lede,
  sticky = false,
  children,
}: {
  readonly title: string;
  readonly lede: string;
  readonly sticky?: boolean;
  /** The page's actions: one primary at most. */
  readonly children?: ReactNode;
}) {
  const { media } = useDeps();
  const phone = useMedia(media, PHONE_QUERY);
  useEffect(() => {
    document.title = `${title} · FacetDB`;
  }, [title]);
  // A stuck head carries 16 px of canvas above the title; the negative margin keeps the page's
  // layout where it was before scrolling.
  const stuck = sticky
    ? ` sticky z-[8] -mt-4 bg-canvas pt-4 ${phone ? "top-[57px]" : "top-0"}`
    : "";
  return (
    <header
      data-sticky={sticky ? "" : undefined}
      className={`mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-5${stuck}`}
    >
      <div>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{title}</h1>
        <p className="mt-1.5 max-w-[64ch] text-text-2">{lede}</p>
      </div>
      {children === undefined ? null : <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}
