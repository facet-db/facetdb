import {
  Button,
  Dither,
  DitherStrip,
  focusBrackets,
  Listbox,
  type StatusKind,
  StatusWord,
} from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type Home, homeQuery, projectQuery, reviewCountQuery } from "../api/index.ts";
import { useApi } from "../deps.tsx";
import {
  FILE_CAP_AHEAD_SHORT,
  fileCapAheadWords,
  SPENDING_STATE,
  spentMoneyWords,
  useFileCapAhead,
} from "./spending.ts";
import { useTheme } from "./theme.tsx";

/**
 * The rail (the mockups' rail): the brand mark, the project listbox, the eight pages in their order
 * without icons or a box, the current one in `text` at a heavier weight and nothing else, the
 * worker's heartbeat and the month's spending at the foot over a rule, and the theme switch. On a
 * phone the same parts sit in the top bar and the drawer (Drawer.tsx).
 */

/** The eight pages, in their order. */
export const PAGES = [
  { to: "/", title: "Home" },
  { to: "/sources", title: "Sources" },
  { to: "/questions", title: "Questions" },
  { to: "/review", title: "Review" },
  { to: "/decisions", title: "Decisions" },
  { to: "/plugins", title: "Plugins" },
  { to: "/alerts", title: "Alerts" },
  { to: "/settings", title: "Settings" },
] as const;

/** Review 4 of the mockups: the switcher is never dead; it says how another project opens. */
export const PROJECT_HINT =
  "This studio serves one project. Another opens by running facetdb studio in its folder; FacetDB Cloud lists every project of your account here.";

/** The dithered square that fills, in `facet`, and the name. */
export function Brand() {
  return (
    <div className="flex items-center gap-2.5 text-base font-extrabold tracking-tight">
      <span aria-hidden="true" className="inline-flex">
        <Dither value={0.75} size={16} ink="facet" label="FacetDB" />
      </span>
      <span>FacetDB</span>
    </div>
  );
}

/**
 * The project listbox: the one project of an open-source studio, and how another opens. In the
 * rail it is ruled above and below with no sides (the mockups' switcher); in the phone's top bar it
 * carries no rule at all.
 */
export function ProjectPicker({ bare = false }: { readonly bare?: boolean }) {
  const api = useApi();
  const project = useQuery(projectQuery(api)).data?.project;
  if (project === undefined) {
    // The listbox's height, so nothing moves when the name arrives.
    return <span aria-hidden="true" className="block h-9" />;
  }
  return (
    <Listbox
      label="Project"
      options={[{ value: project, label: project }]}
      value={project}
      hint={PROJECT_HINT}
      width="full"
      variant={bare ? "bare" : "rule"}
    />
  );
}

/**
 * The count beside Review: the number in the text color with the review square before it. Never
 * small colored text: on paper the status colors pass 3:1 only.
 */
function ReviewCount({ count }: { readonly count: number }) {
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-text">
      <span aria-hidden="true" className="size-1.5 bg-review" />
      <span>{count.toLocaleString("en-US")}</span>
      <span className="sr-only"> waiting</span>
    </span>
  );
}

const LINK_CLASSES = {
  rail: "py-[7px]",
  drawer: "border-b border-hairline py-3 text-base",
} as const;

