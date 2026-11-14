import { type QuestionSet, stateHash } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { PollingRow } from "../dialect/index.ts";
import {
  PLAIN_COLUMNS,
  PLAIN_KEY,
  PLAIN_MARKS,
  plainDialect,
  type RecordingClient,
  recordingClient,
} from "../testing/index.ts";
import { createPollingConnector, type PollingTarget } from "./index.ts";

/**
 * The polling connector on a recording client, through the reference dialect: the generic code's
 * own branches that Postgres never takes (columns added after inspecting the catalog, each marked
 * as it is added because the DDL is not transactional, the marks kept as rows of
 * `facetdb_table_owners`), and the state-hash rules every dialect shares. The behavior on a real
 * engine is `@facetdb/postgres`'s polling.test.ts, on PGlite.
 */

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: PollingTarget = {
  project: { id: "proj_tickets", name: "Tickets" },
  table: "tickets",
  key: "id",
  onChange: "reset",
  questionSet,
};

const OWNED = [
  "not_priority",
  "not_priority_probability",
  "facetdb_status",
  "facetdb_updated_at",
  "facetdb_reviewed",
  "facetdb_state_hash",
];

/** A table as the reference dialect's catalog answers it: columns, the key, the marks' rows. */
function catalog(columns: readonly string[], marks: ReadonlyMap<string, string> = new Map()) {
  return (text: string): readonly PollingRow[] | undefined => {
    if (text === PLAIN_COLUMNS) {
      return columns.map((name) => ({
        name,
        type: "varchar",
        nullable: name !== "id",
        time: name === "updated_at",
      }));
    }
    if (text === PLAIN_KEY) {
      return [{ name: "id" }];
    }
    if (text === PLAIN_MARKS) {
      return [...marks].map(([name, mark]) => ({ name, mark }));
    }
    return undefined;
  };
}

const APP = ["id", "title", "body", "updated_at"];

/** The statements a client was sent, minus the catalog's reads. */
function changes(client: RecordingClient): readonly string[] {
  return client.statements
    .map((statement) => statement.text)
    .filter((text) => ![PLAIN_COLUMNS, PLAIN_KEY, PLAIN_MARKS].includes(text));
}

function open(client: RecordingClient, options: { lastChangedColumn?: string } = {}) {
  const warnings: string[] = [];
  const clock = new FakeClock();
  const connector = createPollingConnector(plainDialect, client, target, {
    ...options,
    clock,
    warn: (message) => warnings.push(message),
  });
  return { connector, warnings, clock };
}

describe("the polling connector's install through a dialect without transactional DDL or comments", () => {
  it("adds only the missing columns after reading the catalog, marking each as it is added, then the project", async () => {
    const present = new Map([["not_priority", "facetdb"]]);
    const client = recordingClient(catalog([...APP, "not_priority"], present));
    await open(client).connector.install();
    const sent = changes(client);
    expect(sent[0]).toMatch(/^create table if not exists "facetdb_table_owners"/);
    // not_priority is FacetDB's already: marked again, never added again.
    expect(sent.filter((text) => text.startsWith("alter table"))).toEqual(
      OWNED.slice(1).map((name) => expect.stringContaining(`add "${name}"`)),
    );
    // Each added column is marked before the next is added: a stop leaves nothing unmarked.
    const added = sent.findIndex((text) => text.includes(`add "not_priority_probability"`));
    expect(sent[added + 2]).toContain(`'not_priority_probability', 'facetdb')`);
    expect(sent.at(-1)).toContain(`'facetdb_state_hash', 'facetdb:proj_tickets')`);
    // No transaction: the database would commit each statement on its own anyway.
    expect(client.transactions).toEqual({ committed: 0, rolledBack: 0 });
    expect(client.statements.every((statement) => !statement.inTransaction)).toBe(true);
  });

  it("refuses a column of the application's under a question's name, and another project's table, changing nothing", async () => {
    const taken = recordingClient(catalog([...APP, "not_priority"]));
    await expect(open(taken).connector.install()).rejects.toThrow(
      `install refused: "main"."tickets" already has "not_priority", which FacetDB did not create; rename the question or the column`,
    );
    expect(changes(taken)).toEqual([]);

    const theirs = recordingClient(
      catalog(
        [...APP, ...OWNED],
        new Map(
          OWNED.map((name) => [
            name,
            name === "facetdb_state_hash" ? "facetdb:proj_other" : "facetdb",
          ]),
        ),
      ),
    );
    await expect(open(theirs).connector.install()).rejects.toThrow(
      "install refused: main.tickets is marked as project proj_other's; one table belongs to one project",
    );
    expect(changes(theirs)).toEqual([]);
  });

  it("uninstalls the marked columns and their rows only: an application's column under a question's name stays", async () => {
    const marks = new Map(
      OWNED.filter((name) => name !== "not_priority").map((name) => [name, "facetdb"]),
    );
    const client = recordingClient(catalog([...APP, ...OWNED], marks));
    await open(client).connector.uninstall();
    expect(changes(client)).toEqual([
      ...OWNED.slice(1).map((name) => `alter table "main"."tickets" drop column "${name}"`),
      `delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'tickets'`,
    ]);
  });
});

describe("the polling connector's state hash, on any dialect", () => {
  const row = (key: string, title: string, stored: string | null): PollingRow => ({
    k: key,
    s0: title,
    s1: "body",
    h: stored,
    x: false,
    c: "2026-11-03 10:00:00",
  });

  it("yields only the rows whose state hash differs from the stored one, and marks those pending", async () => {
    const client = recordingClient();
    const { connector } = open(client, { lastChangedColumn: "updated_at" });
    const answered = stateHash(questionSet.read, { title: "same", body: "body" });
    client.answer([row("1", "same", answered), row("2", "changed", answered)], []);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["2"] });
    await iterator.return?.();
    expect(client.statements[1]).toMatchObject({
      text: `update "main"."tickets" set "facetdb_status" = 'pending' where "id" in (:1) and ("facetdb_status" is null or "facetdb_status" <> 'pending')`,
      params: ["2"],
    });
  });

  it("writes nothing when the stored state moved since it was read", async () => {
    const client = recordingClient();
    const { connector } = open(client);
    client.answer([row("1", "moved", null)]);
    const stale = stateHash(questionSet.read, { title: "before", body: "body" });
    expect(await connector.write("1", { decisions: {}, status: "done" }, stale)).toEqual({
      written: false,
    });
    expect(client.statements.map((statement) => statement.text)).toEqual([
      expect.stringMatching(/ for update$/),
    ]);
    expect(client.transactions).toEqual({ committed: 1, rolledBack: 0 });
  });

  it("@timing without a last-changed column reads the whole table hourly, and says so once", async () => {
    const client = recordingClient();
    const { connector, warnings, clock } = open(client);
    client.answer([row("1", "a", null)], []);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["1"] });
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps).toEqual([3_600_000]);
    expect(warnings).toEqual([
      "main.tickets has no last-changed column, so FacetDB reads the whole table every 60 minutes; give it an updated_at the application sets on every insert and every update (NOT NULL) to notice changes within 10 seconds",
    ]);
    expect(client.closes.count).toBe(1);
  });

  it("refuses a page of no rows", () => {
    expect(() =>
      createPollingConnector(plainDialect, recordingClient(), target, {
        pageSize: 0,
        clock: new FakeClock(),
        warn: () => undefined,
      }),
    ).toThrow("a page holds at least one row, not 0");
  });
});
