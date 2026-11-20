import { Outlet } from "@tanstack/react-router";
import { useDeps } from "../deps.tsx";
import { Drawer } from "./Drawer.tsx";
import { PHONE_QUERY, useMedia } from "./media.ts";
import { Rail } from "./Rail.tsx";

/**
 * The layout around every page: a rail of page names and one content column on one canvas; on a
 * phone, a top bar with the drawer and the content under it. A link at the very start lets a
 * keyboard skip the rail.
 */
export function Shell() {
  const { media } = useDeps();
  const phone = useMedia(media, PHONE_QUERY);
  return (
    <div className={phone ? "min-h-screen" : "grid min-h-screen grid-cols-[220px_minmax(0,1fr)]"}>
      <a
        href="#page"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[20] focus:bg-canvas focus:p-2"
      >
        Skip to the page
      </a>
      {phone ? <Drawer /> : <Rail />}
      <main
        id="page"
        tabIndex={-1}
        className={
          phone ? "min-w-0 px-4 pt-5 pb-24" : "w-full max-w-[1240px] min-w-0 px-8 pt-6.5 pb-24"
        }
      >
        <Outlet />
      </main>
    </div>
  );
}
