import { type ReactNode, useEffect } from "react";

/**
 * A page's head, as every page of the mockups opens: the title at 28 px and 800, one line under it
 * in `text-2`, the page's actions at the right, a rule beneath. It also names the browser tab after
 * the page.
 */
export function PageHead({
  title,
  lede,
  children,
}: {
  readonly title: string;
  readonly lede: string;
  /** The page's actions: one primary at most. */
  readonly children?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · FacetDB`;
  }, [title]);
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-5">
      <div>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{title}</h1>
        <p className="mt-1.5 max-w-[64ch] text-text-2">{lede}</p>
      </div>
      {children === undefined ? null : <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}
