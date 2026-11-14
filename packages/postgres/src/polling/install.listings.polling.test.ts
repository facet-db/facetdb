import { readFile, writeFile } from "node:fs/promises";
import type { QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { pollingInstallSql } from "../testing/index.ts";

/**
 * the listings example installed in polling mode: public.listings keyed by id, the state columns
 * title and description, one noul question is_scam. Its polling install SQL is the committed
 * fixture install.listings.polling.sql, pinned before the polling connector moved to
 * @facetdb/sql-polling and compared byte for byte after it: the move changes no statement Postgres
 * runs. The fixture is read with readFile, never written by the test (`UPDATE_FIXTURES=1` rewrites
 * it on purpose, and the diff is reviewed).
 */
const FIXTURE = new URL("./install.listings.polling.sql", import.meta.url);

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The statements as one script: each ended by `;`, a blank line between. */
function script(statements: readonly string[]): string {
  return `${statements.join(";\n\n")};\n`;
}

describe("the polling install of the listings example", () => {
  it("reproduces the committed fixture byte for byte", async () => {
    const sql = script(pollingInstallSql({ table: "listings", key: "id" }, listings));
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
  });
});
