import {
  type DecisionLog,
  decideRecord,
  type LockResult,
  type QuestionSet,
  REVIEW_LOCK_MS,
  type ReviewCard,
  type ReviewQueue,
  reviewEntryOf,
  statusOf,
} from "@facetdb/core";
import type { SqlClient, SqlQuery, SqlRow } from "../sql/index.ts";
import { createDecisionLog } from "./decision-log.ts";
import { flag, fromMs, integer, json, jsonObject, text, textOrNull, toMs } from "./rows.ts";

/**
 * `facetdb.reviews` (store migration 6) as core's `ReviewQueue`: one statement per operation, each
 * a named prepared statement on postgres.js (`SqlClient`). Every lease is compared with the
 * caller's clock, passed as milliseconds and turned into a timestamp in SQL, as the claims of
 * `facetdb.jobs` are, never with the server's `now()`: the fake clock rules the lease in tests, and
 * two workers on two machines agree on it by their clocks alone.
 */

/** A lease ends at `locked_until`: from then on another reviewer may take the card. */
const leaseLive = (now: string) => `locked_until > ${fromMs(now)}`;

const CARD_COLUMNS = `source_id, record_key, state_hash, open_questions::text as open_questions,
  numbers::text as numbers, ${toMs("since", "since_ms")}, locked_by, ${toMs("locked_until", "until_ms")}`;

const UPSERT = `insert into facetdb.reviews as r
  (source_id, record_key, state_hash, open_questions, numbers, since)
values ($1, $2, $3, $4::jsonb, $5::jsonb, ${fromMs("$6")})
on conflict (source_id, record_key) do update set
  open_questions = excluded.open_questions,
  numbers = excluded.numbers,
  since = case when r.state_hash = excluded.state_hash then r.since else excluded.since end,
  locked_by = case when r.state_hash = excluded.state_hash then r.locked_by end,
  locked_until = case when r.state_hash = excluded.state_hash then r.locked_until end,
  skipped_by = case when r.state_hash = excluded.state_hash then r.skipped_by else '[]'::jsonb end,
  state_hash = excluded.state_hash`;

const REMOVE = "delete from facetdb.reviews where source_id = $1 and record_key = $2";

const WITHDRAW = `delete from facetdb.reviews
 where source_id = $1 and record_key = $2 and state_hash = $3`;

// `$1` source, `$2` question, `$3` below, `$4` viewer, `$5` now (ms), `$6` key; null filters
// match everything. The cards the viewer may open: one clause for the listing and the count.
const OPENABLE = `where ($1::text is null or source_id = $1::text)
   and ($6::text is null or record_key = $6::text)
   and ($2::text is null or open_questions @> jsonb_build_array($2::text))
   and ($3::double precision is null or exists (
         select 1 from jsonb_each_text(numbers) as n(name, figure)
          where n.figure::double precision < $3::double precision
            and ($2::text is null or n.name = $2::text)))
   and (locked_by is null or locked_by = $4::text or not ${leaseLive("$5")})`;

// `$7` limit. The viewer's skipped cards sort after the rest, each part oldest first.
const LIST = `select ${CARD_COLUMNS}, skipped_by @> jsonb_build_array($4::text) as skipped
  from facetdb.reviews
 ${OPENABLE}
 order by skipped_by @> jsonb_build_array($4::text), since,
          source_id collate "C", record_key collate "C"
 limit $7::integer`;

// The count and the oldest card's `since` under the same clause, carrying no card.
const COUNT = `select count(*)::text as count, ${toMs("min(since)", "oldest_ms")}
  from facetdb.reviews
 ${OPENABLE}`;

/**
 * A lease statement: `taken` sets the viewer's lease when `may` holds of the row, and `standing`
 * reads the row's lease as it stands, waiting for a lease another statement is setting (`for
 * update` reads the newest committed row), so a refusal names the reviewer who won. The update
 * re-checks `may` on the newest row after waiting for it, so two reviewers never both take a card.
 * `$1` source, `$2` key, `$3` viewer, `$4` now (ms), `$5` lease (ms).
 */
