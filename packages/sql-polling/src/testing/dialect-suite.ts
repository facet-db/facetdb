import { readFile, writeFile } from "node:fs/promises";
import {
  type DatabaseEngine,
  type EngineDeps,
  type EnginePlan,
  type EngineTarget,
  OWNED_MARK,
  type QuestionSet,
  STATE_HASH_COLUMN,
  stateHash,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createPollingConnector } from "../connector/index.ts";
import type { ColumnFacts, PollingRow, SqlDialect, TableFacts } from "../dialect/index.ts";
import { pollingEngine } from "../engine/index.ts";
import { ownedColumnNames, projectMark, tableOf } from "../install/index.ts";
import { type RecordedStatement, recordingClient, recordingConnect } from "./recording-client.ts";

/**
 * The dialect conformance suite: the SQL text a dialect gives every operation of the polling engine
 * and connector for the listings example, snapshotted in a committed fixture and compared byte for
 * byte, plus what every dialect must keep (a name from the config is one identifier, a value is
 * always a bind parameter, placeholders count from 1, no trigger and no jobs table, uninstall takes
 * every column and the mark). The catalog's answers are scripted here, so the suite needs no
 * server; the dialect's own catalog queries are proven where they run, on PGlite for Postgres and
 * in each dialect's `*.db.test.ts`.
 *
 *   runDialectConformance({ dialect: oracleDialect, fixture: new URL("./oracle.dialect.sql", import.meta.url) });
 *
 * `UPDATE_FIXTURES=1` rewrites the fixture on purpose, and the diff is reviewed.
 */

export type DialectConformance = {
  readonly dialect: SqlDialect;
  /** The committed snapshot of every operation's SQL, compared byte for byte. */
  readonly fixture: URL;
};

/** the listings example: one noul question over title and description. */
const LISTINGS: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The same source after its set changed: is_scam removed for is_spam, description no longer read. */
const LISTINGS_LATER: QuestionSet = {
  ...LISTINGS,
  questions: [
    { type: "noul", name: "is_spam", instructions: "Is this listing spam?", stakes: "low" },
  ],
  read: ["title"],
};

const PROJECT = { id: "proj_listings", name: "Listings" };

function targetOf(questionSet: QuestionSet, table = "listings"): EngineTarget {
  return {
    project: PROJECT,
    source: "listings",
    table,
    storage: "inline",
    onChange: "reset",
    questionSet,
    urlVariable: "LISTINGS_URL",
  };
}

/** One of the application's columns, as the catalog shows it. */
function appColumn(
  name: string,
  options: { time?: boolean; nullable?: boolean } = {},
): ColumnFacts {
  return {
    name,
    type: options.time === true ? "timestamp" : "text",
    comment: null,
    time: options.time === true,
    nullable: options.nullable ?? true,
    readable: true,
  };
}

/** The application's listings table: keyed by id, with the updated_at it bumps. */
const APP_COLUMNS: readonly ColumnFacts[] = [
  appColumn("id", { nullable: false }),
  appColumn("title"),
  appColumn("description"),
  appColumn("updated_at", { time: true, nullable: false }),
];

/** What the catalog shows of a table in one scene of the suite, the marks by column. */
type Scene = {
  readonly columns: readonly ColumnFacts[];
  readonly marks: ReadonlyMap<string, string>;
  readonly loginExists: boolean;
  readonly workerSelect?: readonly string[];
  readonly policies?: readonly string[];
};

/** FacetDB's columns of `questionSet` on the table, each with its mark, the state hash with `hashMark`. */
function installed(questionSet: QuestionSet, hashMark: string): Scene {
  const owned = ownedColumnNames(questionSet);
  return {
    columns: [...APP_COLUMNS, ...owned.map((name) => appColumn(name))],
    marks: new Map(owned.map((name) => [name, name === STATE_HASH_COLUMN ? hashMark : OWNED_MARK])),
    loginExists: true,
    policies: ["facetdb_reads", "facetdb_writes"],
  };
}

const FRESH: Scene = { columns: APP_COLUMNS, marks: new Map(), loginExists: false };

/**
 * The dialect with its catalog reads answering `scene` (undefined: no such table): its marks as
 * comments where it has them, as its rows otherwise. Every piece of SQL text stays the dialect's.
 */
