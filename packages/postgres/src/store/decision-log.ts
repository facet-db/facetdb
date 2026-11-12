import type {
  Answer,
  AnswerEntry,
  DecisionLog,
  HumanEntry,
  HumanValue,
  LogEntry,
  LoggedUsage,
  RecordKey,
} from "@facetdb/core";
import type { SqlClient, SqlRow } from "../sql/index.ts";
import { fromMs, integer, json, jsonObject, text, textOrNull, toMs } from "./rows.ts";

const COLUMNS = `record_key, kind, version::text as version, state_hash, model, answers::text as answers,
  usage::text as usage, question, value::text as value, reviewer, note, ${toMs("at", "at_ms")}`;

/**
 * `facetdb.decisions` as core's `DecisionLog` for one source: one row per model call holding
 * every answer, one row per human decision. Rows are only ever inserted; a correction is a new row,
 * and "latest" is the highest id, which is the order the log was appended in.
 */
export function createDecisionLog(client: SqlClient, sourceId: string): DecisionLog {
  async function entries(whereRest: string, params: readonly unknown[]): Promise<LogEntry[]> {
    const rows = await client.query(
      `select ${COLUMNS} from facetdb.decisions where source_id = $1 ${whereRest}`,
      [sourceId, ...params],
    );
    return rows.map(toEntry);
  }

  return {
    async appendAnswer(entry) {
      await client.query(
        `insert into facetdb.decisions
           (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
         values ($1, $2, 'answer', $3, $4, $5, $6::jsonb, $7::jsonb, ${fromMs("$8")})`,
        [
          sourceId,
          entry.key,
          entry.version,
          entry.stateHash,
          entry.model,
          JSON.stringify(entry.answers),
          JSON.stringify(entry.usage),
          entry.at.getTime(),
        ],
      );
    },

    async appendHuman(entry) {
      await client.query(
        `insert into facetdb.decisions
           (source_id, record_key, kind, version, state_hash, question, value, reviewer, note, at)
         values ($1, $2, 'human', $3, $4, $5, $6::jsonb, $7, $8, ${fromMs("$9")})`,
        [
          sourceId,
          entry.key,
          entry.version,
          entry.stateHash,
          entry.question,
          JSON.stringify(entry.value),
          entry.reviewer,
          entry.note ?? null,
          entry.at.getTime(),
        ],
      );
    },

    async latestAnswer(key: RecordKey) {
      const found = await entries(
        "and record_key = $2 and kind = 'answer' order by id desc limit 1",
        [key],
      );
      return found.find(isAnswer);
    },

    async latestAnswers(keys) {
      const latest = new Map<RecordKey, AnswerEntry>();
      if (keys.length === 0) {
        return latest;
      }
      // One statement for a whole page: on a far database every round trip costs about
      // 200 ms, so a lookup per record set the backfill's time instead of its pace.
      const rows = await client.query(
        `select distinct on (record_key) ${COLUMNS}
           from facetdb.decisions
          where source_id = $1 and kind = 'answer' and record_key = any($2::text[])
          order by record_key, id desc`,
        [sourceId, [...keys]],
      );
      for (const entry of rows.map(toEntry).filter(isAnswer)) {
        latest.set(entry.key, entry);
      }
      return latest;
    },

    history(key: RecordKey) {
      return entries("and record_key = $2 order by id", [key]);
    },

    async latestAnswersSince(version) {
      const rows = await client.query(
        `select * from (
           select distinct on (record_key) ${COLUMNS}
             from facetdb.decisions
            where source_id = $1 and kind = 'answer'
            order by record_key, id desc
         ) latest
          where $2::integer is null or version::integer >= $2::integer
          order by record_key`,
        [sourceId, version ?? null],
      );
      return rows.map(toEntry).filter(isAnswer);
    },
  };
}

function isAnswer(entry: LogEntry): entry is AnswerEntry {
  return entry.kind === "answer";
}

/** A row of `facetdb.decisions` becomes a log entry; a row of neither kind is a corrupt store. */
function toEntry(row: SqlRow): LogEntry {
  const common = {
    key: text(row, "record_key"),
    version: integer(row, "version"),
    stateHash: text(row, "state_hash"),
    at: new Date(Number(text(row, "at_ms"))),
  };
  const kind = text(row, "kind");
  if (kind === "answer") {
    return {
      kind,
      ...common,
      model: text(row, "model"),
      answers: jsonObject(row, "answers") as Readonly<Record<string, Answer>>,
      usage: jsonObject(row, "usage") as LoggedUsage,
    };
  }
  if (kind === "human") {
    const note = textOrNull(row, "note");
    return {
      kind,
      ...common,
      question: text(row, "question"),
      value: json(row, "value") as HumanValue,
      reviewer: text(row, "reviewer"),
      ...(note === null ? {} : { note }),
    } satisfies HumanEntry;
  }
  throw new Error(`a decision row has kind "${kind}", expected "answer" or "human"`);
}
