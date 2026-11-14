import type {
  EngineObject,
  EngineTarget,
  KeptObject,
  PlanResult,
  PlanStatement,
  StatementPurpose,
  UninstallOptions,
} from "@facetdb/core";
import { adminUrlRefusal } from "../urls/index.ts";
import type { AdminClient, AdminConnect } from "./admin.ts";
import { markedCollections, readMarker, readRole } from "./catalog.ts";
import { anotherProjectWords, planWithAdmin, refusedWith, sourceDatabase } from "./install.ts";
import { inWords } from "./login.ts";
import { type CommandDocument, type MongoshLine, printLine } from "./mongosh.ts";
import {
  JOB_COLLECTION_FIELD,
  JOBS_COLLECTION,
  META_COLLECTION,
  markerId,
  SUBDOCUMENT,
  WORKER_USER,
  workerRole,
} from "./objects.ts";

/**
 * The uninstall plan for a MongoDB collection: what install added goes, after the project's name is
 * typed back. In order: the `facetdb` field of every document, the collection's queued jobs (by
 * equality on the job's `collection`), the worker's role on it, its marker; then the jobs and
 * marker collections, each by a line that drops it only while `facetdb_meta` holds no marker, so
 * the last collection of a database to go takes them and an earlier one leaves them to the
 * collections still installed (the contract's run-time check; `alsoUninstalling` changes the words,
 * never the lines). The marker goes after the rest, so a run that stops leaves an install the next
 * plan still finds and finishes. The worker login stays: other collections and projects may share
 * it; so does a role made by hand in `admin` (Atlas), named with the step to drop it. The decision
 * log is in the FacetDB store, whose door the CLI owns: `--purge` changes nothing here but the plan
 * for a collection with no install left, which purges only the log.
 */

/** Why the login stays, as Postgres says it of its logins. */
const LOGIN_KEPT =
  "uninstall never drops it: other collections and projects of the database may share it";

/** Why a role made by hand in `admin` stays, and how it goes. */
const HANDMADE_KEPT =
  "made by hand in admin, where FacetDB drops no role (Atlas keeps roles to its own pages): delete it in Database Access, Custom Roles, once nothing uses it";

function line(
  database: string,
  purpose: StatementPurpose,
  command: CommandDocument,
  unlessAny?: MongoshLine["unlessAny"],
): PlanStatement {
  return {
    database: "source",
    purpose,
    text: printLine({ database, command, ...(unlessAny === undefined ? {} : { unlessAny }) }),
  };
}

/** A collection's install is gone but its log may not be: the plan purges the log alone. */
async function logOnlyPurge(
  client: AdminClient,
  target: EngineTarget,
  database: string,
): Promise<PlanResult> {
  // The log is keyed by the project and the source's name: another collection installed under the
  // same pair writes it still.
  const sharing = await markedCollections(client, database, {
    project: target.project.id,
    source: target.source,
  });
  const [other] = sharing.collections;
  if (other !== undefined) {
    return {
      ok: false,
      refusal: refusedWith(
        "uninstall-refused",
        `the decision log of source "${target.source}" may be shared with ${database}.${other} (project ${target.project.id}), which is still installed; uninstall that collection first, or keep the log. Nothing was changed.`,
      ),
    };
  }
  return {
    ok: true,
    plan: {
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [
        `${database}.${target.table} has no FacetDB install left; only the decision log is purged.`,
      ],
      confirm: { kind: "source", name: target.source },
    },
  };
}

