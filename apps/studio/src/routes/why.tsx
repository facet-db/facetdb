import { createRoute, Link } from "@tanstack/react-router";
import { WhyPage } from "../features/why/index.ts";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// "Why was this decided" for one record (the mockups' why.html): under /decisions, so the rail marks
// Decisions. The key is the record's as the log shows it, which may hold a slash, a space or a
// percent sign: the router decodes it from the path once and the API client encodes it once.
export const whyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions/$source/$key",
  component: WhyRoute,
});

function WhyRoute() {
  const { source, key } = whyRoute.useParams();
  return <WhyPage source={source} recordKey={key} />;
}

/** A text value of the address as written (routes/search.ts), or nothing when empty. */
function written(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The record the query form names: the source and the key exactly as written, never trimmed. */
function recordSearch(raw: Record<string, unknown>): {
  readonly source: string | undefined;
  readonly key: string | undefined;
} {
  return { source: written(raw["source"]), key: written(raw["key"]) };
}

// The same page with the record in the query: a key of `.` or `..` is a dot segment the URL
// standard resolves away in any path, percent-encoded or not, so the log links such a key here.
export const whyByQueryRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions/history",
  validateSearch: recordSearch,
  component: WhyByQueryRoute,
});

function WhyByQueryRoute() {
  const { source, key } = whyByQueryRoute.useSearch();
  if (source === undefined || key === undefined) {
    return (
      <>
        <PageHead
          title="No such record"
          lede="This address does not name a source and a record key."
        />
        <Link to="/decisions">Go to Decisions</Link>
      </>
    );
  }
  return <WhyPage source={source} recordKey={key} />;
}
