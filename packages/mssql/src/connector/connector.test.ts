import {
  EngineRefusal,
  type EngineTarget,
  type RecordDecision,
  type RecordKey,
  stateHash,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../install/index.ts";
import type { MssqlRow } from "../sql/index.ts";
import {
  answer,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  type RecordedStatement,
  type RecordingClient,
  recordingClient,
  serverError,
  typed,
  type World,
} from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  createMssqlConnector,
  MSSQL_CAPABILITIES,
  type MssqlConnector,
  mssqlTime,
  POLL_MS,
  parseMssqlTime,
  stateTextOf,
} from "./index.ts";

/**
 * The SQL Server runtime connector on the recording client: the catalog it reads at open, what it
 * refuses, and every statement it sends, with its parameters: every queue statement carries the
 * table as the trigger writes it (`[dbo].[listings]`) and reads past the rows others hold through
 * the clustered key, times are the clock's as style-121 text, the claim is one `update top …
 * output`, ack and release match the token and settle a skipped key on its own, claimKey and
 * enqueue are plain inserts the queue's `ignore_dup_key` makes a no-op, write is one guarded update
 * counted through a table variable. The real server runs the same SQL, and the contract suite, in
 * connector.db.test.ts.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const URL = "mssql://facetdb_worker:secret@127.0.0.1:1433/listings";
const TOKEN = /^[0-9a-f]{32}$/;
const TABLE = "[dbo].[listings]";

const ROW_COLUMNS =
  "convert(nvarchar(322), t.[id]) as k, convert(nvarchar(max), t.[title]) as s0, convert(nvarchar(max), t.[description]) as s1, cast(0 as bit) as x";

const decided: RecordDecision = {
  decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

/** A reply to the statements that start with `start`: rows, or an error the server raises. */
type Reply = {
  readonly start: string;
  readonly rows?: (params: readonly unknown[]) => readonly MssqlRow[];
  readonly fail?: Error;
  /** Answers this many statements, then stops; every one when absent. */
  times?: number;
};

class Made {
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly client: RecordingClient;
  readonly replies: Reply[] = [];
  readonly pools: { readonly url: string; readonly maxConnections: number }[] = [];
  #seen = 0;

  constructor(target: EngineTarget = LISTINGS, world: World = installedWorld(target)) {
    this.target = target;
    const catalog = answer(world);
    // The recording client asks `fail`, then `answer`, of each statement: each looks at its own kind
    // of reply, so one statement uses up one reply.
    const matching = (text: string, kind: "rows" | "fail"): Reply | undefined => {
      const reply = this.replies.find(
        (one) => text.startsWith(one.start) && one.times !== 0 && one[kind] !== undefined,
      );
      if (reply?.times !== undefined) {
        reply.times -= 1;
      }
      return reply;
    };
    this.client = recordingClient({
      answer: (text, params) => matching(text, "rows")?.rows?.(params) ?? catalog(text, params),
      fail: (text) => matching(text, "fail")?.fail,
    });
  }

  connector(workerId = "w1", scanPageSize?: number): Promise<MssqlConnector> {
    return createMssqlConnector(this.target, URL, {
      clock: this.clock,
      workerId,
      connect: (url, options) => {
        this.pools.push({ url, maxConnections: options.maxConnections });
        return this.client.connect(url);
      },
      maxConnections: 6,
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
    });
  }

  /** The statements sent since the last look. */
  take(): readonly Pick<RecordedStatement, "text" | "params">[] {
    const taken = this.client.statements.slice(this.#seen);
    this.#seen = this.client.statements.length;
    return taken.map(({ text, params }) => ({ text, params }));
  }

  /** Answers the next statements starting with `start` with `rows`. */
  reply(start: string, rows: (params: readonly unknown[]) => readonly MssqlRow[], times?: number) {
    this.replies.unshift({ start, rows, ...(times === undefined ? {} : { times }) });
  }
}

/** The keys a claim's or settle's `output` hands back. */
const keys = (...names: string[]) => names.map((record_key) => ({ record_key }));

/** Rows as `read` and `write`'s select return them. */
function stateRow(key: string, title: string | null, description: string | null): MssqlRow {
  return { k: key, s0: title, s1: description, x: false };
}

async function refusalOf(pending: Promise<unknown>): Promise<EngineRefusal> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof EngineRefusal)) {
    throw new Error(`expected an EngineRefusal, got ${String(error)}`);
  }
  return error;
}