/** The eight pages; the drawer's are at tap size and close it when one is chosen. */
export function PageLinks({
  size,
  onNavigate,
}: {
  readonly size: "rail" | "drawer";
  readonly onNavigate?: () => void;
}) {
  const api = useApi();
  const count = useQuery(reviewCountQuery(api)).data;
  return (
    <nav aria-label="Pages" className={size === "rail" ? "grid gap-0.5 py-4" : "grid"}>
      {PAGES.map((page) => (
        <Link
          key={page.to}
          to={page.to}
          // Home is current on its own path only; every other page also on the paths under it
          // (Sources for the setup flow, Decisions for the why page).
          activeOptions={{ exact: page.to === "/" }}
          onClick={onNavigate}
          className={`${focusBrackets} ${LINK_CLASSES[size]} flex items-center gap-2.5 font-medium text-text-2 no-underline transition-colors hover:text-text aria-[current=page]:font-bold aria-[current=page]:text-text`}
        >
          <span>{page.title}</span>{" "}
          {page.to === "/review" && count !== undefined && count > 0 ? (
            <ReviewCount count={count} />
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

const CHECK_STATUS: Readonly<Record<Home["health"]["checks"][number]["status"], StatusKind>> = {
  ok: "done",
  warn: "warning",
  fail: "error",
};

const WORKER_UNREACHABLE = "Not known: the worker cannot be reached";

function WorkerLine({
  home,
  failed,
}: {
  readonly home: Home | undefined;
  readonly failed: boolean;
}) {
  // The last good answer is not the worker's state now: while the shared query is in error, the
  // heartbeat it holds is old, so the line says the worker cannot be reached, never "beating".
  if (failed) {
    // The sentence is longer than the rail is wide: it wraps, the square staying on its first line.
    return <StatusWord status="error" size="small" label={WORKER_UNREACHABLE} wrap />;
  }
  if (home === undefined) {
    return <span className="text-text-3">Reading</span>;
  }
  const worker = home.health.checks.find((check) => check.name === "worker");
  if (worker === undefined) {
    return <span className="text-text-3">No heartbeat yet</span>;
  }
  // The check's first sentence: "Worker beating, 2 s ago", or the alert's title when it fails.
  const [line = worker.words] = worker.words.split(". ");
  return (
    <StatusWord
      status={CHECK_STATUS[worker.status]}
      size="small"
      label={line}
      title={worker.words}
    />
  );
}

function SpendingLine({
  home,
  failed,
}: {
  readonly home: Home | undefined;
  readonly failed: boolean;
}) {
  if (failed) {
    return <span className="text-text-3">Not known</span>;
  }
  if (home === undefined) {
    return <span className="text-text-3">Reading</span>;
  }
  return <Spent spending={home.spending} />;
}

function Spent({ spending }: { readonly spending: Home["spending"] }) {
  // The cap shown is the worker's, the one it started with; a cap saved to the file since waits
  // for a restart, and the rail says so in a line short enough for its column.
  const fileSets = useFileCapAhead(spending.cap);
  // Home's own word for the cap reached (one table, shell/spending.ts); the warning line stays
  // the strip's, which the rail shows.
  const atCap =
    spending.status === "paused" || spending.status === "continuing"
      ? SPENDING_STATE[spending.status]
      : undefined;
  return (
    <>
      {/* The worker's own figure, in tokens at a glance ("3.2M of 25M tokens"), and what that costs under it: its sentence is the title. */}
      <span className="font-mono text-xs whitespace-nowrap text-text" title={spending.words.sub}>
        {`${spending.words.figure} tokens`}
      </span>
      <span className="font-mono text-xs whitespace-nowrap text-text-2" title={spending.words.sub}>
        {spentMoneyWords(spending)}
      </span>
      {/* The figures round a count past the cap to the cap's own: the word says what they cannot. */}
      {atCap === undefined ? null : (
        <StatusWord
          status={atCap.status}
          size="small"
          label={atCap.label}
          title={spending.words.sub}
        />
      )}
      {spending.fraction === null ? (
        <span className="text-text-3">No monthly cap</span>
      ) : (
        <DitherStrip value={spending.fraction} width={160} rows={4} label={spending.words.sub} />
      )}
      {fileSets === null ? null : (
        <span className="text-text" title={fileCapAheadWords(fileSets)}>
          {FILE_CAP_AHEAD_SHORT}
        </span>
      )}
    </>
  );
}

/**
 * The instrument at the rail's foot: two stacked lines over a rule, always visible. Not a live
 * region: it changes every few seconds, and a screen reader would read every change.
 */
export function Instrument() {
  const api = useApi();
  const home = useQuery(homeQuery(api));
  return (
    <section
      aria-label="Worker and spending"
      className="grid gap-3 border-t border-hairline pt-4 text-[13px] text-text-2"
    >
      <div className="grid gap-1">
        <span>Worker</span>
        <WorkerLine home={home.data} failed={home.isError} />
      </div>
      <div className="grid gap-1">
        <span>Spent this month</span>
        <SpendingLine home={home.data} failed={home.isError} />
      </div>
    </section>
  );
}

/** Both themes, the system's by default; the switch names the one it turns on. */
export function ThemeSwitch() {
  const { theme, toggle } = useTheme();
  const other = theme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="quiet"
      size="small"
      onClick={toggle}
      aria-label={`Switch to the ${other} theme`}
    >
      {other === "light" ? "Light theme" : "Dark theme"}
    </Button>
  );
}

/**
 * The rail of a screen wider than a phone's. It is as tall as the window and scrolls on its own
 * when its parts do not fit (a zoomed page, a short window), so the spending line and the theme
 * switch at its foot can always be reached. It never draws a scrollbar: at the usual size
 * everything fits in one view, and a bar down the rail's edge reads as a second page beside the
 * first; the wheel, a swipe and the Tab key still move it.
 */
export function Rail() {
  return (
    <aside
      aria-label="Navigation"
      className="sticky top-0 flex h-screen flex-col overflow-y-auto border-r border-hairline px-5 pt-5.5 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Brand />
      <div className="mt-2.5">
        <ProjectPicker />
      </div>
      <PageLinks size="rail" />
      <div className="mt-auto grid flex-none gap-4">
        <Instrument />
        <div>
          <ThemeSwitch />
        </div>
      </div>
    </aside>
  );
}
