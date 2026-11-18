import { type AdminClient, type ServerDocument, serverCode } from "./admin.ts";
import {
  JOBS_COLLECTION,
  KEY_TYPE_FIELD,
  type KeyType,
  META_COLLECTION,
  markerId,
  SUBDOCUMENT,
  WORKER_USER,
} from "./objects.ts";

/**
 * What the plans read of a database before they say anything (nothing here writes): the replica
 * set, the collection, the marker, the jobs collection's indexes, the worker's role and login, the
 * fields under `facetdb` in the documents, and the other collections installed beside. The server's
 * replies are a boundary: each is checked here, and a reply that is not what MongoDB documents is
 * an error naming what was read, never a guess.
 */

/** The codes of a command this connection may not run: `Unauthorized`, and Atlas's `AtlasError`. */
const UNAUTHORIZED = 13;
const ATLAS_ERROR = 8000;

/** A command the admin connection string may not run here: Atlas, or an admin without userAdmin. */
export function refusedHere(error: unknown): boolean {
  const code = serverCode(error);
  return code === UNAUTHORIZED || code === ATLAS_ERROR;
}

function unreadable(what: string, reply: unknown): Error {
  return new Error(
    `MongoDB answered ${what} with something FacetDB cannot read: ${JSON.stringify(reply)}`,
  );
}

const isRecord = (value: unknown): value is ServerDocument =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function records(value: unknown, what: string): readonly ServerDocument[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw unreadable(what, value);
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw unreadable(what, value);
  }
  return value;
}

function texts(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw unreadable(what, value);
  }
  return value;
}

/** A cursor's first batch, and whether it holds everything (the cursor's id is 0). */
function firstBatch(
  reply: ServerDocument,
  what: string,
): { readonly documents: readonly ServerDocument[]; readonly complete: boolean } {
  const cursor = reply["cursor"];
  if (!isRecord(cursor)) {
    throw unreadable(what, reply);
  }
  return { documents: records(cursor["firstBatch"], what), complete: cursor["id"] === 0 };
}

/**
 * How the server is deployed, by `hello`: a replica set member (`setName`), a sharded cluster's
 * router (`msg: "isdbgrid"`; change streams work there too), or a standalone mongod, which has no
 * change stream.
 */
export async function deployment(client: AdminClient): Promise<"replica-set" | "standalone"> {
  const reply = await client.command("admin", { hello: 1 });
  return typeof reply["setName"] === "string" || reply["msg"] === "isdbgrid"
    ? "replica-set"
    : "standalone";
}

