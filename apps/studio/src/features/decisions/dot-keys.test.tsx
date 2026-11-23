import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createApiClient, type DecisionRow } from "../../api/index.ts";
import { fakeApi, renderStudio, STUDIO_ORIGIN, sampleHistory } from "../../testing/index.ts";

/**
 * A record keyed `.` or `..`. The URL standard reads either as a dot segment in any path,
 * percent-encoded too, and resolves it away: `/decisions/listings/..` is `/decisions/`. So the log
 * links such a key to the why page by its query, and the history is asked for with the key as a
 * query value; every other key keeps its path. Each address is checked as a browser would resolve
 * it, not only as the router holds it: a memory history never resolves dot segments.
 */

const DOT_KEYS = [".", ".."] as const;

function modelRow(key: string): DecisionRow {
  return {
    kind: "answer",
    time: "2026-11-06T14:00:00.000Z",
    record_key: key,
    version: 3,
    model: "jev-1.14.0",
    answers: {
      is_scam: { type: "noul", probability: 0.3, decision: "no", outcome: "decided" },
    },
  };
}

/** The log of listings over all time, holding one row per key, with the table's fill played out. */
async function logOf(keys: readonly string[]) {
  const api = fakeApi({
    decisions: () => Promise.resolve({ decisions: keys.map(modelRow), next: null }),
  });
  const studio = renderStudio({ path: "/decisions?time=all", api });
  await screen.findByRole("table", { name: "Decisions of listings" });
  act(() => {
    studio.schedule.advance(2000);
  });
  return { ...studio, api };
}

/** Where a link of the log leads once a browser has resolved its address. */
function resolvedLink(key: string): URL {
  const table = screen.getByRole("table", { name: "Decisions of listings" });
  const link = within(table).getByRole("link", { name: key });
  return new URL(link.getAttribute("href") ?? "", STUDIO_ORIGIN);
}

describe("a record keyed . or .. in the studio", () => {
  it.each(DOT_KEYS)("links the key %j to its own history by the query", async (key) => {
    await logOf([key, "48190"]);
    const url = resolvedLink(key);
    expect(url.pathname).toBe("/decisions/history");
    expect(url.searchParams.get("source")).toBe("listings");
    expect(url.searchParams.get("key")).toBe(key);
  });

  it("links a plain key by its path, as before", async () => {
    await logOf(["..", "48190", "a/b c%25d"]);
    expect(`${resolvedLink("48190").pathname}${resolvedLink("48190").search}`).toBe(
      "/decisions/listings/48190",
    );
    expect(resolvedLink("a/b c%25d").pathname).toBe("/decisions/listings/a%2Fb%20c%2525d");
  });

  it.each(DOT_KEYS)(
    "opens the history of %j from its link, and asks for that record",
    async (key) => {
      const { user, history, api } = await logOf([key]);
      await user.click(screen.getByRole("link", { name: key }));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Why was this decided?" }),
      ).toBeVisible();
      expect(history.location.pathname).toBe("/decisions/history");
      expect(api.calls).toContain(`decisionHistory ${JSON.stringify({ source: "listings", key })}`);
      expect(screen.getByText(`The history of ${key} in listings`, { exact: false })).toBeVisible();
    },
  );

  it.each(DOT_KEYS)(
    "opens the history of %j from the address the link resolves to",
    async (key) => {
      const log = await logOf([key]);
      const url = resolvedLink(key);
      log.unmount();
      const api = fakeApi();
      renderStudio({ path: `${url.pathname}${url.search}`, api });
      expect(
        await screen.findByRole("heading", { level: 1, name: "Why was this decided?" }),
      ).toBeVisible();
      expect(api.calls).toContain(`decisionHistory ${JSON.stringify({ source: "listings", key })}`);
    },
  );

  it("reads a key in the query as written, never as a number", async () => {
    const api = fakeApi();
    renderStudio({ path: "/decisions/history?source=listings&key=1e3", api });
    await screen.findByRole("heading", { level: 1, name: "Why was this decided?" });
    expect(api.calls).toContain(
      `decisionHistory ${JSON.stringify({ source: "listings", key: "1e3" })}`,
    );
  });

  it("says so when the address names no record", async () => {
    const api = fakeApi();
    renderStudio({ path: "/decisions/history?source=listings", api });
    expect(await screen.findByRole("heading", { level: 1, name: "No such record" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to Decisions" })).toBeVisible();
    expect(api.calls.filter((call) => call.startsWith("decisionHistory"))).toEqual([]);
  });
});

describe("the history call's address", () => {
  it("puts a key of . or .. in the query and every other key in the path, encoded once", async () => {
    const urls: string[] = [];
    const client = createApiClient((input) => {
      urls.push(input);
      return Promise.resolve(
        new Response(JSON.stringify(sampleHistory("listings", "x")), { status: 200 }),
      );
    });
    for (const key of [".", "..", "48190", "a/b c%25d", "..."]) {
      await client.decisionHistory("listings", key);
    }
    expect(urls).toEqual([
      "/v1/decisions/history?source=listings&key=.",
      "/v1/decisions/history?source=listings&key=..",
      "/v1/decisions/listings/48190",
      "/v1/decisions/listings/a%2Fb%20c%2525d",
      "/v1/decisions/listings/...",
    ]);
    // As the browser sends them: the record's key survives resolution in each.
    const sent = urls.map((url) => new URL(url, STUDIO_ORIGIN));
    expect(sent.slice(0, 2).map((url) => url.searchParams.get("key"))).toEqual([".", ".."]);
    expect(
      sent.slice(2).map((url) => decodeURIComponent(url.pathname.split("/").at(-1) ?? "")),
    ).toEqual(["48190", "a/b c%25d", "..."]);
  });
});