describe("times", () => {
  it("writes the clock's time as style-121 text in UTC and reads it back", () => {
    expect(mssqlTime(START)).toBe("2026-11-04 09:00:00.000");
    expect(mssqlTime(START + 1)).toBe("2026-11-04 09:00:00.001");
    expect(parseMssqlTime("2026-11-04 09:00:00.001")).toBe(START + 1);
    expect(parseMssqlTime("yesterday")).toBeNaN();
  });
});

describe("a state column as text", () => {
  const column = (definition: string): CatalogColumn => {
    const world = typed("c", definition);
    return {
      name: "c",
      type: world.type,
      maxLength: world.maxLength ?? 0,
      precision: world.precision ?? 0,
      scale: world.scale ?? 0,
      collation: world.collation ?? null,
      computed: false,
      marked: false,
    };
  };

  it("keeps every digit and every byte of its type, so a change anywhere moves the hash", () => {
    expect(stateTextOf("t", "c", column("nvarchar(200)"))).toBe("convert(nvarchar(max), t.[c])");
    expect(stateTextOf("t", "c", column("float"))).toBe("convert(nvarchar(max), t.[c], 3)");
    expect(stateTextOf("t", "c", column("real"))).toBe("convert(nvarchar(max), t.[c], 3)");
    expect(stateTextOf("t", "c", column("money"))).toBe("convert(nvarchar(max), t.[c], 2)");
    expect(stateTextOf("t", "c", column("datetime2(7)"))).toBe(
      "convert(nvarchar(max), t.[c], 121)",
    );
    expect(stateTextOf("t", "c", column("varbinary(16)"))).toBe("convert(nvarchar(max), t.[c], 1)");
    expect(stateTextOf("t", "c", column("image"))).toBe(
      "convert(nvarchar(max), convert(varbinary(max), t.[c]), 1)",
    );
    expect(stateTextOf("t", "c", column("geography"))).toBe("t.[c].ToString()");
    expect(stateTextOf("t", "o]dd", undefined)).toBe("convert(nvarchar(max), t.[o]]dd])");
  });
});