/** A collection's type (`collection`, `view`, `timeseries`), or undefined when there is none. */
export async function collectionType(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<string | undefined> {
  const [info] = await client.listCollections(database, { name: collection });
  if (info === undefined) {
    return undefined;
  }
  return info["type"] === undefined ? "collection" : text(info["type"], "listCollections");
}

/** Who installed on a collection, and the `_id` type recorded: its marker in `facetdb_meta`. */
export type Marker = {
  readonly project: string;
  readonly source: string | undefined;
  /**
   * Whether the marker has a `keyType` field, whatever its value: false on a marker written before
   * 124, or on a collection that had no document. Its value is read only where keys are
   * (connector/key-type.ts), so a value FacetDB does not know never stops a migrate, a prune, an
   * uninstall or the another-project refusal.
   */
  readonly recordsKeyType: boolean;
};

export async function readMarker(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<Marker | undefined> {
  const marker = await client.findOne(database, META_COLLECTION, { _id: markerId(collection) });
  if (marker === null) {
    return undefined;
  }
  const source = marker["source"];
  return {
    project: text(marker["project"], `the marker of ${database}.${collection}`),
    source: typeof source === "string" ? source : undefined,
    recordsKeyType: marker[KEY_TYPE_FIELD] !== undefined,
  };
}

/**
 * A collection's `_id` type and where it was read (the declared schema, or the documents); or why
 * none was: no document and no declared type, or the look for an `_id` of another type ran past
 * `KEY_TYPE_SCAN_MS`.
 */
export type KeyTypeRead =
  | { readonly keyType: KeyType; readonly from: "validator" | "documents" }
  | { readonly keyType: undefined; readonly why: "no-document" | "timed-out" };

/**
 * How long the look for an `_id` of another type may run on the server (`maxTimeMS`): it reads
 * every `_id` of a collection whose documents all have one type, which a large collection could
 * make the migrate wait on. Past it, no type is recorded and the plan says so.
 */
export const KEY_TYPE_SCAN_MS = 30_000;

/** The server's code for a command stopped by its `maxTimeMS`. */
const MAX_TIME_EXPIRED = 50;

/**
 * The BSON types (`$type`'s names) of each key type's `_id`: those `keyOf` makes a key of
 * (connector/keys.ts). A Decimal128 is a number with no key, so it is none of them.
 */
const BSON_TYPES: ReadonlyMap<Exclude<KeyType, "mixed">, readonly string[]> = new Map([
  ["objectId", ["objectId"]],
  ["string", ["string"]],
  ["number", ["int", "long", "double"]],
]);

/** A type name of a `$jsonSchema` (`bsonType`'s, or JSON Schema's `type`) as a key type. */
function schemaKind(name: string): KeyType {
  switch (name) {
    case "objectId":
    case "string":
      return name;
    // `number` is `bsonType`'s alias of the numeric types and JSON Schema's own; `integer` is JSON Schema's.
    case "int":
    case "long":
    case "double":
    case "number":
    case "integer":
      return "number";
    default:
      return "mixed";
  }
}

/**
 * The `_id` type a collection's validator declares (`$jsonSchema: { properties: { _id: { bsonType
 * } } }`), or undefined where it declares none, or would not hold a document to it: validation
 * `off`, or the action `warn`, which lets a document of another type in. Several types that are
 * not all one key type are `mixed`.
 */
async function declaredKeyType(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<KeyType | undefined> {
  const what = `listCollections for ${database}.${collection}`;
  const { documents } = firstBatch(
    await client.command(database, { listCollections: 1, filter: { name: collection } }),
    what,
  );
  const options = documents[0]?.["options"];
  if (!isRecord(options) || options["validationLevel"] === "off") {
    return undefined;
  }
  if (options["validationAction"] === "warn" || !isRecord(options["validator"])) {
    return undefined;
  }
  const schema = options["validator"]["$jsonSchema"];
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  const id = isRecord(properties) ? properties["_id"] : undefined;
  if (!isRecord(id)) {
    return undefined;
  }
  const declared = id["bsonType"] ?? id["type"];
  const names =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared) && declared.every((name) => typeof name === "string")
        ? declared
        : [];
  const kinds = new Set(names.map(schemaKind));
  const [only] = kinds;
  return only === undefined ? undefined : kinds.size === 1 ? only : "mixed";
}

/**
 * A collection's `_id` type, read before it is recorded in the marker: the type its validator
 * declares, else the type of one document's `_id`, checked by one query for a document whose `_id`
 * has another type (`mixed` when there is one). None for a collection with no document and no
 * declared type: nothing says what its keys will be. The query stops at the first `_id` of another
 * type; where none has one, it reads every `_id` once, as `holdsSubdocument` does, within
 * `KEY_TYPE_SCAN_MS`, past which none is recorded. Read once per collection: a recorded type is
 * never read again.
 */
export async function readKeyType(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<KeyTypeRead> {
  const declared = await declaredKeyType(client, database, collection);
  if (declared !== undefined) {
    return { keyType: declared, from: "validator" };
  }
  const what = `the type of an _id in ${database}.${collection}`;
  const sample = firstBatch(
    await client.command(database, {
      aggregate: collection,
      pipeline: [{ $limit: 1 }, { $project: { _id: 0, type: { $type: "$_id" } } }],
      cursor: {},
    }),
    what,
  ).documents[0];
  if (sample === undefined) {
    return { keyType: undefined, why: "no-document" };
  }
  const type = text(sample["type"], what);
  const kind = [...BSON_TYPES].find(([, names]) => names.includes(type));
  if (kind === undefined) {
    return { keyType: "mixed", from: "documents" };
  }
  const [keyType, names] = kind;
  let reply: ServerDocument;
  try {
    reply = await client.command(database, {
      find: collection,
      filter: { _id: { $not: { $type: names } } },
      projection: { _id: 1 },
      limit: 1,
      maxTimeMS: KEY_TYPE_SCAN_MS,
    });
  } catch (error) {
    if (serverCode(error) === MAX_TIME_EXPIRED) {
      return { keyType: undefined, why: "timed-out" };
    }
    throw error;
  }
  const other = firstBatch(
    reply,
    `an _id of another type than ${type} in ${database}.${collection}`,
  ).documents;
  return { keyType: other.length === 0 ? keyType : "mixed", from: "documents" };
}

/**
 * Whether a document of the collection holds a field named `facetdb`. Before an install (no marker)
 * such a field is the application's own: the worker's answers would land in it, and an uninstall
 * would remove it from every document (an application's name is refused, nothing is destroyed
 * silently). One `find` with `limit: 1`; where no document has one, it reads the whole collection
 * once.
 */
export async function holdsSubdocument(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<boolean> {
  const { documents } = firstBatch(
    await client.command(database, {
      find: collection,
      filter: { [SUBDOCUMENT]: { $exists: true } },
      projection: { _id: 1 },
      limit: 1,
    }),
    `a ${SUBDOCUMENT} field in ${database}.${collection}`,
  );
  return documents.length > 0;
}

/** An index as `listIndexes` reports it, on the fields of its key in order. */
export type IndexInfo = {
  readonly name: string;
  readonly fields: readonly string[];
  readonly ascending: boolean;
  readonly unique: boolean;
};

/** The jobs collection's indexes, or undefined when the collection is not there yet. */
export async function jobsIndexes(
  client: AdminClient,
  database: string,
): Promise<readonly IndexInfo[] | undefined> {
  if ((await collectionType(client, database, JOBS_COLLECTION)) === undefined) {
    return undefined;
  }
  const what = `listIndexes on ${database}.${JOBS_COLLECTION}`;
  const { documents } = firstBatch(
    await client.command(database, { listIndexes: JOBS_COLLECTION }),
    what,
  );
  return documents.map((index) => {
    const key = index["key"];
    if (!isRecord(key)) {
      throw unreadable(what, index);
    }
    return {
      name: text(index["name"], what),
      fields: Object.keys(key),
      ascending: Object.values(key).every((direction) => direction === 1),
      unique: index["unique"] === true,
    };
  });
}

/** A privilege as the server reports it; the resource may be a database, a cluster or any resource. */
export type HeldPrivilege = {
  readonly resource: {
    readonly db?: string;
    readonly collection?: string;
    readonly anyResource?: boolean;
  };
  readonly actions: readonly string[];
};

/** A role or a login's role, by name and database. */
export type RoleRef = { readonly role: string; readonly db: string };

function privileges(value: unknown, what: string): readonly HeldPrivilege[] {
  return records(value, what).map((privilege) => {
    const resource = privilege["resource"];
    if (!isRecord(resource)) {
      throw unreadable(what, privilege);
    }
    const { db, collection, anyResource } = resource;
    return {
      resource: {
        ...(typeof db === "string" ? { db } : {}),
        ...(typeof collection === "string" ? { collection } : {}),
        ...(anyResource === true ? { anyResource } : {}),
      },
      actions: texts(privilege["actions"], what),
    };
  });
}

function roleRefs(value: unknown, what: string): readonly RoleRef[] {
  return records(value, what).map((ref) => ({
    role: text(ref["role"], what),
    db: text(ref["db"], what),
  }));
}

/** A role FacetDB may have made: its own privileges and the roles it inherits. */
export type RoleInfo = {
  readonly privileges: readonly HeldPrivilege[];
  readonly roles: readonly RoleRef[];
};

/** What may be read of a login or a role: it, its absence, or nothing when the server will not say. */
export type Seen<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "hidden" };

/** The role in `database` with its privileges (`rolesInfo`), absent, or hidden from this admin. */
export async function readRole(
  client: AdminClient,
  database: string,
  role: string,
): Promise<Seen<RoleInfo>> {
  let reply: ServerDocument;
  try {
    reply = await client.command(database, {
      rolesInfo: { role, db: database },
      showPrivileges: true,
    });
  } catch (error) {
    if (refusedHere(error)) {
      return { kind: "hidden" };
    }
    throw error;
  }
  const what = `rolesInfo for ${role}@${database}`;
  const [found] = records(reply["roles"], what);
  return found === undefined
    ? { kind: "absent" }
    : {
        kind: "found",
        value: {
          privileges: privileges(found["privileges"], what),
          roles: roleRefs(found["roles"], what),
        },
      };
}

/** The worker login: where it lives, its roles, and every privilege they give it. */
export type LoginInfo = {
  readonly db: string;
  readonly roles: readonly RoleRef[];
  readonly privileges: readonly HeldPrivilege[];
};

async function readUser(client: AdminClient, database: string): Promise<Seen<LoginInfo>> {
  let reply: ServerDocument;
  try {
    reply = await client.command(database, {
      usersInfo: { user: WORKER_USER, db: database },
      showPrivileges: true,
    });
  } catch (error) {
    if (refusedHere(error)) {
      return { kind: "hidden" };
    }
    throw error;
  }
  const what = `usersInfo for ${WORKER_USER}@${database}`;
  const [found] = records(reply["users"], what);
  return found === undefined
    ? { kind: "absent" }
    : {
        kind: "found",
        value: {
          db: database,
          roles: roleRefs(found["roles"], what),
          privileges: privileges(found["inheritedPrivileges"], what),
        },
      };
}

/**
 * The worker login: in the source's database, where FacetDB makes it, else in `admin`, where Atlas
 * keeps every user its Database Access page makes (an install finished there by hand).
 */
export async function readLogin(client: AdminClient, database: string): Promise<Seen<LoginInfo>> {
  const own = await readUser(client, database);
  return own.kind === "absent" && database !== "admin" ? readUser(client, "admin") : own;
}

/** The pipeline that lists the fields under `facetdb` across a collection's documents, once each. */
const FIELDS_PIPELINE = [
  { $match: { [SUBDOCUMENT]: { $type: "object" } } },
  {
    $project: {
      _id: 0,
      fields: { $map: { input: { $objectToArray: `$${SUBDOCUMENT}` }, in: "$$this.k" } },
    },
  },
  { $unwind: "$fields" },
  { $group: { _id: null, fields: { $addToSet: "$fields" } } },
];

/**
 * The fields the documents hold under `facetdb`, as dotted paths in name order: what a prune can
 * find of questions the set no longer has (MongoDB keeps no schema to ask). It reads every
 * document once, as the prune's own update does.
 */
export async function subdocumentFields(
  client: AdminClient,
  database: string,
  collection: string,
): Promise<readonly string[]> {
  const what = `the fields under ${SUBDOCUMENT} in ${database}.${collection}`;
  const { documents } = firstBatch(
    await client.command(database, {
      aggregate: collection,
      pipeline: FIELDS_PIPELINE,
      cursor: {},
    }),
    what,
  );
  const [found] = documents;
  return found === undefined
    ? []
    : texts(found["fields"], what)
        .map((name) => `${SUBDOCUMENT}.${name}`)
        .sort();
}

/** The collections whose markers `filter` selects, and whether the server returned every one. */
export async function markedCollections(
  client: AdminClient,
  database: string,
  filter: Readonly<Record<string, unknown>>,
): Promise<{ readonly collections: readonly string[]; readonly complete: boolean }> {
  const what = `the markers in ${database}.${META_COLLECTION}`;
  const { documents, complete } = firstBatch(
    await client.command(database, {
      find: META_COLLECTION,
      filter,
      projection: { _id: 1 },
      batchSize: 1000,
    }),
    what,
  );
  const prefix = markerId("");
  return {
    collections: documents
      .map((marker) => text(marker["_id"], what))
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length)),
    complete,
  };
}
