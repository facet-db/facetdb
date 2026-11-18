import type { AdminClient, AdminConnect, Sent, ServerDocument } from "../install/index.ts";

/**
 * A recording fake of the admin connection (install/admin.ts's `AdminClient`), for unit tests with
 * no server: it records every call in order and plays a small model of one MongoDB server, enough
 * for the plans to read what they read and for a run's commands to leave what the next plan reads
 * (collections, the jobs collection's indexes, the markers, roles, users, queued jobs and the
 * field names under `facetdb`). A command it does not model throws, so a plan that sends something
 * new fails loudly. `fail` scripts a server error for every later command of a name (Atlas's
 * Unauthorized on `createUser`). It is passed through `connect`, the parameter the real driver's
 * `connectAdmin` fills; nothing is patched.
 */

/** One call the fake saw, in order. */
export type FakeMongoCall =
  | { readonly kind: "connect"; readonly url: string; readonly forceTls: boolean }
  | { readonly kind: "command"; readonly database: string; readonly command: Sent }
  | { readonly kind: "listCollections"; readonly database: string; readonly filter: Sent }
  | {
      readonly kind: "findOne";
      readonly database: string;
      readonly collection: string;
      readonly filter: Sent;
    }
  | { readonly kind: "close" };

/** An error as the driver throws a server's: its message, numeric `code` and `codeName`. */
export class FakeServerError extends Error {
  readonly code: number;
  readonly codeName: string;

  constructor(code: number, codeName: string, message: string) {
    super(message);
    this.name = "MongoServerError";
    this.code = code;
    this.codeName = codeName;
  }
}

/** A privilege as a role holds it. */
export type FakePrivilege = {
  readonly resource: { readonly db: string; readonly collection: string };
  readonly actions: readonly string[];
};

export type FakeRoleRef = { readonly role: string; readonly db: string };

export type FakeIndex = {
  readonly name: string;
  readonly key: Readonly<Record<string, number>>;
  readonly unique: boolean;
};

/** A job: the collection it is for beside the plain key (install/objects.ts, `JOBS_COLLECTION`). */
export type FakeJob = { readonly collection: string; readonly record_key: string };

/** One database of the fake server, as tests seed and read it. */
export type FakeDatabaseState = {
  /** Collection name → type (`collection`, `view`, `timeseries`). */
  readonly collections: Map<string, string>;
  /** `facetdb_meta`'s documents by `_id`. */
  readonly markers: Map<string, Record<string, unknown>>;
  /** Indexes by collection, beside the `_id` index every collection has. */
  readonly indexes: Map<string, FakeIndex[]>;
  readonly roles: Map<string, { privileges: FakePrivilege[]; roles: FakeRoleRef[] }>;
  /** Users by name; `password` is what `createUser` was sent, so a test sees what a run bound. */
  readonly users: Map<string, { roles: FakeRoleRef[]; password: string | undefined }>;
  /** `facetdb_jobs`' documents: the collection a job is for, and its key. */
  jobs: FakeJob[];
  /** Per collection, the dotted fields its documents hold under `facetdb`. */
  readonly fields: Map<string, Set<string>>;
  /** Per collection, the BSON type (`$type`'s name) of each document's `_id`, in natural order. */
  readonly idTypes: Map<string, readonly string[]>;
  /** Per collection, its options as `listCollections` reports them (a validator among them). */
  readonly options: Map<string, Readonly<Record<string, unknown>>>;
};

function emptyDatabase(): FakeDatabaseState {
  return {
    collections: new Map(),
    markers: new Map(),
    indexes: new Map(),
    roles: new Map(),
    users: new Map(),
    jobs: [],
    fields: new Map(),
    idTypes: new Map(),
    options: new Map(),
  };
}

type Loose = Readonly<Record<string, unknown>>;