function scripted(dialect: SqlDialect, scene: Scene | undefined): SqlDialect {
  const { ownership } = dialect;
  const facts = (): TableFacts | undefined =>
    scene === undefined
      ? undefined
      : {
          columns: scene.columns.map((column) => ({
            ...column,
            comment: ownership.kind === "comment" ? (scene.marks.get(column.name) ?? null) : null,
          })),
          key: ["id"],
          policies: scene.policies ?? [],
          triggers: [],
          workerSelect: scene.workerSelect ?? [],
        };
  return {
    ...dialect,
    table: () => Promise.resolve(facts()),
    ownership:
      ownership.kind === "comment"
        ? ownership
        : { ...ownership, marks: () => Promise.resolve(scene?.marks ?? new Map()) },
    ...(dialect.login === undefined
      ? {}
      : {
          login: { ...dialect.login, exists: () => Promise.resolve(scene?.loginExists === true) },
        }),
  };
}

/** The engine over the scripted dialect, on a recording client: nothing reaches a server. */
function engineFor(dialect: SqlDialect, scene: Scene | undefined): DatabaseEngine {
  return pollingEngine(scripted(dialect, scene), recordingConnect(recordingClient()), {
    warn: () => undefined,
  });
}

const DEPS: EngineDeps = { clock: new FakeClock(), allowInsecure: true, storeShared: false };

const adminUrl = (dialect: SqlDialect) => `${dialect.schemes[0] ?? "sql"}://admin@localhost/app`;

function planned(result: Awaited<ReturnType<DatabaseEngine["planInstall"]>>): EnginePlan {
  if (!result.ok) {
    throw new Error(`the plan was refused: ${result.refusal.message}`);
  }
  return result.plan;
}

const FRESH_INSTALL = "install: a fresh table, the worker login missing";
const UNINSTALL = "uninstall";

/** The plan of the suite under `title`. */
async function planTitled(dialect: SqlDialect, title: string): Promise<EnginePlan> {
  const plan = (await plans(dialect)).find(([named]) => named === title)?.[1];
  if (plan === undefined) {
    throw new Error(`the suite has no plan titled "${title}"`);
  }
  return plan;
}

/** A plan as the engine prints it. */
function render(dialect: SqlDialect, plan: EnginePlan): string {
  return engineFor(dialect, FRESH).render(plan);
}

/** Every plan of the suite, by its section's title. */
async function plans(dialect: SqlDialect): Promise<readonly (readonly [string, EnginePlan])[]> {
  const url = adminUrl(dialect);
  const install = (scene: Scene, questionSet: QuestionSet = LISTINGS) =>
    engineFor(dialect, scene).planInstall(targetOf(questionSet), url, {
      ...DEPS,
      ...(scene.loginExists ? {} : { workerPassword: "a-long-random-password" }),
    });
  const noUpdatedAt: Scene = {
    ...FRESH,
    columns: APP_COLUMNS.filter((column) => column.name !== "updated_at"),
  };
  return [
    [FRESH_INSTALL, planned(await install(FRESH))],
    [
      "install: a table with no last-changed column",
      planned(await install({ ...noUpdatedAt, loginExists: true })),
    ],
    [
      "install: the table installed, the login there",
      planned(await install(installed(LISTINGS, projectMark(PROJECT.id)))),
    ],
    [
      "install: a polling table from an earlier version, its state hash with the bare mark",
      planned(await install(installed(LISTINGS, OWNED_MARK))),
    ],
    [
      UNINSTALL,
      planned(
        await engineFor(dialect, installed(LISTINGS, projectMark(PROJECT.id))).planUninstall(
          targetOf(LISTINGS),
          url,
          { ...DEPS, purge: false, alsoUninstalling: [] },
        ),
      ),
    ],
    [
      "prune: is_scam removed for is_spam, description no longer read",
      planned(
        await engineFor(dialect, {
          ...installed(LISTINGS, projectMark(PROJECT.id)),
          columns: [
            ...APP_COLUMNS,
            ...[...ownedColumnNames(LISTINGS), "is_spam", "is_spam_probability"].map((name) =>
              appColumn(name),
            ),
          ],
          marks: new Map(
            [...ownedColumnNames(LISTINGS), "is_spam", "is_spam_probability"].map((name) => [
              name,
              name === STATE_HASH_COLUMN ? projectMark(PROJECT.id) : OWNED_MARK,
            ]),
          ),
          workerSelect: ["id", "title", "description"],
        }).planPrune(targetOf(LISTINGS_LATER), url, DEPS),
      ),
    ],
  ];
}

