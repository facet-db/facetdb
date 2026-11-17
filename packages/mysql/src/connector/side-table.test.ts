import type { EngineTarget, RecordDecision } from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { fakeServer, mysqlError } from "../testing/index.ts";
import { createMysqlConnector } from "./index.ts";

/**
 * The connector in side-table mode on the fake server: it opens only where the worker sees the side
 * table, and its write is one transaction that gives up quietly when the record was deleted under
 * it (the foreign key's 1452) and throws any other failure. The statements themselves run on both
 * servers in side-table.db.test.ts.
 */

const URL = "mysql://facetdb_worker:secret@127.0.0.1:3306/app";
const FIELDS = ["subject", "body"] as const;

const target: EngineTarget = {
  project: { id: "proj_tickets", name: "Tickets" },
  source: "tickets",
  table: "tickets",
  storage: "side-table",
  onChange: "keep",
  questionSet: {
    questions: CONTRACT_QUESTIONS,
    read: [...FIELDS],
    model: "jev-1.14.0",
    thresholds: {},
  },
};

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

function world(sideTable = true) {
  const server = fakeServer({ database: "app", table: "tickets", state: [...FIELDS], sideTable });
  const open = () =>
    createMysqlConnector(target, URL, { clock: new FakeClock(0), connect: server.connect });
  return { server, open };
}

describe("the connector in side-table mode", () => {
  it("is refused at open when the worker sees no side table, in words that say what to run", async () => {
    const { open } = world(false);
    await expect(open()).rejects.toMatchObject({
      refusal: {
        code: "no-side-table",
        message:
          "app.facetdb_tickets_answers, where side-table mode keeps the answers of app.tickets, does not exist, or the worker login has no right on it",
        fix: "run facetdb migrate with storage side-table for this source first",
      },
    });
  });

  it("writes nothing, and says so, when the record was deleted while the upsert waited (error 1452)", async () => {
    const { server, open } = world();
    const connector = await open();
    server.failWhen = (text) =>
      text.startsWith("insert into `app`.`facetdb_tickets_answers`")
        ? mysqlError(
            1452,
            "ER_NO_REFERENCED_ROW_2",
            "Cannot add or update a child row: a foreign key constraint fails",
          )
        : undefined;
    const from = server.sent.length;
    expect(await connector.write("t1", decided, "any-hash")).toEqual({ written: false });
    expect(server.sent.slice(from).map((sent) => sent.text.split(" ")[0])).toEqual([
      "begin",
      "insert",
      "commit",
    ]);
    await connector.close();
  });

  it("throws any other failure of the upsert, and rolls the transaction back", async () => {
    const { server, open } = world();
    const connector = await open();
    server.failWhen = (text) =>
      text.startsWith("insert into")
        ? mysqlError(1213, "ER_LOCK_DEADLOCK", "Deadlock found when trying to get lock")
        : undefined;
    const from = server.sent.length;
    await expect(connector.write("t1", decided, "any-hash")).rejects.toMatchObject({ errno: 1213 });
    expect(server.sent.slice(from).map((sent) => sent.text.split(" ")[0])).toEqual([
      "begin",
      "insert",
      "rollback",
    ]);
    await connector.close();
  });
});
