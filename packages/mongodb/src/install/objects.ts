import { answerColumns, type QuestionSet } from "@facetdb/core";

/**
 * What FacetDB adds to a MongoDB database, and its names: the jobs collection with its two indexes,
 * the marker collection, the worker's role on one collection and the worker login, and the
 * `facetdb` subdocument the worker writes in each document. Every name carries the `facetdb`
 * prefix. The database is the source's: `schema` in the config's `database.collection`, else the
 * one the connection string names.
 */

/**
 * The queue: one per database, shared by every collection installed there. A job is one document,
 * `{ collection, record_key, claimed_at, claimed_by }`: the collection it is for beside the plain
 * key (the connector maps it back to `_id`), so two collections' keys never collide, and a
 * collection's jobs are claimed and deleted by equality on `collection` (one rule for every engine:
 * the SQL engines key their shared queue by table name and record key).
 */
export const JOBS_COLLECTION = "facetdb_jobs";

/** The field of a job that names the collection it is for. */
export const JOB_COLLECTION_FIELD = "collection";

/** The markers: which project installed on which collection of the database. */
export const META_COLLECTION = "facetdb_meta";

/** The worker login, the one credential FacetDB stores; it lives in the source's database. */
export const WORKER_USER = "facetdb_worker";

/** The subdocument every answer and status field lives in. */
export const SUBDOCUMENT = "facetdb";

/** The worker's rights on one collection: a role per collection, granted to the one login. */
export function workerRole(collection: string): string {
  return `${WORKER_USER}_${collection}`;
}

/** The marker document's `_id` for a collection in `facetdb_meta`. */
export function markerId(collection: string): string {
  return `owner:${collection}`;
}

/** FacetDB's own fields beside the answers, and the hash `write` compares. */
export const STATUS_FIELDS = ["status", "updated_at", "reviewed", "state_hash"] as const;

/**
 * Every field the subdocument holds under this question set, as dotted paths, answers first in
 * question order (the names `answerColumns` gives every engine), then the status fields.
 */
export function ownedFields(questionSet: QuestionSet): readonly string[] {
  return [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map((column) => column.name),
    ),
    ...STATUS_FIELDS,
  ].map((name) => `${SUBDOCUMENT}.${name}`);
}

/** One index of the jobs collection: its fields in key order, each ascending, and MongoDB's name. */
export type JobsIndex = {
  readonly fields: readonly string[];
  readonly name: string;
  readonly unique: boolean;
};

/**
 * The jobs collection's indexes, each led by the collection a job is for: the unique key that makes
 * several changes before the worker arrives one job (without it duplicates pile up silently), and
 * the claim time the connector finds a collection's free and expired claims by.
 */
export const JOBS_INDEXES: readonly JobsIndex[] = [
  {
    fields: [JOB_COLLECTION_FIELD, "record_key"],
    name: "collection_1_record_key_1",
    unique: true,
  },
  {
    fields: [JOB_COLLECTION_FIELD, "claimed_at"],
    name: "collection_1_claimed_at_1",
    unique: false,
  },
];

/** A right on one collection, as `createRole` takes it. */
export type Privilege = {
  readonly resource: { readonly db: string; readonly collection: string };
  readonly actions: readonly string[];
};

/**
 * The least the worker needs: read and update the collection and follow its change stream; read,
 * add, claim and remove jobs; read the markers. MongoDB grants on whole collections, never on
 * fields, so the plan's notes say the worker reads every field.
 */
export function workerPrivileges(database: string, collection: string): readonly Privilege[] {
  return [
    { resource: { db: database, collection }, actions: ["find", "update", "changeStream"] },
    {
      resource: { db: database, collection: JOBS_COLLECTION },
      actions: ["find", "insert", "update", "remove"],
    },
    { resource: { db: database, collection: META_COLLECTION }, actions: ["find"] },
  ];
}