/** A row of the connector's state select, as the driver hands it back. */
function stateRow(key: string, state: readonly [string, string], changed?: string): PollingRow {
  return {
    k: key,
    s0: state[0],
    s1: state[1],
    h: null,
    x: false,
    ...(changed === undefined ? {} : { c: changed }),
  };
}

/** The connector's statements, operation by operation, each with the binds it sent. */
async function connectorStatements(
  dialect: SqlDialect,
): Promise<readonly (readonly [string, readonly RecordedStatement[]])[]> {
  const target = { ...targetOf(LISTINGS), key: "id" };
  const open = (lastChangedColumn?: string) => {
    const client = recordingClient();
    const connector = createPollingConnector(dialect, client, target, {
      ...(lastChangedColumn === undefined ? {} : { lastChangedColumn }),
      pageSize: 2,
      clock: new FakeClock(1_700_000_000_000),
      warn: () => undefined,
    });
    return { client, connector };
  };
  const sections: [string, readonly RecordedStatement[]][] = [];
  const take = async (
    title: string,
    client: ReturnType<typeof recordingClient>,
    work: () => Promise<unknown>,
  ) => {
    const from = client.statements.length;
    await work();
    sections.push([title, client.statements.slice(from)]);
  };
  const first = "2026-11-03 10:00:00+00";
  const later = "2026-11-03 10:00:05+00";

  const polled = open("updated_at");
  const watch = polled.connector.watch()[Symbol.asyncIterator]();
  polled.client.answer(
    [stateRow("1", ["a", "b"], first), stateRow("2", ["c", "d"], first)],
    [],
    [],
  );
  await take("watch: the first poll by updated_at, over two pages", polled.client, () =>
    watch.next(),
  );
  polled.client.answer([stateRow("3", ["e", "f"], later)], []);
  await take("watch: the next poll, from the last updated_at seen", polled.client, () =>
    watch.next(),
  );
  await watch.return?.();

  const scanned = open();
  const hourly = scanned.connector.watch()[Symbol.asyncIterator]();
  scanned.client.answer([stateRow("1", ["a", "b"]), stateRow("2", ["c", "d"])], [], []);
  await take("watch: the hourly full scan, without a last-changed column", scanned.client, () =>
    hourly.next(),
  );
  await hourly.return?.();

  const { client, connector } = open("updated_at");
  await take("read", client, () => connector.read(["1", "2"]));
  const hash = stateHash(LISTINGS.read, { title: "a", description: "b" });
  client.answer([stateRow("1", ["a", "b"], first)]);
  await take("write: the hash checked under a row lock, then the decision", client, () =>
    connector.write(
      "1",
      {
        decisions: {
          is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.93 },
        },
        status: "done",
        reviewed: true,
      },
      hash,
    ),
  );
  await take("current", client, () => connector.current(["1", "2"]));
  await take("scan: the first page, newest first", client, () => connector.scan(null));
  await take("scan: the page after a cursor", client, () => connector.scan("9"));
  await connector.close();
  return sections;
}

/** One statement as the snapshot shows it: its text, and the values it binds when it has any. */
function shown(statement: RecordedStatement): string {
  const binds =
    statement.params.length === 0 ? "" : `\n-- binds: ${JSON.stringify(statement.params)}`;
  return `${statement.text};${binds}`;
}

/** Every operation's SQL, as the fixture holds it. */
export async function conformanceScript(dialect: SqlDialect): Promise<string> {
  const parts = [
    `-- The ${dialect.name} dialect: every operation's SQL for the listings example (the conformance suite).`,
    ...(await plans(dialect)).map(([title, plan]) => {
      const script = render(dialect, plan);
      return `-- plan, ${title}\n${script === "" ? "-- (nothing to run)\n" : script}`;
    }),
    ...(await connectorStatements(dialect)).map(
      ([title, statements]) => `-- connector, ${title}\n${statements.map(shown).join("\n")}\n`,
    ),
  ];
  return parts.join("\n");
}

/** The placeholders a statement holds, by their place in the dialect's numbering. */
function placeholdersIn(dialect: SqlDialect, text: string, upTo: number): readonly number[] {
  return Array.from({ length: upTo }, (_, index) => index + 1).filter((index) =>
    new RegExp(`${literally(dialect.placeholder(index))}(?![0-9])`).test(text),
  );
}

