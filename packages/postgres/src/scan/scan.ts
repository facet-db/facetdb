import {
  type QuestionSet,
  type ReadRow,
  type ScanCursor,
  type ScanPage,
  STATUS_COLUMN,
  type StateValue,
  stateHash,
} from "@facetdb/core";
import { quoteIdent, quoteTable, type SqlQuery, type SqlRow } from "../sql/index.ts";
import { type StorageMode, sideTableRelation } from "./side-table.ts";

/**
 * `scan` for a Postgres table source: every record, newest first, in pages of 500, from a cursor
 * that survives a restart. The newest record is the one with the latest creation marker
 * (`created_at`, when the table has one), else the highest primary key. The cursor is keyset,
 * never an offset, so rows that arrive or get answered between pages neither shift a page nor
 * repeat a record.
 */

/** Records per page (the polling connector pages the same way). */
export const SCAN_PAGE_SIZE = 500;

/** The column that marks when a record was created, when the table has it. */
export const CREATION_COLUMN = "created_at";

/** Column types a creation marker may have: anything else would not order by time. */
const MARKER_TYPES: ReadonlySet<string> = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
  "date",
]);

export type ScanSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string;
  readonly key: string;
  /** Where the stored status lives; defaults to the table itself. */
  readonly storage?: StorageMode;
};

/**
 * Records already answered at this question-set version are left out of the pages, by the query:
 * a record whose stored status is `done` and whose answer is in the decision log at `version`.
 * `sourceId` names the source in `facetdb.decisions`. A database whose log does not exist yet has
 * answered nothing, so nothing is left out.
 */
export type SkipDone = {
  readonly sourceId: string;
  readonly version: number;
};

export type ScanOptions = {
  /** The worker login's connection (or PGlite in a test). */
  readonly query: SqlQuery;
  readonly source: ScanSource;
  readonly questionSet: QuestionSet;
  readonly skipDone?: SkipDone;
  /** Defaults to 500; a test pages smaller to cross page boundaries. */
  readonly pageSize?: number;
};

type Marker = { readonly type: string };

/** What a cursor holds: the last key handed out and, when ordering by creation, its marker. */
type Position = { readonly key: string; readonly created?: string | null };

/**
 * Builds `scan` for one source. The creation marker is looked up once, at the first page; a cursor
 * is plain text (the last key seen and, with a marker, its value), so a new process resumes from a
 * saved one without any state of this closure.
 */
