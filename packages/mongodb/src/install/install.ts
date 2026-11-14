import type {
  EngineTarget,
  InstallOptions,
  PlanResult,
  PlanStatement,
  Refusal,
} from "@facetdb/core";
import { adminUrlRefusal, databaseOf, hostsOf, subjectOf, tlsVerdict } from "../urls/index.ts";
import { type AdminClient, type AdminConnect, driverFloor } from "./admin.ts";
import {
  collectionType,
  deployment,
  holdsSubdocument,
  type IndexInfo,
  jobsIndexes,
  markedCollections,
  readLogin,
  readMarker,
  readRole,
} from "./catalog.ts";
import { inWords, loginPart, unseenNotes } from "./login.ts";
import { type CommandDocument, printLine } from "./mongosh.ts";
import {
  JOBS_COLLECTION,
  JOBS_INDEXES,
  type JobsIndex,
  META_COLLECTION,
  markerId,
  ownedFields,
  SUBDOCUMENT,
  WORKER_USER,
  workerRole,
} from "./objects.ts";

/**
 * The install plan for a MongoDB collection: the marker, the jobs collection and its two indexes,
 * the worker's role on the collection and the worker login, each a command printed as the mongosh
 * line `run` sends. MongoDB has no DDL to wrap in a transaction (`transactional: false`): a run
 * that stops keeps what ran, and every command is idempotent, so the same plan run again finishes
 * it. What exists already is read first and left out, so a plan for an installed collection is
 * empty. The answers need no command: they are fields of the `facetdb` subdocument the worker
 * writes, and install touches no document. The marker goes first: a run that another project's
 * marker stops has changed nothing, and an uninstall's guard sees an install in flight. MongoDB 4.4
 * and later: the driver's floor.
 */

/**
 * The fix of every refusal whose message says what to change: the Postgres engine's sentence, word
 * for word, so a refusal of one kind points at one docs page whatever the engine.
 */
export const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/** The code of each plan's refusals, as the Postgres engine names them. */
export type RefusalCode = "migrate-refused" | "uninstall-refused" | "prune-refused";

/** A refusal whose message says what to change, under the code of the plan that refused. */
export function refusedWith(code: RefusalCode, message: string): Refusal {
  return { code, message, fix: REFUSED_FIX };
}

/** The databases MongoDB keeps for itself; FacetDB installs beside an application's collections only. */
const SYSTEM_DATABASES: ReadonlySet<string> = new Set(["admin", "local", "config"]);

/** The source's database: the config's `database.collection`, else the connection string's path. */
export function sourceDatabase(
  target: Pick<EngineTarget, "schema">,
  url: string,
  code: RefusalCode,
):
  | { readonly ok: true; readonly database: string }
  | { readonly ok: false; readonly refusal: Refusal } {
  const database = target.schema ?? databaseOf(url);
  const way =
    "name the source's database in the connection string (mongodb://host/<database>) or in the config's table as <database>.<collection>";
  if (database === undefined) {
    return {
      ok: false,
      refusal: refusedWith(
        code,
        `the admin connection string names no database, and the source's table names none either: ${way}.`,
      ),
    };
  }
  if (SYSTEM_DATABASES.has(database)) {
    return {
      ok: false,
      refusal: refusedWith(
        code,
        `the source's database would be ${database}, which MongoDB keeps for itself: ${way}.`,
      ),
    };
  }
  return { ok: true, database };
}

/**
 * Opens the admin connection for one plan and closes it whatever happens; the TLS rule was applied
 * before (`adminUrlRefusal`), so the string here is one the operator may use.
 */
