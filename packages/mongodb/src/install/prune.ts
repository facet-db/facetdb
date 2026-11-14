import {
  answerColumns,
  type EngineDeps,
  type EngineObject,
  type EnginePlan,
  type EngineTarget,
  type KeptObject,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import { adminUrlRefusal } from "../urls/index.ts";
import type { AdminConnect } from "./admin.ts";
import { readMarker, subdocumentFields } from "./catalog.ts";
import { anotherProjectWords, planWithAdmin, refusedWith, sourceDatabase } from "./install.ts";
import { printLine } from "./mongosh.ts";
import { ownedFields, SUBDOCUMENT } from "./objects.ts";

/**
 * `facetdb migrate --prune` on MongoDB: a question removed from the set keeps its fields until the
 * operator asks for them to go, so nothing is destroyed silently. MongoDB keeps no schema to read
 * them from, so the plan reads which fields the documents hold under `facetdb` and unsets the ones
 * no question of the set owns, and nothing else: never a status field, never a field outside the
 * subdocument. A choice question's `_probabilities` field stays after `storeProbabilities` went
 * off, as its Postgres column does: the operator turned off the storing, not the question. MongoDB
 * grants no field-level rights, so a state field `read` no longer lists has no right to take back.
 */

/** A source not installed yet has nothing to prune: an empty plan, not a refusal. */
const NOTHING: EnginePlan = {
  statements: [],
  transactional: false,
  removes: [],
  keeps: [],
  notes: [],
};

/** Why a field of a question still in the set stays, in the words Postgres keeps its column with. */
const KEPT_REASON = "storeProbabilities is off";

/** Every field a question of this name could have, whatever its type (`answerColumns` of each). */
function fieldsOfAnyType(name: string): ReadonlySet<string> {
  const base = { name, instructions: "", stakes: "low" } as const;
  return new Set(
    [
      answerColumns({ ...base, type: "noul" }),
      answerColumns({ ...base, type: "choice", options: [], storeProbabilities: true }),
      answerColumns({ ...base, type: "score", levels: [] }),
    ].flatMap((columns) => columns.map((column) => `${SUBDOCUMENT}.${column.name}`)),
  );
}

/** The `_probabilities` fields of the set's choice questions, whether it stores them or not. */
function probabilityFields(questionSet: QuestionSet): ReadonlySet<string> {
  return new Set(
    questionSet.questions.flatMap((question) =>
      question.type === "choice"
        ? answerColumns({ ...question, storeProbabilities: true })
            .filter((column) => column.role === "probabilities")
            .map((column) => `${SUBDOCUMENT}.${column.name}`)
        : [],
    ),
  );
}

export async function planPrune(
  connect: AdminConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, deps.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const source = sourceDatabase(target, url, "prune-refused");
  if (!source.ok) {
    return { ok: false, refusal: source.refusal };
  }
  const { database } = source;
  const collection = target.table;
  const label = `${database}.${collection}`;
  return planWithAdmin(connect, url, deps.allowInsecure, async (client) => {
    const marker = await readMarker(client, database, collection);
    if (marker === undefined) {
      return { ok: true, plan: NOTHING };
    }
    if (marker.project !== target.project.id) {
      return {
        ok: false,
        refusal: refusedWith(
          "prune-refused",
          anotherProjectWords(database, collection, marker.project),
        ),
      };
    }
    const owned = new Set(ownedFields(target.questionSet));
    const probabilities = probabilityFields(target.questionSet);
    const stillAsked = target.questionSet.questions.map((question) =>
      fieldsOfAnyType(question.name),
    );
    const unowned = (await subdocumentFields(client, database, collection)).filter(
      (field) => !owned.has(field),
    );
    const dropped = unowned.filter((field) => !probabilities.has(field));
    const keeps = unowned
      .filter((field) => probabilities.has(field))
      .map(
        (name): KeptObject => ({
          kind: "field",
          name,
          of: label,
          scope: "source",
          reason: KEPT_REASON,
        }),
      );
    if (dropped.length === 0) {
      return { ok: true, plan: { ...NOTHING, keeps } };
    }
    return {
      ok: true,
      plan: {
        statements: [
          {
            database: "source",
            purpose: "columns",
            text: printLine({
              database,
              command: {
                update: collection,
                updates: [
                  {
                    q: {},
                    u: { $unset: Object.fromEntries(dropped.map((field) => [field, ""])) },
                    multi: true,
                  },
                ],
              },
            }),
          },
        ],
        transactional: false,
        removes: dropped.map(
          (name): EngineObject => ({
            kind: "field",
            name,
            of: label,
            scope: "source",
            reason: stillAsked.some((fields) => fields.has(name))
              ? "its question changed type"
              : "no question asks it any more",
          }),
        ),
        keeps,
        notes: [
          `Removing these fields writes every document of ${label} that has one, an update each in the oplog: on a large collection, run it when the replica set can take the load.`,
        ],
      },
    };
  });
}