function leaseSql(may: string): string {
  return `with standing as (
  select locked_by, locked_until from facetdb.reviews
   where source_id = $1 and record_key = $2
     for update
), taken as (
  update facetdb.reviews
     set locked_by = $3::text,
         locked_until = to_timestamp(($4::double precision + $5::double precision) / 1000)
   where source_id = $1 and record_key = $2 and (${may})
  returning locked_until
)
select (select ${toMs("locked_until", "until_ms")} from taken) as until_ms,
       exists (select 1 from standing) as found,
       (select locked_by from standing) as held_by,
       (select ${toMs("locked_until", "held_ms")} from standing) as held_ms`;
}

// The card is free, the viewer's own, or its lease ended.
const LOCK = leaseSql(`locked_by is null or locked_by = $3::text or not ${leaseLive("$4")}`);

// Only the viewer's own lease is extended, ended or not: nobody else took it meanwhile.
const RENEW = leaseSql("locked_by = $3::text");

const RELEASE = `update facetdb.reviews set locked_by = null, locked_until = null
 where source_id = $1 and record_key = $2 and locked_by = $3::text`;

// Behind the rest for this viewer (named once), and their lease released.
const SKIP = `update facetdb.reviews
   set skipped_by = case when skipped_by @> jsonb_build_array($3::text) then skipped_by
                         else skipped_by || jsonb_build_array($3::text) end,
       locked_by = case when locked_by = $3::text then null else locked_by end,
       locked_until = case when locked_by = $3::text then null else locked_until end
 where source_id = $1 and record_key = $2`;

export function createReviewQueue(client: SqlClient): ReviewQueue {
  const { query } = client;
  return {
    async upsert(entry) {
      await query(UPSERT, [
        entry.source,
        entry.key,
        entry.stateHash,
        JSON.stringify(entry.openQuestions),
        JSON.stringify(entry.numbers),
        entry.since.getTime(),
      ]);
    },

    async remove(source, key) {
      await query(REMOVE, [source, key]);
    },

    async withdraw(source, key, stateHash) {
      await query(WITHDRAW, [source, key, stateHash]);
    },

    async list(filter, viewer, nowMs) {
      const rows = await query(LIST, [
        filter.source ?? null,
        filter.question ?? null,
        filter.below ?? null,
        viewer,
        nowMs,
        filter.key ?? null,
        filter.limit ?? null,
      ]);
      return rows.map(toCard);
    },

    async count(filter, viewer, nowMs) {
      const [row] = await query(COUNT, [
        filter.source ?? null,
        filter.question ?? null,
        filter.below ?? null,
        viewer,
        nowMs,
        filter.key ?? null,
      ]);
      if (row === undefined) {
        throw new Error("the count of the review queue returned no row");
      }
      const oldest = textOrNull(row, "oldest_ms");
      return {
        count: integer(row, "count"),
        oldestSince: oldest === null ? undefined : new Date(Number(oldest)),
      };
    },

    lock: (source, key, viewer, nowMs) => lease(query, LOCK, [source, key, viewer, nowMs]),

    renew: (source, key, viewer, nowMs) => lease(query, RENEW, [source, key, viewer, nowMs]),

    async release(source, key, viewer) {
      await query(RELEASE, [source, key, viewer]);
    },

    async skip(source, key, viewer) {
      await query(SKIP, [source, key, viewer]);
    },
  };
}

async function lease(
  query: SqlQuery,
  statement: string,
  [source, key, viewer, nowMs]: readonly [string, string, string, number],
): Promise<LockResult> {
  const [row] = await query(statement, [source, key, viewer, nowMs, REVIEW_LOCK_MS]);
  if (row === undefined) {
    throw new Error("a lease statement returned no row");
  }
  const until = textOrNull(row, "until_ms");
  if (until !== null) {
    return { kind: "locked", until: new Date(Number(until)) };
  }
  if (!flag(row, "found")) {
    return { kind: "gone" };
  }
  const by = textOrNull(row, "held_by");
  const heldUntil = textOrNull(row, "held_ms");
  if (by !== null && heldUntil !== null && by !== viewer && Number(heldUntil) > nowMs) {
    return { kind: "held", by, until: new Date(Number(heldUntil)) };
  }
  // Only a renewal comes here: the lease is no longer the viewer's, and nobody holds a live one.
  return { kind: "lost" };
}