describe("the mssql connector", () => {
  it("declares inline columns, a side table, several workers and no push wake-up", async () => {
    const made = new Made();
    const connector = await made.connector();
    expect(connector.capabilities).toBe(MSSQL_CAPABILITIES);
    expect(connector.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: false,
      transactions: true,
      sideTable: true,
      multipleWorkers: true,
    });
  });

  it("opens a pool as wide as the worker asks, reads the key from the catalog, and closes the pool with the connector", async () => {
    const made = new Made();
    const connector = await made.connector("w1");
    expect(made.pools).toEqual([{ url: URL, maxConnections: 6 }]);
    expect(connector.workerId).toBe("w1");
    expect(made.take().map((sent) => sent.params)).toEqual([
      ["dbo", "listings"],
      ["dbo", "listings"],
    ]);
    expect(made.client.openConnections()).toBe(1);
    await connector.close();
    await connector.close();
    expect(made.client.openConnections()).toBe(0);
  });

  it("watch reads the table's waiting jobs past held rows every second through the clock, announcing a key once", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    made.reply("select top (@p2) j.[record_key]", () => keys("1"), 1);
    made.reply("select top (@p2) j.[record_key]", () => keys("1", "2"), 1);
    made.replies.reverse();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(["1"]);
    expect(made.take()).toEqual([
      {
        text: "select top (@p2) j.[record_key] as record_key from [dbo].[facetdb_jobs] j with (readpast) where j.[table_name] = @p1 and j.[claimed_at] is null",
        params: [TABLE, 200],
      },
    ]);
    // 1 waits still and is not announced again; 2 is, one poll later.
    expect((await iterator.next()).value).toEqual(["2"]);
    expect(made.clock.sleeps).toEqual([POLL_MS]);
    await iterator.return?.();
    await connector.close();
    const woken = connector.watch()[Symbol.asyncIterator]();
    expect(await woken.next()).toEqual({ done: true, value: undefined });
  });

  it("claim is one update top reading past held rows through the clustered key, stamping a token, this worker and the lease, and outputting the keys", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    made.reply("update top (@p1) j", () => keys("1", "2"), 1);

    expect(await connector.claim(20)).toEqual(["1", "2"]);
    const [update] = made.take();
    expect(update?.text).toBe(
      "update top (@p1) j set [claim_token] = @p2, [claimed_by] = @p3, [claimed_at] = convert(datetime2(3), @p4, 121) output inserted.[record_key] as record_key from [dbo].[facetdb_jobs] j with (readcommittedlock, readpast, updlock, rowlock, index(1)) where j.[table_name] = @p5 and (j.[claimed_at] is null or j.[claimed_at] < convert(datetime2(3), @p6, 121))",
    );
    const [limit, token, worker, at, table, expired] = update?.params ?? [];
    expect(String(token)).toMatch(TOKEN);
    expect([limit, worker, at, table, expired]).toEqual([
      20,
      "w1",
      "2026-11-04 09:00:00.000",
      TABLE,
      "2026-11-04 08:45:00.000",
    ]);
    // Nothing left: the update outputs no row.
    expect(await connector.claim(20)).toEqual([]);
    expect(await connector.claim(0)).toEqual([]);
    expect(made.take()).toHaveLength(1);
    made.clock.advance(CLAIM_LEASE_MS);
    await connector.claim(1);
    expect(made.take()[0]?.params.slice(3)).toEqual([
      "2026-11-04 09:15:00.000",
      TABLE,
      "2026-11-04 09:00:00.000",
    ]);
  });

  it("ack is one delete by the token reading past held rows; a key it skipped settles in a statement of its own; a key never claimed sends nothing", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.reply("update top (@p1) j", () => keys("1", "2", "3"), 1);
    expect(await connector.claim(10)).toEqual(["1", "2", "3"]);
    const token = made.take().at(-1)?.params[1];
    // The application holds job 2 (its trigger cleared the claim): the batch reads past it.
    made.reply("delete j", () => keys("1"), 1);

    await connector.ack(["1", "2", "never"]);
    expect(made.take()).toEqual([
      {
        text: "delete j output deleted.[record_key] as record_key from [dbo].[facetdb_jobs] j with (readcommittedlock, readpast, rowlock, index(1)) where j.[table_name] = @p1 and j.[claim_token] = @p2 and j.[record_key] in (@p3, @p4)",
        params: [TABLE, token, "1", "2"],
      },
      {
        text: "delete j output deleted.[record_key] as record_key from [dbo].[facetdb_jobs] j where j.[table_name] = @p1 and j.[claim_token] = @p2 and j.[record_key] = @p3",
        params: [TABLE, token, "2"],
      },
    ]);
    // Settled once: the tokens of 1 and 2 are gone, so nothing goes again.
    await connector.ack(["1", "2"]);
    expect(made.take()).toEqual([]);

    made.reply("update j", () => keys("3"), 1);
    await connector.release(["3"]);
    expect(made.take()).toEqual([
      {
        text: "update j set [claimed_at] = null, [claimed_by] = null, [claim_token] = null output inserted.[record_key] as record_key from [dbo].[facetdb_jobs] j with (readcommittedlock, readpast, rowlock, index(1)) where j.[table_name] = @p1 and j.[claim_token] = @p2 and j.[record_key] in (@p3)",
        params: [TABLE, token, "3"],
      },
    ]);
  });

  it("a settle that throws keeps the claim's token, so the next settle tries again", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.reply("update top (@p1) j", () => keys("1"), 1);
    expect(await connector.claim(10)).toEqual(["1"]);
    made.replies.unshift({
      start: "update j",
      fail: serverError("Connection lost - socket hang up", 0),
      times: 1,
    });
    await expect(connector.release(["1"])).rejects.toThrow("Connection lost");
    made.take();
    made.reply("update j", () => keys("1"), 1);
    await connector.release(["1"]);
    expect(made.take().map((sent) => sent.text.split(" ")[0])).toEqual(["update"]);
  });

  it("settles in lists of 500 keys", async () => {
    const made = new Made();
    const connector = await made.connector();
    const many = Array.from({ length: 501 }, (_, index) => String(index));
    made.reply("update top (@p1) j", () => keys(...many), 1);
    await connector.claim(501);
    made.take();
    made.reply("delete j", (params) => keys(...params.slice(2).map(String)));
    await connector.ack(many);
    expect(made.take().map((sent) => sent.params.length)).toEqual([502, 3]);
  });

  it("claimKey inserts the job already claimed in one statement; no row out (the queue ignored a duplicate) is the false", async () => {
    const made = new Made();
    const connector = await made.connector("backfill-1");
    made.take();
    made.reply("insert into [dbo].[facetdb_jobs]", (params) => keys(String(params[1])), 1);

    expect(await connector.claimKey("7")).toBe(true);
    const [insert] = made.take();
    expect(insert?.text).toBe(
      "insert into [dbo].[facetdb_jobs] ([table_name], [record_key], [claimed_by], [claimed_at], [claim_token]) output inserted.[record_key] as record_key values (@p1, @p2, @p3, convert(datetime2(3), @p4, 121), @p5)",
    );
    const [table, key, by, at, token] = insert?.params ?? [];
    expect([table, key, by, at]).toEqual([TABLE, "7", "backfill-1", "2026-11-04 09:00:00.000"]);
    expect(String(token)).toMatch(TOKEN);
    // Queued already, claimed or not: the insert does nothing, and that is the false.
    expect(await connector.claimKey("7")).toBe(false);
    expect(made.take()).toHaveLength(1);
    // The claimed key settles by its token.
    made.reply("delete j", () => keys("7"), 1);
    await connector.ack(["7"]);
    expect(made.take()[0]?.params).toEqual([TABLE, token, "7"]);
  });

  it("enqueue is one plain insert per key, which keeps a held claim, never the trigger's claim-clearing update", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    await connector.enqueue(["3", "1", "3", "2"]);
    expect(made.take()).toEqual(
      ["3", "1", "2"].map((key) => ({
        text: "insert into [dbo].[facetdb_jobs] ([table_name], [record_key]) values (@p1, @p2)",
        params: [TABLE, key],
      })),
    );
    await connector.enqueue([]);
    expect(made.take()).toEqual([]);
  });

  it("read selects the key as the queue's text and the state as text, finding keys in their own type, 500 per statement, and hashes them", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [
      stateRow("2", "Bike", null),
      stateRow("1", "Car", "Cheap"),
    ]);

    const { rows, missing } = await connector.read(["2", "1", "2", "042"]);
    expect(made.take()).toEqual([
      {
        text: `select ${ROW_COLUMNS} from [dbo].[listings] t where t.[id] in (try_convert(int, @p1), try_convert(int, @p2), try_convert(int, @p3))`,
        params: ["2", "1", "042"],
      },
    ]);
    expect(rows.map(({ key, state, excluded }) => ({ key, state, excluded }))).toEqual([
      { key: "2", state: { title: "Bike", description: null }, excluded: false },
      { key: "1", state: { title: "Car", description: "Cheap" }, excluded: false },
    ]);
    expect(rows[1]?.hash).toBe(
      stateHash(["title", "description"], { title: "Car", description: "Cheap" }),
    );
    // '042' found no record of its own: 42's text is '42'.
    expect(missing).toEqual(["042"]);

    const many = Array.from({ length: 1_001 }, (_, index) => `${index}`);
    await connector.read(many);
    expect(made.take().map((sent) => sent.params.length)).toEqual([500, 500, 1]);
  });

  it("a source's where filter excludes a record whose filter is not true", async () => {
    const made = new Made({
      ...LISTINGS,
      questionSet: { ...LISTINGS.questionSet, where: "title <> N'draft'" },
    });
    const connector = await made.connector();
    made.take();
    await connector.read(["1"]);
    expect(made.take()[0]?.text).toContain(
      "cast(case when (title <> N'draft') then 0 else 1 end as bit) as x from",
    );
  });

  it("write after a read of the key is one guarded update: FacetDB's columns, only where the state's bytes still equal what was read, counted through a table variable", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [stateRow("1", "Car", null)]);
    const { rows } = await connector.read(["1"]);
    const hash = rows[0]?.hash ?? "";
    made.take();
    made.reply("declare @written", () => [{ written: 1 }]);

    expect(await connector.write("1", decided, hash)).toEqual({ written: true });
    expect(made.take()).toEqual([
      {
        text: `declare @written table ([n] int);
update t set [is_scam] = @p1, [is_scam_probability] = @p2, [facetdb_status] = @p3, [facetdb_updated_at] = convert(datetime2(3), @p4, 121) output 1 into @written ([n]) from [dbo].[listings] t where t.[id] = try_convert(int, @p5) and convert(nvarchar(322), t.[id]) = @p5 and convert(varbinary(max), convert(nvarchar(max), t.[title])) = convert(varbinary(max), @p6) and convert(nvarchar(max), t.[description]) is null;
select count(*) as written from @written;`,
        params: [false, 0.97, "done", "2026-11-04 09:00:00.000", "1", "Car"],
      },
    ]);

    // A reviewed decision sets the flag; a decision left for review writes NULLs.
    const reviewed: RecordDecision = {
      decisions: { is_scam: { kind: "needs_review" } },
      status: "needs_review",
      reviewed: true,
    };
    expect(await connector.write("1", reviewed, hash)).toEqual({ written: true });
    const [again] = made.take();
    expect(again?.text).toContain("[facetdb_reviewed] = @p5 output 1 into @written");
    expect(again?.params).toEqual([
      null,
      null,
      "needs_review",
      "2026-11-04 09:00:00.000",
      true,
      "1",
      "Car",
    ]);
  });

  it("write without a read of that hash selects the state first; a hash that moved, a row gone or a guard that matched nothing writes nothing", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    const hash = stateHash(["title", "description"], { title: "Car", description: null });
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [stateRow("1", "Car", null)], 1);
    made.reply("declare @written", () => [{ written: 1 }], 1);
    expect(await connector.write("1", decided, hash)).toEqual({ written: true });
    const [select, update] = made.take();
    expect(select).toEqual({
      text: `select ${ROW_COLUMNS} from [dbo].[listings] t where t.[id] = try_convert(int, @p1)`,
      params: ["1"],
    });
    expect(update?.text.startsWith("declare @written")).toBe(true);

    // The state moved since the model was sent it: nothing is updated.
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [stateRow("1", "Van", null)], 1);
    expect(await connector.write("1", decided, "another-hash")).toEqual({ written: false });
    expect(made.take().map((one) => one.text.split(" ")[0])).toEqual(["select"]);
    // The row is gone.
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [], 1);
    expect(await connector.write("9", decided, hash)).toEqual({ written: false });
    expect(made.take()).toHaveLength(1);
    // The guard matched no row (the state changed between the select and the update).
    made.reply("declare @written", () => [{ written: 0 }], 1);
    expect(await connector.write("1", decided, hash)).toEqual({ written: false });
  });

  it("write reads the count, not a result set an application trigger returned before it", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.reply("select convert(nvarchar(322), t.[id]) as k", () => [stateRow("1", "Car", null)]);
    const { rows } = await connector.read(["1"]);
    made.take();
    // The application's own trigger on the table selects a row of its own, ahead of the count.
    made.reply("declare @written", () => [{ audit_id: 7, written_by: "app" }, { written: 1 }], 1);
    expect(await connector.write("1", decided, rows[0]?.hash ?? "")).toEqual({ written: true });
    made.reply("declare @written", () => [{ audit_id: 8 }, { written: 0 }], 1);
    expect(await connector.write("1", decided, rows[0]?.hash ?? "")).toEqual({ written: false });
  });

  it("current reads FacetDB's columns as text, a NULL status as pending, a noul as true or false", async () => {
    const made = new Made();
    const connector = await made.connector();
    made.take();
    made.reply(
      "select convert(nvarchar(322), t.[id]) as k, convert(nvarchar(max), t.[is_scam])",
      () => [
        {
          k: "1",
          q0v: "0",
          q0p: "0.97",
          cs: "done",
          cu: "2026-11-04 09:01:00.000",
          cr: null,
        },
        { k: "2", q0v: null, q0p: null, cs: "pending", cu: null, cr: null },
        { k: "42", q0v: "1", q0p: "0.5", cs: "done", cu: null, cr: true },
      ],
    );

    const current = await connector.current(["1", "2", "042", "nowhere"]);
    expect(made.take()).toEqual([
      {
        text: "select convert(nvarchar(322), t.[id]) as k, convert(nvarchar(max), t.[is_scam]) as q0v, convert(nvarchar(max), t.[is_scam_probability]) as q0p, coalesce(t.[facetdb_status], N'pending') as cs, convert(nvarchar(30), t.[facetdb_updated_at], 121) as cu, t.[facetdb_reviewed] as cr from [dbo].[listings] t where t.[id] in (try_convert(int, @p1), try_convert(int, @p2), try_convert(int, @p3), try_convert(int, @p4))",
        params: ["1", "2", "042", "nowhere"],
      },
    ]);
    expect(current.get("1")).toEqual({
      decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
      status: "done",
      reviewed: false,
      updatedAt: new Date(START + 60_000),
    });
    expect(current.get("2")).toEqual({
      decisions: {},
      status: "pending",
      reviewed: false,
      updatedAt: null,
    });
    // 42 answered for '042', which names no record of its own.
    expect([...current.keys()]).toEqual(["1", "2"]);
  });

  it("install and uninstall run through the engine's plans: without an installer both reject", async () => {
    const made = new Made();
    const connector = await made.connector();
    await expect(connector.install()).rejects.toThrow("run `facetdb migrate`");
    await expect(connector.uninstall()).rejects.toThrow("run `facetdb uninstall`");
  });
});