const isLoose = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function record(value: unknown, what: string): Loose {
  if (!isLoose(value)) {
    throw new Error(
      `the fake MongoDB expected a document for ${what}, not ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`the fake MongoDB expected an array for ${what}, not ${JSON.stringify(value)}`);
  }
  return value;
}

function name(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`the fake MongoDB expected a name for ${what}, not ${JSON.stringify(value)}`);
  }
  return value;
}

const META = "facetdb_meta";
const JOBS = "facetdb_jobs";

/** Whether a marker matches a filter of the forms the plans send. */
function matches(document: Loose, filter: Loose): boolean {
  return Object.entries(filter).every(([key, wanted]) => {
    const value = document[key];
    if (isLoose(wanted) && Array.isArray(wanted["$nin"])) {
      return !wanted["$nin"].includes(value);
    }
    return value === wanted;
  });
}

const cursor = (database: string, collection: string, documents: readonly unknown[]) => ({
  cursor: { firstBatch: documents, id: 0, ns: `${database}.${collection}` },
  ok: 1,
});

export class FakeMongo {
  /** Every call, in order. */
  readonly calls: FakeMongoCall[] = [];
  /** What `hello` answers: a one-node replica set's primary unless a test says otherwise. */
  hello: ServerDocument = { isWritablePrimary: true, setName: "rs0", ok: 1 };
  /**
   * Whether the look for an `_id` of another type runs past its `maxTimeMS` (a collection too large
   * to read within it): the server's MaxTimeMSExpired, code 50.
   */
  slowIdScan = false;
  private readonly databases = new Map<string, FakeDatabaseState>();
  private readonly failures = new Map<string, Error>();
  /** Per collection, the words a document's write error carries (a validator refusing it). */
  private readonly refusedDocuments = new Map<string, string>();

  /** The admin connection over this fake, as `connectAdmin` is over the driver. */
  readonly connect: AdminConnect = (url, options) => {
    this.calls.push({ kind: "connect", url, forceTls: options.forceTls });
    const client: AdminClient = {
      command: (database, command) => {
        this.calls.push({ kind: "command", database, command });
        return Promise.resolve().then(() => this.command(database, command));
      },
      listCollections: (database, filter) => {
        this.calls.push({ kind: "listCollections", database, filter });
        const failure = this.failures.get("listCollections");
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        const state = this.database(database);
        const wanted = filter["name"];
        return Promise.resolve(
          [...state.collections]
            .filter(([collection]) => wanted === undefined || collection === wanted)
            .map(([collection, type]) => ({ name: collection, type })),
        );
      },
      findOne: (database, collection, filter) => {
        this.calls.push({ kind: "findOne", database, collection, filter });
        const failure = this.failures.get("findOne");
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        if (collection !== META) {
          return Promise.reject(
            new Error(`the fake MongoDB reads only ${META}, not ${collection}`),
          );
        }
        const found = [...this.database(database).markers.values()].find((marker) =>
          matches(marker, filter),
        );
        return Promise.resolve(found === undefined ? null : { ...found });
      },
      close: () => {
        this.calls.push({ kind: "close" });
        return Promise.resolve();
      },
    };
    return client;
  };

  /** A database's state, made empty on first use: what tests seed and read. */
  database(database: string): FakeDatabaseState {
    let state = this.databases.get(database);
    if (state === undefined) {
      state = emptyDatabase();
      this.databases.set(database, state);
    }
    return state;
  }

  /**
   * Every later command named `command` (or every later `findOne` or `listCollections`, by those
   * names) throws `error`: the server refusing it (a `FakeServerError`), or the driver failing
   * before it reaches one (its handshake's error).
   */
  fail(command: string, error: Error): this {
    this.failures.set(command, error);
    return this;
  }

  /**
   * Every later `update` of `collection` fails on a document, as a validator does: `ok: 1` with the
   * document's write error, which the driver does not throw.
   */
  refuseDocuments(collection: string, errmsg: string): this {
    this.refusedDocuments.set(collection, errmsg);
    return this;
  }

  collection(database: string, collection: string, type = "collection"): this {
    this.database(database).collections.set(collection, type);
    return this;
  }

  marker(database: string, collection: string, project: string, source: string): this {
    const state = this.database(database);
    state.collections.set(META, "collection");
    state.markers.set(`owner:${collection}`, { _id: `owner:${collection}`, project, source });
    return this;
  }

  role(
    database: string,
    role: string,
    privileges: readonly FakePrivilege[],
    roles: readonly FakeRoleRef[] = [],
  ): this {
    this.database(database).roles.set(role, { privileges: [...privileges], roles: [...roles] });
    return this;
  }

  user(database: string, user: string, roles: readonly FakeRoleRef[]): this {
    this.database(database).users.set(user, { roles: [...roles], password: undefined });
    return this;
  }

  index(database: string, collection: string, index: FakeIndex): this {
    const state = this.database(database);
    state.collections.set(collection, state.collections.get(collection) ?? "collection");
    state.indexes.set(collection, [...(state.indexes.get(collection) ?? []), index]);
    return this;
  }

  /**
   * The dotted fields (`facetdb.is_scam`) the documents of a collection hold under `facetdb`: with
   * any, a document of it has a `facetdb` field.
   */
  fields(database: string, collection: string, fields: readonly string[]): this {
    this.database(database).fields.set(collection, new Set(fields));
    return this;
  }

  /**
   * The documents of a collection, by the BSON type of each `_id` (`objectId`, `string`, `int`,
   * `double`, `date`…), in natural order: what an install reads the `_id` type from.
   */
  ids(database: string, collection: string, types: readonly string[]): this {
    const state = this.database(database);
    state.collections.set(collection, state.collections.get(collection) ?? "collection");
    state.idTypes.set(collection, [...types]);
    return this;
  }

  /** A collection's options (`validator`, `validationLevel`, `validationAction`). */
  collectionOptions(
    database: string,
    collection: string,
    options: Readonly<Record<string, unknown>>,
  ): this {
    const state = this.database(database);
    state.collections.set(collection, state.collections.get(collection) ?? "collection");
    state.options.set(collection, options);
    return this;
  }

  /** A queued job of `collection`, its key as the connector writes it. */
  job(database: string, collection: string, recordKey: string): this {
    const state = this.database(database);
    state.collections.set(JOBS, "collection");
    state.jobs.push({ collection, record_key: recordKey });
    return this;
  }

  /** The commands sent, in order, as `<name> <database>`: what a test reads a run by. */
  commandNames(): readonly string[] {
    return this.calls.flatMap((call) =>
      call.kind === "command" ? [`${Object.keys(call.command)[0] ?? ""} ${call.database}`] : [],
    );
  }

  /** The commands sent, each as its document. */
  commands(): readonly Sent[] {
    return this.calls.flatMap((call) => (call.kind === "command" ? [call.command] : []));
  }

  private privilegesOf(refs: readonly FakeRoleRef[]): readonly FakePrivilege[] {
    return refs.flatMap((ref) => this.database(ref.db).roles.get(ref.role)?.privileges ?? []);
  }

  private command(database: string, command: Sent): ServerDocument {
    const [commandName = ""] = Object.keys(command);
    const failure = this.failures.get(commandName);
    if (failure !== undefined) {
      throw failure;
    }
    const state = this.database(database);
    const target = command[commandName];
    switch (commandName) {
      case "hello":
        return this.hello;
      case "listIndexes": {
        const collection = name(target, commandName);
        if (!state.collections.has(collection)) {
          throw new FakeServerError(
            26,
            "NamespaceNotFound",
            `ns does not exist: ${database}.${collection}`,
          );
        }
        return cursor(database, collection, [
          { v: 2, key: { _id: 1 }, name: "_id_" },
          ...(state.indexes.get(collection) ?? []).map((index) => ({
            v: 2,
            key: index.key,
            name: index.name,
            ...(index.unique ? { unique: true } : {}),
          })),
        ]);
      }
      case "rolesInfo": {
        const wanted = record(target, commandName);
        const role = this.database(name(wanted["db"], "db")).roles.get(
          name(wanted["role"], "role"),
        );
        return {
          roles:
            role === undefined
              ? []
              : [
                  {
                    role: wanted["role"],
                    db: wanted["db"],
                    privileges: role.privileges,
                    roles: role.roles,
                  },
                ],
          ok: 1,
        };
      }
      case "usersInfo": {
        const wanted = record(target, commandName);
        const user = this.database(name(wanted["db"], "db")).users.get(
          name(wanted["user"], "user"),
        );
        return {
          users:
            user === undefined
              ? []
              : [
                  {
                    user: wanted["user"],
                    db: wanted["db"],
                    roles: user.roles,
                    inheritedPrivileges: this.privilegesOf(user.roles),
                  },
                ],
          ok: 1,
        };
      }
      case "listCollections": {
        const wanted = record(command["filter"], "filter")["name"];
        return cursor(
          database,
          "$cmd.listCollections",
          [...state.collections]
            .filter(([collection]) => collection === wanted)
            .map(([collection, type]) => ({
              name: collection,
              type,
              options: state.options.get(collection) ?? {},
            })),
        );
      }
      case "aggregate": {
        const collection = name(target, commandName);
        const [first] = list(command["pipeline"], "pipeline");
        if (record(first, "stage")["$limit"] !== undefined) {
          // One document's `_id` type: the sample an install reads.
          const [type] = state.idTypes.get(collection) ?? [];
          return cursor(database, collection, type === undefined ? [] : [{ type }]);
        }
        const fields = [...(state.fields.get(collection) ?? [])].map((field) =>
          field.replace(/^facetdb\./, ""),
        );
        return cursor(database, collection, fields.length === 0 ? [] : [{ _id: null, fields }]);
      }
      case "find": {
        const collection = name(target, commandName);
        const filter = record(command["filter"], "filter");
        if (collection !== META) {
          const id = filter["_id"];
          if (isLoose(id)) {
            if (this.slowIdScan) {
              throw new FakeServerError(
                50,
                "MaxTimeMSExpired",
                "Executor error during find command :: caused by :: operation exceeded time limit",
              );
            }
            // A document whose `_id` has another type than these (the mixed check).
            const types = list(record(id["$not"], "$not")["$type"], "$type");
            const other = (state.idTypes.get(collection) ?? []).some(
              (type) => !types.includes(type),
            );
            return cursor(database, collection, other ? [{ _id: `${collection}-other` }] : []);
          }
          // A source collection: only whether a document has a `facetdb` field, the one find sent.
          if (JSON.stringify(filter) !== JSON.stringify({ facetdb: { $exists: true } })) {
            throw new Error(`the fake MongoDB finds only facetdb fields in ${collection}`);
          }
          const holds = (state.fields.get(collection)?.size ?? 0) > 0;
          return cursor(database, collection, holds ? [{ _id: `${collection}-1` }] : []);
        }
        const found = [...state.markers.values()].filter((marker) => matches(marker, filter));
        return cursor(
          database,
          collection,
          found.map((marker) => ({ _id: marker["_id"] })),
        );
      }
      case "create": {
        const collection = name(target, commandName);
        if (state.collections.has(collection)) {
          throw new FakeServerError(
            48,
            "NamespaceExists",
            `Collection ${database}.${collection} already exists.`,
          );
        }
        state.collections.set(collection, "collection");
        return { ok: 1 };
      }
      case "createIndexes":
        return this.createIndexes(
          state,
          name(target, commandName),
          list(command["indexes"], "indexes"),
        );
      case "findAndModify":
        return this.findAndModify(state, name(target, commandName), command);
      case "update":
        return this.update(state, name(target, commandName), list(command["updates"], "updates"));
      case "delete":
        return this.delete(state, name(target, commandName), list(command["deletes"], "deletes"));
      case "drop": {
        const collection = name(target, commandName);
        if (!state.collections.delete(collection)) {
          throw new FakeServerError(26, "NamespaceNotFound", "ns not found");
        }
        state.indexes.delete(collection);
        state.fields.delete(collection);
        state.idTypes.delete(collection);
        state.options.delete(collection);
        if (collection === META) {
          state.markers.clear();
        }
        if (collection === JOBS) {
          state.jobs = [];
        }
        return { ok: 1 };
      }
      case "createRole":
      case "updateRole": {
        const role = name(target, commandName);
        const exists = state.roles.has(role);
        if (commandName === "createRole" && exists) {
          throw new FakeServerError(
            51002,
            "Location51002",
            `Role "${role}@${database}" already exists`,
          );
        }
        if (commandName === "updateRole" && !exists) {
          throw new FakeServerError(31, "RoleNotFound", `Role ${role}@${database} not found`);
        }
        state.roles.set(role, {
          privileges: list(command["privileges"], "privileges").map((privilege) => {
            const held = record(privilege, "privilege");
            const resource = record(held["resource"], "resource");
            return {
              resource: {
                db: name(resource["db"], "db"),
                collection: name(resource["collection"], "collection"),
              },
              actions: list(held["actions"], "actions").map((action) => name(action, "action")),
            };
          }),
          roles: [],
        });
        return { ok: 1 };
      }
      case "dropRole": {
        const role = name(target, commandName);
        if (!state.roles.delete(role)) {
          throw new FakeServerError(31, "RoleNotFound", `Role ${role}@${database} not found`);
        }
        // MongoDB takes a dropped role from every user that held it.
        for (const each of this.databases.values()) {
          for (const user of each.users.values()) {
            user.roles = user.roles.filter((ref) => ref.role !== role || ref.db !== database);
          }
        }
        return { ok: 1 };
      }
      case "createUser": {
        const user = name(target, commandName);
        if (state.users.has(user)) {
          throw new FakeServerError(
            51003,
            "Location51003",
            `User "${user}@${database}" already exists`,
          );
        }
        state.users.set(user, { roles: [], password: name(command["pwd"], "pwd") });
        return { ok: 1 };
      }
      case "grantRolesToUser": {
        const user = state.users.get(name(target, commandName));
        if (user === undefined) {
          throw new FakeServerError(
            11,
            "UserNotFound",
            `Could not find user "${String(target)}@${database}"`,
          );
        }
        for (const granted of list(command["roles"], "roles")) {
          const ref = record(granted, "role");
          const role = { role: name(ref["role"], "role"), db: name(ref["db"], "db") };
          if (!user.roles.some((held) => held.role === role.role && held.db === role.db)) {
            user.roles.push(role);
          }
        }
        return { ok: 1 };
      }
      default:
        throw new Error(`the fake MongoDB does not know the command ${commandName}`);
    }
  }

  private createIndexes(
    state: FakeDatabaseState,
    collection: string,
    specs: readonly unknown[],
  ): ServerDocument {
    const created = !state.collections.has(collection);
    state.collections.set(collection, state.collections.get(collection) ?? "collection");
    const indexes = state.indexes.get(collection) ?? [];
    for (const spec of specs) {
      const wanted = record(spec, "index");
      const key = Object.fromEntries(
        Object.entries(record(wanted["key"], "key")).map(([field, direction]) => [
          field,
          typeof direction === "number" ? direction : Number.NaN,
        ]),
      );
      const index = {
        name: name(wanted["name"], "index name"),
        key,
        unique: wanted["unique"] === true,
      };
      const sameKey = indexes.find((other) => JSON.stringify(other.key) === JSON.stringify(key));
      const sameName = indexes.find((other) => other.name === index.name);
      if (sameName !== undefined && JSON.stringify(sameName.key) !== JSON.stringify(key)) {
        throw new FakeServerError(
          86,
          "IndexKeySpecsConflict",
          `An existing index has the same name as the requested index: ${index.name}`,
        );
      }
      if (
        sameKey !== undefined &&
        (sameKey.name !== index.name || sameKey.unique !== index.unique)
      ) {
        throw new FakeServerError(
          85,
          "IndexOptionsConflict",
          `Index already exists with different options: ${sameKey.name}`,
        );
      }
      if (sameKey === undefined) {
        indexes.push(index);
      }
    }
    state.indexes.set(collection, indexes);
    return { createdCollectionAutomatically: created, ok: 1 };
  }

  /**
   * The marker's upsert: under the `_id` of a marker whose fields the query does not match (another
   * project's), the insert is a duplicate key, which `findAndModify` fails with outright.
   */
  private findAndModify(
    state: FakeDatabaseState,
    collection: string,
    command: Sent,
  ): ServerDocument {
    if (collection !== META) {
      throw new Error(`the fake MongoDB runs findAndModify on ${META} only, not ${collection}`);
    }
    const query = record(command["query"], "query");
    const change = record(command["update"], "update");
    const id = name(query["_id"], "_id");
    const existing = state.markers.get(id);
    if (existing !== undefined && !matches(existing, query)) {
      throw new FakeServerError(
        11000,
        "DuplicateKey",
        `E11000 duplicate key error collection: ${collection} index: _id_ dup key: { _id: "${id}" }`,
      );
    }
    if (existing === undefined && command["upsert"] !== true) {
      return { lastErrorObject: { n: 0, updatedExisting: false }, value: null, ok: 1 };
    }
    state.collections.set(META, "collection");
    state.markers.set(id, {
      ...(existing ?? query),
      ...record(change["$set"] ?? {}, "$set"),
      ...(change["$currentDate"] === undefined ? {} : { installedAt: new Date(0) }),
    });
    return {
      lastErrorObject: { n: 1, updatedExisting: existing !== undefined },
      value: existing ?? null,
      ok: 1,
    };
  }

  private update(
    state: FakeDatabaseState,
    collection: string,
    updates: readonly unknown[],
  ): ServerDocument {
    if (collection === META) {
      throw new Error(`the fake MongoDB writes markers by findAndModify only, not update`);
    }
    const refused = this.refusedDocuments.get(collection);
    if (refused !== undefined) {
      return {
        n: 0,
        nModified: 0,
        writeErrors: [{ index: 0, code: 121, errmsg: refused }],
        ok: 1,
      };
    }
    let modified = 0;
    for (const each of updates) {
      const change = record(record(each, "update")["u"], "u");
      // A source collection: the fake keeps only which fields the documents hold under `facetdb`.
      const fields = state.fields.get(collection);
      for (const field of Object.keys(record(change["$unset"], "$unset"))) {
        if (field === "facetdb") {
          fields?.clear();
        } else {
          fields?.delete(field);
        }
      }
      modified += fields === undefined ? 0 : 1;
    }
    return { n: modified, nModified: modified, ok: 1 };
  }

  private delete(
    state: FakeDatabaseState,
    collection: string,
    deletes: readonly unknown[],
  ): ServerDocument {
    let removed = 0;
    for (const each of deletes) {
      const filter = record(record(each, "delete")["q"], "q");
      if (collection === META) {
        const id = name(filter["_id"], "_id");
        const marker = state.markers.get(id);
        if (marker !== undefined && matches(marker, filter)) {
          state.markers.delete(id);
          removed += 1;
        }
      } else if (collection === JOBS) {
        // A collection's jobs, by equality on the collection they are for.
        const of = name(filter["collection"], "collection");
        const before = state.jobs.length;
        state.jobs = state.jobs.filter((job) => job.collection !== of);
        removed += before - state.jobs.length;
      } else {
        throw new Error(
          `the fake MongoDB deletes only from ${META} and ${JOBS}, not ${collection}`,
        );
      }
    }
    return { n: removed, ok: 1 };
  }
}