/** A row of `facetdb.reviews` as a card (a boundary: every column is checked). */
function toCard(row: SqlRow): ReviewCard {
  const openQuestions = json(row, "open_questions");
  if (!Array.isArray(openQuestions) || !openQuestions.every((name) => typeof name === "string")) {
    throw new Error(
      `a review row's open_questions is ${JSON.stringify(openQuestions)}, expected a list of names`,
    );
  }
  const numbers: Record<string, number> = {};
  for (const [name, figure] of Object.entries(jsonObject(row, "numbers"))) {
    if (typeof figure !== "number" || figure < 0 || figure > 1) {
      throw new Error(
        `a review row's figure for "${name}" is ${JSON.stringify(figure)}, expected a number in [0, 1]`,
      );
    }
    numbers[name] = figure;
  }
  const by = textOrNull(row, "locked_by");
  const until = textOrNull(row, "until_ms");
  return {
    source: text(row, "source_id"),
    key: text(row, "record_key"),
    stateHash: text(row, "state_hash"),
    openQuestions,
    numbers,
    since: new Date(Number(text(row, "since_ms"))),
    lock: by === null || until === null ? null : { by, until: new Date(Number(until)) },
    skipped: flag(row, "skipped"),
  };
}

/**
 * Lists the records decided needs_review before the queue existed. For each source, its latest
 * logged answer per record is decided again under the question set in force, with the people's
 * decisions on that state laid over it; a record still left to a person gets its card, waiting
 * since that answer. Idempotent: a card already at that hash keeps its `since`, lease and skips.
 * Returns how many records wait. `questionSets` maps each source's store id to its question set.
 */
export async function rebuildReviewQueue(
  queue: ReviewQueue,
  logOf: (sourceId: string) => DecisionLog,
  questionSets: ReadonlyMap<string, QuestionSet>,
): Promise<number> {
  let waiting = 0;
  for (const [source, questionSet] of questionSets) {
    const log = logOf(source);
    for (const answer of await log.latestAnswersSince(undefined)) {
      // A person can only decide more, so a record the model alone decides whole is done whatever
      // the log holds after it: only the rest read their history.
      const alone = decideRecord(questionSet, questionSet.thresholds, answer, []);
      if (alone === undefined || statusOf(alone) === "done") {
        continue;
      }
      const decisions = decideRecord(
        questionSet,
        questionSet.thresholds,
        answer,
        await log.history(answer.key),
      );
      if (decisions === undefined || statusOf(decisions) === "done") {
        continue;
      }
      await queue.upsert({
        source,
        ...reviewEntryOf({
          key: answer.key,
          stateHash: answer.stateHash,
          decisions,
          answers: answer.answers,
          since: answer.at,
        }),
      });
      waiting += 1;
    }
  }
  return waiting;
}

/**
 * The `facetdb.install` row that says the rebuild ran for one project. Per project, not per store:
 * several projects may share a store, and each one's first migrate after migration 6 lists its own
 * records (the key is length-prefixed, as the queue's job keys are, so no id can end another's).
 */
export function rebuiltKey(projectId: string): string {
  return `review_queue_rebuilt:${projectId.length}:${projectId}`;
}

/**
 * `facetdb migrate`'s door to the rebuild: it runs once per project of the store, after migration
 * 6, and is marked done in `facetdb.install` only once it finished, so a migrate stopped half way
 * runs it again (the rebuild is idempotent). `questionSets` holds that project's sources, keyed by
 * their store ids. Undefined when it had already run for the project.
 */
export async function rebuildStoreReviewQueue(
  client: SqlClient,
  projectId: string,
  questionSets: ReadonlyMap<string, QuestionSet>,
): Promise<number | undefined> {
  const key = rebuiltKey(projectId);
  const done = await client.query("select 1 from facetdb.install where key = $1", [key]);
  if (done.length > 0) {
    return undefined;
  }
  const waiting = await rebuildReviewQueue(
    createReviewQueue(client),
    (sourceId) => createDecisionLog(client, sourceId),
    questionSets,
  );
  await client.query(
    "insert into facetdb.install (key, value) values ($1, $2) on conflict (key) do nothing",
    [key, String(waiting)],
  );
  return waiting;
}