describe("scan", () => {
  it("pages newest first by the key when the table has no created_at, with a keyset cursor in the key's own type", async () => {
    const made = new Made();
    const connector = await made.connector("w1", 2);
    made.take();
    made.reply("select top (@p1)", () => [stateRow("9", "a", null), stateRow("5", "b", null)], 1);

    const first = await connector.scan(null);
    expect(made.take()).toEqual([
      {
        text: `select top (@p1) ${ROW_COLUMNS} from [dbo].[listings] t order by t.[id] desc`,
        params: [2],
      },
    ]);
    expect(first.rows.map((row) => row.key)).toEqual(["9", "5"]);
    expect(first.next).toBe(JSON.stringify(["5"]));
    made.reply("select top (@p1)", () => [stateRow("1", "c", null)], 1);
    const second = await connector.scan(first.next);
    expect(made.take()).toEqual([
      {
        text: `select top (@p1) ${ROW_COLUMNS} from [dbo].[listings] t where t.[id] < try_convert(int, @p2) order by t.[id] desc`,
        params: [2, "5"],
      },
    ]);
    expect(second).toMatchObject({ next: null });
    await expect(connector.scan("not a cursor")).rejects.toThrow(
      '"not a cursor" is not a scan cursor of a SQL Server source',
    );
    await expect(connector.scan(JSON.stringify(["x", "y"]))).rejects.toThrow("not a scan cursor");
  });

  it("pages by created_at then the key where the worker may read it, NULLs last", async () => {
    const world = installedWorld(LISTINGS, {
      ...freshWorld(),
      tables: {
        "dbo.listings": {
          columns: [...LISTINGS_COLUMNS, typed("created_at", "datetime2(3)")],
          key: ["id"],
        },
      },
    });
    const made = new Made(LISTINGS, world);
    const connector = await made.connector("w1", 2);
    made.take();
    made.reply("select has_perms_by_name", () => [{ readable: 1 }]);
    made.reply(
      "select top (@p1)",
      () => [
        { o: "2026-06-01 00:00:00.000", ...stateRow("8", "a", null) },
        { o: "2026-06-01 00:00:00.000", ...stateRow("7", "b", null) },
      ],
      1,
    );

    const first = await connector.scan(null);
    expect(made.take()).toEqual([
      {
        text: "select has_perms_by_name(@p1, N'OBJECT', N'SELECT', @p2, N'COLUMN') as readable",
        params: [TABLE, "created_at"],
      },
      {
        text: `select top (@p1) convert(nvarchar(40), t.[created_at], 121) as o, ${ROW_COLUMNS} from [dbo].[listings] t order by t.[created_at] desc, t.[id] desc`,
        params: [2],
      },
    ]);
    expect(first.next).toBe(JSON.stringify(["2026-06-01 00:00:00.000", "7"]));

    made.reply(
      "select top (@p1)",
      () => [
        { o: "2026-01-01 00:00:00.000", ...stateRow("3", "c", null) },
        { o: null, ...stateRow("9", "d", null) },
      ],
      1,
    );
    const second = await connector.scan(first.next);
    expect(made.take()).toEqual([
      {
        text: `select top (@p1) convert(nvarchar(40), t.[created_at], 121) as o, ${ROW_COLUMNS} from [dbo].[listings] t where (t.[created_at] < convert(datetime2(3), @p2, 121) or (t.[created_at] = convert(datetime2(3), @p2, 121) and t.[id] < try_convert(int, @p3)) or t.[created_at] is null) order by t.[created_at] desc, t.[id] desc`,
        params: [2, "2026-06-01 00:00:00.000", "7"],
      },
    ]);
    expect(second.next).toBe(JSON.stringify([null, "9"]));
    made.reply("select top (@p1)", () => [], 1);
    expect(await connector.scan(second.next)).toEqual({ rows: [], next: null });
    expect(made.take()[0]?.text).toContain(
      "where t.[created_at] is null and t.[id] < try_convert(int, @p2)",
    );
  });

  it("orders by the key when the worker may not read created_at", async () => {
    const world = installedWorld(LISTINGS, {
      ...freshWorld(),
      tables: {
        "dbo.listings": {
          columns: [...LISTINGS_COLUMNS, typed("created_at", "datetime2(3)")],
          key: ["id"],
        },
      },
    });
    const made = new Made(LISTINGS, world);
    const connector = await made.connector("w1", 2);
    made.take();
    made.reply("select has_perms_by_name", () => [{ readable: 0 }]);
    await connector.scan(null);
    await connector.scan(null);
    // Asked once.
    expect(made.take().map((sent) => sent.text.split(" ")[1])).toEqual([
      "has_perms_by_name(@p1,",
      "top",
      "top",
    ]);
  });
});