export async function withAdmin<T>(
  connect: AdminConnect,
  url: string,
  allowInsecure: boolean,
  work: (client: AdminClient) => Promise<T>,
): Promise<T> {
  const verdict = tlsVerdict(url, allowInsecure);
  const client = connect(url, { forceTls: verdict.kind === "ok" && verdict.forceTls });
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * A server the driver refused at the handshake as older than its floor (`driverFloor`, read from
 * the driver's own words), in words naming both.
 */
export function belowFloor(url: string, floor: string): Refusal {
  return {
    code: "server-version",
    message: `the MongoDB server at ${hostsOf(url)} is older than MongoDB ${floor}: the mongodb driver FacetDB connects with talks to ${floor} and later only, and refused it at the handshake; nothing was changed`,
    fix: `upgrade the server to MongoDB ${floor} or later, as a replica set; every Atlas cluster already runs one`,
  };
}

/** `withAdmin` for a plan: a server older than the driver's floor is a refusal, not a raw error. */
export async function planWithAdmin(
  connect: AdminConnect,
  url: string,
  allowInsecure: boolean,
  work: (client: AdminClient) => Promise<PlanResult>,
): Promise<PlanResult> {
  try {
    return await withAdmin(connect, url, allowInsecure, work);
  } catch (error) {
    const floor = driverFloor(error);
    if (floor !== undefined) {
      return { ok: false, refusal: belowFloor(url, floor) };
    }
    throw error;
  }
}

const refused = (refusal: Refusal): PlanResult => ({ ok: false, refusal });

/** Change streams follow a replica set's oplog: a standalone server is refused. */
function noReplicaSet(url: string): Refusal {
  return {
    code: "no-replica-set",
    message: `the MongoDB server at ${hostsOf(url)} is a standalone mongod: FacetDB follows changes with change streams, which only a replica set has (one node is enough); nothing was changed`,
    fix: "restart mongod as a one-node replica set (mongod --replSet rs0, or replication.replSetName: rs0 in mongod.conf), run rs.initiate() once in mongosh, and connect with ?replicaSet=rs0; on Atlas every cluster is already a replica set: use the connection string from its Connect button, which reaches the whole cluster",
  };
}

/** Whether an index has these fields in this order, each ascending. */
function onFields(index: IndexInfo, wanted: JobsIndex): boolean {
  return (
    index.ascending &&
    index.fields.length === wanted.fields.length &&
    index.fields.every((field, at) => field === wanted.fields[at])
  );
}

/** The jobs collection's statements: made when absent, its indexes when missing, a foreign index refused. */
function queueStatements(
  database: string,
  indexes: readonly IndexInfo[] | undefined,
): { readonly statements: readonly PlanStatement[] } | { readonly refusal: Refusal } {
  const missing: JobsIndex[] = [];
  for (const wanted of JOBS_INDEXES) {
    const same = indexes?.find((index) => onFields(index, wanted));
    const named = indexes?.find((index) => index.name === wanted.name);
    const foreign = same === undefined ? named : same.unique === wanted.unique ? undefined : same;
    if (foreign !== undefined) {
      return {
        refusal: refusedWith(
          "migrate-refused",
          `${database}.${JOBS_COLLECTION} has an index ${foreign.name} that is not FacetDB's (FacetDB's ${wanted.name} is ${wanted.unique ? "unique" : "a plain index"} on ${wanted.fields.join(", ")}); the jobs collection is FacetDB's: drop it with db.getSiblingDB(${JSON.stringify(database)}).${JOBS_COLLECTION}.dropIndex(${JSON.stringify(foreign.name)}).`,
        ),
      };
    }
    if (same === undefined) {
      missing.push(wanted);
    }
  }
  const line = (command: CommandDocument): PlanStatement => ({
    database: "source",
    purpose: "queue",
    text: printLine({ database, command }),
  });
  return {
    statements: [
      ...(indexes === undefined ? [line({ create: JOBS_COLLECTION })] : []),
      ...(missing.length === 0
        ? []
        : [
            line({
              createIndexes: JOBS_COLLECTION,
              indexes: missing.map(({ fields, name, unique }) => ({
                key: Object.fromEntries(fields.map((field) => [field, 1])),
                name,
                ...(unique ? { unique: true } : {}),
              })),
            }),
          ]),
    ],
  };
}

/**
 * The marker: `{ _id: "owner:<collection>", project, source, installedAt }` in `facetdb_meta`, the
 * time set by the server (`$currentDate`). The query names the project, so a marker another project
 * wrote since the plan was read makes the upsert a duplicate key. `findAndModify` fails with it
 * outright, where an `update` would only list it among its write errors: the script run by hand in
 * mongosh stops there, and `run` stops with `another-project`, before anything else ran.
 */
function markerStatement(database: string, target: EngineTarget): PlanStatement {
  return {
    database: "source",
    purpose: "marker",
    text: printLine({
      database,
      command: {
        findAndModify: META_COLLECTION,
        query: { _id: markerId(target.table), project: target.project.id },
        update: {
          $set: { project: target.project.id, source: target.source },
          $currentDate: { installedAt: true },
        },
        upsert: true,
      },
    }),
  };
}

/** The words of a collection another project installed on, as Postgres says them of a table. */
export function anotherProjectWords(
  database: string,
  collection: string,
  owner: string | undefined,
): string {
  return `${database}.${collection} already carries FacetDB from another project${owner === undefined ? "" : ` (${owner})`}; one collection belongs to one project. Uninstall there first, or point this project at another collection.`;
}

/** What the operator is told beside an install's commands. */
function installNotes(target: EngineTarget, database: string): readonly string[] {
  return [
    `MongoDB grants rights on whole collections, never on single fields: ${WORKER_USER} can read every field of ${database}.${target.table}, not only ${inWords(target.questionSet.read)}, and can update any of them; FacetDB's worker writes only the ${SUBDOCUMENT} field.`,
    `The answers go in each document's ${SUBDOCUMENT} field (${inWords(ownedFields(target.questionSet))}); the worker writes them, and this install changes no document.`,
    "MongoDB runs these commands one at a time, with no transaction: if one fails, the ones before it stay, and running facetdb migrate again finishes the install.",
  ];
}

export async function planInstall(
  connect: AdminConnect,
  target: EngineTarget,
  url: string,
  options: InstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return refused(insecure);
  }
  const source = sourceDatabase(target, url, "migrate-refused");
  if (!source.ok) {
    return refused(source.refusal);
  }
  const { database } = source;
  const collection = target.table;
  const label = `${database}.${collection}`;
  if (target.storage === "side-table") {
    return refused(
      refusedWith(
        "migrate-refused",
        `${label}: MongoDB keeps the answers in each document's ${SUBDOCUMENT} field, and has no side-table mode; remove storage: "side-table" from the source.`,
      ),
    );
  }
  // A state field FacetDB writes would fire the change stream on the worker's own write and queue
  // the record again forever (the Postgres engine's circular state column, in the same words).
  const circular = target.questionSet.read.filter(
    (field) => field === SUBDOCUMENT || field.startsWith(`${SUBDOCUMENT}.`),
  );
  if (circular.length > 0) {
    return refused(
      refusedWith(
        "migrate-refused",
        `${label}: the state field ${circular.join(", ")} is a field FacetDB writes; a state field must be the application's own field, or the worker's writes would re-queue every record.`,
      ),
    );
  }
  return planWithAdmin(connect, url, options.allowInsecure, async (client) => {
    if ((await deployment(client)) === "standalone") {
      return refused(noReplicaSet(url));
    }
    const type = await collectionType(client, database, collection);
    if (type === undefined) {
      return refused(
        refusedWith(
          "migrate-refused",
          `${label} does not exist: MongoDB makes a collection with its first document, and FacetDB follows an existing one. Check the collection's name in the config and the database in the connection string; for a collection with no document yet, run db.getSiblingDB(${JSON.stringify(database)}).createCollection(${JSON.stringify(collection)}) first.`,
        ),
      );
    }
    if (type !== "collection") {
      return refused(
        refusedWith(
          "migrate-refused",
          `${label} is a ${type}, and change streams follow collections only; point the source at the collection the ${type} reads from.`,
        ),
      );
    }
    const marker = await readMarker(client, database, collection);
    if (marker !== undefined && marker.project !== target.project.id) {
      return refused(
        refusedWith("migrate-refused", anotherProjectWords(database, collection, marker.project)),
      );
    }
    // With no marker the field is not known to be FacetDB's: the application's, which the answers
    // would overwrite and an uninstall remove from every document, or FacetDB's own from an
    // install whose marker went (facetdb_meta dropped by hand, or by an uninstall beside an
    // install). Only the operator can tell, so the words give both ways out. With a marker
    // present it is FacetDB's.
    if (marker === undefined && (await holdsSubdocument(client, database, collection))) {
      const unset = printLine({
        database,
        command: {
          update: collection,
          updates: [{ q: {}, u: { $unset: { [SUBDOCUMENT]: "" } }, multi: true }],
        },
      });
      return refused(
        refusedWith(
          "migrate-refused",
          `${label} already has documents with a field named ${SUBDOCUMENT}, and ${META_COLLECTION} holds no marker for it: FacetDB keeps its answers in that field. If the field is the application's, rename it, or point this source at another collection. If it is FacetDB's own, left by an earlier install whose marker is gone (${META_COLLECTION} dropped by hand, or by an uninstall that ran beside an install), remove it from every document with ${unset}, or put the marker back with ${markerStatement(database, target).text}; then run the command again.`,
        ),
      );
    }
    const queue = queueStatements(database, await jobsIndexes(client, database));
    if ("refusal" in queue) {
      return refused(queue.refusal);
    }
    const role = await readRole(client, database, workerRole(collection));
    const login = await readLogin(client, database);
    const part = loginPart({
      database,
      collection,
      role,
      login,
      workerPassword: options.workerPassword,
      subject: subjectOf(target),
      // What the login may hold besides this collection's role: the other installs' roles.
      installed:
        login.kind === "found" ? (await markedCollections(client, database, {})).collections : [],
    });
    if (part.kind === "refused") {
      return refused(part.refusal);
    }
    const statements = [
      ...(marker?.source === target.source ? [] : [markerStatement(database, target)]),
      ...queue.statements,
      ...(part.kind === "planned" ? part.statements : []),
    ];
    return {
      ok: true,
      plan: {
        statements,
        transactional: false,
        removes: [],
        keeps: [],
        notes: [
          ...(statements.length === 0 ? [] : installNotes(target, database)),
          ...(part.kind === "planned" ? part.notes : unseenNotes(database, collection)),
        ],
      },
    };
  });
}
