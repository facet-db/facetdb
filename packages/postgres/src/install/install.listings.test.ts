import { readFile } from "node:fs/promises";
import type { QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  STORE_SEQUENCES,
  STORE_TABLES,
  STORE_VERSION_TABLE,
} from "../store/index.ts";
import { installSql, renderSql, WORKER_ROLE } from "./sql.ts";

/**
 * What the printed install script says about the FacetDB store: the admin creates and owns every
 * table, and the worker login is granted rows on them and nothing else. The byte-for-byte
 * comparison with the fixtures lives in install.test.ts and scan.test.ts; these read the same two
 * fixtures for the rule the grants must keep.
 */

const FIXTURES = {
  inline: new URL("./install.listings.sql", import.meta.url),
  "side-table": new URL("../scan/install.listings.side-table.sql", import.meta.url),
};

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const project = { id: "proj_listings", name: "Listings" };

function scripts(): readonly (readonly [string, Promise<string>])[] {
  return [
    ...Object.entries(FIXTURES).map(
      ([name, url]) => [name, readFile(url, "utf8")] as readonly [string, Promise<string>],
    ),
    [
      "generated",
      Promise.resolve(
        renderSql(installSql({ table: "listings", key: "id" }, listings, project, {})),
      ),
    ],
  ];
}

describe("the printed install script and the store's tables", () => {
  for (const [name, script] of scripts()) {
    describe(name, () => {
      it("creates every store table and records the migration as applied", async () => {
        const sql = await script;
        for (const table of [...STORE_TABLES, STORE_VERSION_TABLE]) {
          expect(sql).toMatch(
            new RegExp(
              `create table if not exists ("facetdb"\\.)?"?${table}"? \\(|facetdb\\.${table} \\(`,
            ),
          );
        }
        for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
          expect(sql).toContain(
            `insert into facetdb.store_migrations (version) values (${version})`,
          );
        }
      });

      it("grants the store to facetdb_worker only, with no create privilege and no ownership", async () => {
        const sql = await script;
        const grants = sql
          .split(";\n")
          .map((statement) => statement.trim())
          .filter((statement) => /^grant\b.*"facetdb"\."[a-z_]+"/s.test(statement));
        const storeNames = [...STORE_TABLES, STORE_VERSION_TABLE, ...STORE_SEQUENCES];
        const storeGrants = grants.filter((statement) =>
          storeNames.some((table) => statement.includes(`"facetdb"."${table}"`)),
        );
        const [toWorker, toOthers] = [
          storeGrants.filter((statement) => statement.endsWith(`to "${WORKER_ROLE}"`)),
          storeGrants.filter((statement) => !statement.endsWith(`to "${WORKER_ROLE}"`)),
        ];
        expect(toWorker.length).toBe(storeNames.length);
        for (const statement of storeGrants) {
          expect(statement).not.toMatch(/\bcreate\b/i);
          expect(statement).not.toMatch(/\bwith grant option\b/i);
        }
        // The one other grantee of a store table is the trigger functions' owner, on the queue only.
        for (const statement of toOthers) {
          expect(statement).toMatch(/on "facetdb"\."jobs" to "facetdb_enqueue"$/);
        }
        // The only hand-over in the script is the enqueue role taking the trigger functions.
        const owners = [...sql.matchAll(/^.*\bowner to\b.*$/gm)].map((match) => match[0]);
        expect(owners.length).toBeGreaterThan(0);
        for (const line of owners) {
          expect(line).toMatch(
            /^alter function "facetdb"\."enqueue[a-z_]*"\(\) owner to "facetdb_enqueue";$/,
          );
        }
        // Nothing grants the worker a right to create anywhere.
        expect(sql).not.toMatch(/grant\s+[^;]*\bcreate\b[^;]*\bto "facetdb_worker"/i);
      });
    });
  }
});