export function createScan(options: ScanOptions): (cursor: ScanCursor | null) => Promise<ScanPage> {
  const { query, source, questionSet, skipDone } = options;
  const pageSize = options.pageSize ?? SCAN_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const schema = source.schema ?? "public";
  const table = quoteTable({ schema, name: source.table });
  const keyColumn = quoteIdent(source.key);
  const fields = questionSet.read;
  const excluded =
    questionSet.where === undefined ? "false" : `not coalesce((${questionSet.where}), false)`;

  let marker: Promise<Marker | undefined> | undefined;
  const findMarker = (): Promise<Marker | undefined> => {
    marker ??= query(
      `select data_type from information_schema.columns
        where table_schema = $1 and table_name = $2 and column_name = $3`,
      [schema, source.table, CREATION_COLUMN],
    ).then((rows) => {
      const type = rows[0]?.["data_type"];
      return typeof type === "string" && MARKER_TYPES.has(type) ? { type } : undefined;
    });
    return marker;
  };

  /**
   * The `done at this version` test as a SQL condition, or nothing to leave out. The source id and
   * the version are bound through `bind`, never spliced into the text.
   */
  async function doneCondition(bind: (value: unknown) => string): Promise<string | undefined> {
    if (skipDone === undefined) {
      return undefined;
    }
    const present = await query(`select to_regclass('facetdb.decisions') is not null as present`);
    if (present[0]?.["present"] !== true) {
      return undefined;
    }
    const status = quoteIdent(STATUS_COLUMN);
    const storedStatus =
      source.storage === "side-table"
        ? `coalesce((select s.${status} from ${sideTableRelation(source)} s where s.${keyColumn} = ${table}.${keyColumn}), 'pending')`
        : `${table}.${status}`;
    return `(${storedStatus} = 'done' and exists (
      select 1 from facetdb.decisions d
       where d.source_id = ${bind(skipDone.sourceId)} and d.record_key = ${table}.${keyColumn}::text
         and d.kind = 'answer' and d.version = ${bind(skipDone.version)}))`;
  }

  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    const found = await findMarker();
    const position = cursor === null ? undefined : parseCursor(cursor, found !== undefined);
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const conditions: string[] = [];
    if (position !== undefined) {
      if (found === undefined) {
        conditions.push(`${keyColumn} < ${bind(position.key)}`);
      } else {
        const created = quoteIdent(CREATION_COLUMN);
        const key = bind(position.key);
        if (position.created === null || position.created === undefined) {
          // Nulls sort last: after a null marker only smaller keys among the nulls remain.
          conditions.push(`(${created} is null and ${keyColumn} < ${key})`);
        } else {
          const at = `${bind(position.created)}::${found.type}`;
          conditions.push(
            `(${created} < ${at} or (${created} = ${at} and ${keyColumn} < ${key}) or ${created} is null)`,
          );
        }
      }
    }
    const done = await doneCondition(bind);
    if (done !== undefined) {
      conditions.push(`not ${done}`);
    }

    const columns = [
      `${keyColumn}::text as k`,
      ...fields.map((field, index) => `${quoteIdent(field)}::text as s${index}`),
      `${excluded} as x`,
      // JSON output is ISO 8601 whatever the session's DateStyle, so a cursor saved under one
      // session restarts the same under another; `::text` would follow DateStyle.
      ...(found === undefined ? [] : [`to_json(${quoteIdent(CREATION_COLUMN)}) #>> '{}' as c`]),
    ];
    const order =
      found === undefined
        ? `${keyColumn} desc`
        : `${quoteIdent(CREATION_COLUMN)} desc nulls last, ${keyColumn} desc`;
    const rows = await query(
      `select ${columns.join(", ")} from ${table}${
        conditions.length === 0 ? "" : ` where ${conditions.join(" and ")}`
      } order by ${order} limit ${bind(pageSize + 1)}`,
      params,
    );

    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      rows: page.map((row) => toReadRow(row, fields, source.key)),
      next:
        rows.length > pageSize && last !== undefined
          ? encodeCursor(last, found !== undefined)
          : null,
    };
  }

  return scan;
}

/** The database boundary: a row from the driver becomes a `ReadRow`, or an error naming the column. */
function toReadRow(row: SqlRow, fields: readonly string[], keyColumn: string): ReadRow {
  const state: Record<string, StateValue> = {};
  fields.forEach((field, index) => {
    state[field] = textOrNull(row[`s${index}`], field);
  });
  return {
    key: requireText(row["k"], keyColumn),
    state,
    hash: stateHash(fields, state),
    excluded: row["x"] === true,
  };
}

function encodeCursor(row: SqlRow, ordersByCreation: boolean): ScanCursor {
  const key = requireText(row["k"], "key");
  const position: Position = ordersByCreation
    ? { key, created: textOrNull(row["c"], CREATION_COLUMN) }
    : { key };
  return JSON.stringify(position);
}

/**
 * A cursor is data the caller persisted: check it at the boundary. One saved under the other
 * ordering (a creation marker added or removed since) cannot be continued, and says so.
 */
function parseCursor(cursor: ScanCursor, ordersByCreation: boolean): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error(`the scan cursor ${JSON.stringify(cursor)} is not one this scan handed out`);
  }
  if (typeof parsed !== "object" || parsed === null || !("key" in parsed)) {
    throw new Error(`the scan cursor ${JSON.stringify(cursor)} is not one this scan handed out`);
  }
  const { key } = parsed;
  const created = "created" in parsed ? parsed.created : undefined;
  if (
    typeof key !== "string" ||
    (created !== undefined && created !== null && typeof created !== "string")
  ) {
    throw new Error(`the scan cursor ${JSON.stringify(cursor)} is not one this scan handed out`);
  }
  if ((created !== undefined) !== ordersByCreation) {
    throw new Error(
      `the scan cursor was saved when the table ${ordersByCreation ? "had no" : "had a"} ${CREATION_COLUMN} column; start the backfill again`,
    );
  }
  return created === undefined ? { key } : { key, created };
}

function textOrNull(value: unknown, column: string): string | null {
  return value === null ? null : requireText(value, column);
}

function requireText(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}
