import { describe, expect, it } from "vitest";
import { workerAfterInstall } from "./service.ts";

/**
 * What the setup's install body says of the worker: running with its version when the reload
 * started the source; otherwise the reload's own why and how to restart, whether the reload did not
 * start it, did not load the file, or did not name it.
 */

const RESTART =
  "Until then the worker that is running does not answer sellers. To restart it, stop facetdb worker (Ctrl+C) and start it again: it reads facetdb.config.ts as it is and answers every change to public.sellers from then on.";

describe("the worker after an install", () => {
  it("is running with its version when the reload started the source", () => {
    expect(
      workerAfterInstall(
        {
          loaded: true,
          sources: [
            { source: "listings", outcome: "unchanged", version: 3, message: null },
            { source: "sellers", outcome: "started", version: 1, message: "so it started." },
          ],
          notes: [],
        },
        "sellers",
        "public.sellers",
      ),
    ).toEqual({
      running: true,
      version: 1,
      words:
        "sellers is running with version 1: it answers every change to public.sellers from now on.",
    });
  });

  it("is not running, with the reload's why and the restart, when the source was not started", () => {
    expect(
      workerAfterInstall(
        {
          loaded: true,
          sources: [
            {
              source: "sellers",
              outcome: "not-started",
              version: null,
              message: "new in facetdb.config.ts and not answered yet: set SELLERS_URL.",
            },
          ],
          notes: [],
        },
        "sellers",
        "public.sellers",
      ),
    ).toEqual({
      running: false,
      why: "new in facetdb.config.ts and not answered yet: set SELLERS_URL.",
      restart: RESTART,
    });
  });

  it("is not running, with the failure and its fix, when the file did not load again", () => {
    expect(
      workerAfterInstall(
        {
          loaded: false,
          message: "the file does not load.",
          fix: "Fix line 12, then apply again.",
        },
        "sellers",
        "public.sellers",
      ),
    ).toEqual({
      running: false,
      why: "the file does not load. Fix line 12, then apply again.",
      restart: RESTART,
    });
  });

  it("is not running, saying the worker did not say, when the reload names no such source", () => {
    expect(
      workerAfterInstall({ loaded: true, sources: [], notes: [] }, "sellers", "public.sellers"),
    ).toEqual({
      running: false,
      why: "the worker read facetdb.config.ts again and did not say what it did with sellers.",
      restart: RESTART,
    });
  });
});