/** Text as a regular expression that matches it literally. */
function literally(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function runDialectConformance({ dialect, fixture }: DialectConformance): void {
  describe(`the ${dialect.name} dialect's conformance`, () => {
    it("writes the committed SQL for every operation of the listings example, byte for byte", async () => {
      const script = await conformanceScript(dialect);
      if (process.env["UPDATE_FIXTURES"] === "1") {
        await writeFile(fixture, script);
      }
      expect(script).toBe(await readFile(fixture, "utf8"));
    });

    it("installs no trigger and no jobs table, and marks the table for its project", async () => {
      const script = render(dialect, await planTitled(dialect, FRESH_INSTALL));
      expect(script).not.toMatch(/\btrigger\b|\bjobs\b/i);
      expect(script).toContain(dialect.quoteLiteral(projectMark(PROJECT.id)));
      for (const name of ownedColumnNames(LISTINGS)) {
        expect(script).toContain(dialect.quoteIdent(name));
      }
    });

    it("uninstalls every column the install added, and the table's mark with them", async () => {
      const uninstall = await planTitled(dialect, UNINSTALL);
      const removed = uninstall.removes
        .filter((one) => one.kind === "column")
        .map((one) => one.name);
      expect([...removed].sort()).toEqual([...ownedColumnNames(LISTINGS)].sort());
      // The mark goes with facetdb_state_hash where it is a comment, with its rows otherwise.
      expect(render(dialect, uninstall)).toContain(dialect.quoteIdent(STATE_HASH_COLUMN));
      if (dialect.ownership.kind === "table") {
        expect(uninstall.removes.some((one) => one.kind === "marker")).toBe(true);
      }
    });

    it("quotes a table name from the config as one identifier (or one literal), whatever it holds", async () => {
      const hostile = 'x"; drop table users; --';
      const plan = planned(
        await engineFor(dialect, FRESH).planInstall(
          targetOf(LISTINGS, hostile),
          adminUrl(dialect),
          {
            ...DEPS,
            workerPassword: "a-long-random-password",
          },
        ),
      );
      const quoted = dialect.quoteTable(tableOf(dialect, { table: hostile }).schema, hostile);
      const script = render(dialect, plan);
      expect(script).toContain(quoted);
      // Outside its quoted forms (a dialect may also write the name as a literal: its marks' rows).
      const unquoted = script.replaceAll(quoted, "").replaceAll(dialect.quoteLiteral(hostile), "");
      expect(unquoted).not.toContain("drop table users");
    });

    it("splits an `in` list longer than the dialect allows into statements of at most its maximum", async () => {
      const client = recordingClient();
      const connector = createPollingConnector(
        dialect,
        client,
        { ...targetOf(LISTINGS), key: "id" },
        { clock: new FakeClock(), warn: () => undefined },
      );
      const keys = Array.from({ length: dialect.maxInList + 1 }, (_, index) => `k${index}`);
      await connector.read(keys);
      await connector.current(keys);
      expect(client.statements.map((statement) => statement.params.length)).toEqual([
        dialect.maxInList,
        1,
        dialect.maxInList,
        1,
      ]);
      expect(client.statements[1]?.text).toContain(dialect.inList(1));
      await connector.close();
    });

    it("binds every key, state and decision: no value is written into a connector statement", async () => {
      for (const [, statements] of await connectorStatements(dialect)) {
        for (const statement of statements) {
          for (const value of statement.params) {
            if (typeof value === "string" && value.length > 2) {
              expect(statement.text).not.toContain(value);
            }
          }
        }
      }
    });

    it("numbers each connector statement's placeholders from 1, one per bind, with no gap", async () => {
      for (const [title, statements] of await connectorStatements(dialect)) {
        for (const statement of statements) {
          const count = statement.params.length;
          expect(placeholdersIn(dialect, statement.text, count + 1), title).toEqual(
            Array.from({ length: count }, (_, index) => index + 1),
          );
        }
      }
    });

    it("never prints the worker password: the plan holds a statement run binds it to", async () => {
      const fresh = await planTitled(dialect, FRESH_INSTALL);
      expect(render(dialect, fresh)).not.toContain("a-long-random-password");
      if (dialect.login !== undefined) {
        expect(fresh.statements.filter((statement) => statement.secret === true)).toHaveLength(1);
      }
    });
  });
}