export async function planUninstall(
  connect: AdminConnect,
  target: EngineTarget,
  url: string,
  options: UninstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const source = sourceDatabase(target, url, "uninstall-refused");
  if (!source.ok) {
    return { ok: false, refusal: source.refusal };
  }
  const { database } = source;
  const collection = target.table;
  const label = `${database}.${collection}`;
  return planWithAdmin(connect, url, options.allowInsecure, async (client) => {
    const marker = await readMarker(client, database, collection);
    if (marker === undefined) {
      return options.purge
        ? logOnlyPurge(client, target, database)
        : {
            ok: false,
            refusal: refusedWith(
              "uninstall-refused",
              `FacetDB is not installed on ${label} (${META_COLLECTION} has no marker for it); run migrate first, or check the source's database and collection.`,
            ),
          };
    }
    if (marker.project !== target.project.id) {
      // Its uninstall is the owning project's: from here it would take that project's answers.
      return {
        ok: false,
        refusal: refusedWith(
          "uninstall-refused",
          anotherProjectWords(database, collection, marker.project),
        ),
      };
    }
    const role = await readRole(client, database, workerRole(collection));
    // Atlas's custom role, made by hand from the install's steps, where the role would be.
    const handmade =
      role.kind === "absent" ? await readRole(client, "admin", workerRole(collection)) : role;
    // The run's words: the collections of this database still installed once the run is done.
    const leaving = [
      collection,
      ...options.alsoUninstalling
        .filter((other) => {
          const where = sourceDatabase(other, url, "uninstall-refused");
          return where.ok && where.database === database;
        })
        .map((other) => other.table),
    ];
    const remaining = await markedCollections(client, database, {
      _id: { $nin: leaving.map(markerId) },
    });
    const nothingInstalled = { collection: META_COLLECTION, filter: {} };
    const statements = [
      line(database, "columns", {
        update: collection,
        updates: [{ q: {}, u: { $unset: { [SUBDOCUMENT]: "" } }, multi: true }],
      }),
      line(database, "data", {
        delete: JOBS_COLLECTION,
        deletes: [{ q: { [JOB_COLLECTION_FIELD]: collection }, limit: 0 }],
      }),
      ...(role.kind === "found"
        ? [line(database, "grants", { dropRole: workerRole(collection) })]
        : []),
      line(database, "marker", {
        delete: META_COLLECTION,
        deletes: [{ q: { _id: markerId(collection), project: target.project.id }, limit: 1 }],
      }),
      line(database, "cleanup", { drop: JOBS_COLLECTION }, nothingInstalled),
      line(database, "cleanup", { drop: META_COLLECTION }, nothingInstalled),
    ];
    const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
      kind,
      name,
      of: label,
      scope: "source",
    });
    const others = remaining.collections.map((other) => `${database}.${other}`);
    const stillInstalled =
      others.length === 0
        ? undefined
        : `${inWords(remaining.complete ? others : [...others, "others"])} ${others.length === 1 && remaining.complete ? "is" : "are"} still installed`;
    const shared = (reason: string) =>
      [JOBS_COLLECTION, META_COLLECTION].map(
        (name): KeptObject => ({ kind: "collection", name, scope: "run", reason }),
      );
    return {
      ok: true,
      plan: {
        statements,
        transactional: false,
        removes: [
          own("field", SUBDOCUMENT),
          // Its queued jobs: the collection's part of the database's queue.
          own("jobs-table", JOBS_COLLECTION),
          ...(role.kind === "found" ? [own("login", workerRole(collection))] : []),
          ...(stillInstalled === undefined ? shared("no collection uses it any more") : []),
        ],
        keeps: [
          ...(role.kind === "absent" && handmade.kind === "found"
            ? [
                {
                  kind: "login",
                  name: workerRole(collection),
                  of: "admin",
                  scope: "source",
                  reason: HANDMADE_KEPT,
                } satisfies KeptObject,
              ]
            : []),
          ...(stillInstalled === undefined ? [] : shared(stillInstalled)),
          { kind: "login", name: WORKER_USER, scope: "run", reason: LOGIN_KEPT },
        ],
        notes: [
          `Removing the ${SUBDOCUMENT} field writes every document of ${label} that has one, an update each in the oplog: on a large collection, run it when the replica set can take the load.`,
          ...(role.kind === "hidden"
            ? [
                `MongoDB would not show the admin connection string its roles: drop the role ${workerRole(collection)} yourself if it exists (on Atlas, Database Access, Custom Roles).`,
              ]
            : []),
        ],
        confirm: { kind: "project", name: target.project.name },
      },
    };
  });
}