describe("open refuses, and closes the pool, before anything else", () => {
  it("a table the worker login cannot see", async () => {
    const made = new Made(LISTINGS, { ...freshWorld(), tables: {} });
    const refused = await refusalOf(made.connector());
    expect(refused.refusal.code).toBe("no-table");
    expect(refused.message).toBe(
      "dbo.listings does not exist, or the worker login has no right on it",
    );
    expect(made.client.openConnections()).toBe(0);
  });

  it("a table without a single-column primary key", async () => {
    for (const key of [[], ["id", "title"]]) {
      const made = new Made(LISTINGS, {
        ...freshWorld(),
        tables: { "dbo.listings": { columns: LISTINGS_COLUMNS, key } },
      });
      const refused = await refusalOf(made.connector());
      expect(refused.refusal.code).toBe("primary-key");
      expect(refused.message).toBe(
        `dbo.listings needs a single-column primary key, and ${key.length === 0 ? "has none" : "has a composite one"}`,
      );
      expect(made.client.openConnections()).toBe(0);
    }
  });

  it("a config naming another key than the table's primary key", async () => {
    const made = new Made({ ...LISTINGS, key: "title" });
    const refused = await refusalOf(made.connector());
    expect(refused.refusal.code).toBe("primary-key");
    expect(refused.message).toBe(
      "dbo.listings's primary key is id, not title; the config and the table disagree",
    );
  });

  it("the schema the source names is where the table is read and what the queue's table_name says", async () => {
    const target: EngineTarget = { ...LISTINGS, schema: "sales" };
    const world = installedWorld(target, {
      ...freshWorld(),
      tables: { "sales.listings": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    });
    const made = new Made(target, world);
    const connector = await made.connector();
    expect(made.take().map((sent) => sent.params)).toEqual([
      ["sales", "listings"],
      ["sales", "listings"],
    ]);
    await connector.claim(1);
    const [claim] = made.take();
    expect(claim?.text).toContain("from [dbo].[facetdb_jobs] j");
    expect(claim?.params[4]).toBe("[sales].[listings]");
  });
});

/** Keeps the recorded key type honest: a uniqueidentifier key reads through its own conversion. */
describe("keys of other types", () => {
  it("a text key carries the queue's collation; a uniqueidentifier converts back from its text", async () => {
    const text = installedWorld(LISTINGS, {
      ...freshWorld(),
      tables: {
        "dbo.listings": {
          columns: [typed("id", "nvarchar(64)"), ...LISTINGS_COLUMNS.slice(1)],
          key: ["id"],
        },
      },
    });
    const made = new Made(LISTINGS, text);
    const connector = await made.connector();
    made.take();
    await connector.read(["a"]);
    expect(made.take()[0]?.text).toBe(
      "select convert(nvarchar(322), t.[id]) collate Latin1_General_100_BIN2 as k, convert(nvarchar(max), t.[title]) as s0, convert(nvarchar(max), t.[description]) as s1, cast(0 as bit) as x from [dbo].[listings] t where t.[id] in (try_convert(nvarchar(64), @p1))",
    );

    const guid = installedWorld(LISTINGS, {
      ...freshWorld(),
      tables: {
        "dbo.listings": {
          columns: [typed("id", "uniqueidentifier"), ...LISTINGS_COLUMNS.slice(1)],
          key: ["id"],
        },
      },
    });
    const other = new Made(LISTINGS, guid);
    const byGuid = await other.connector();
    other.take();
    const key: RecordKey = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
    await byGuid.read([key]);
    expect(other.take()[0]?.text).toContain("where t.[id] in (try_convert(uniqueidentifier, @p1))");
  });
});
