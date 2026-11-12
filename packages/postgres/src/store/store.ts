import type { PGlite } from "@electric-sql/pglite";
import {
  type AlertStore,
  type Clock,
  type CursorStore,
  type DecisionLog,
  nextVersion,
  type QuestionSet,
  type QuestionSetVersion,
  type UsageStore,
} from "@facetdb/core";
import { pgliteClient } from "../polling/index.ts";
import { connectPostgres, type SqlClient, type SqlConnect } from "../sql/index.ts";
import {
  createStoreConnector,
  type StoreConnector,
  type StoreConnectorOptions,
} from "./connector.ts";
import { createCrypto, newSalt, requireSecret } from "./crypto.ts";
import { createDecisionLog } from "./decision-log.ts";
import { createAlertStore, createCursorStore, createUsageStore } from "./operations.ts";
import { integer, text, toMs } from "./rows.ts";
import { migrateStore } from "./schema.ts";
import {
  type ApiKeyStore,
  type CredentialStore,
  createApiKeyStore,
  createCredentialStore,
} from "./secrets.ts";

export type StoreOptions = {
  /**
   * The value of `FACETDB_SECRET`. It comes from the environment, so it may be missing: the store
   * refuses to start without it, naming the variable.
   */
  readonly secret: string | undefined;
  readonly clock: Clock;
  /** Opens the driver for a `url`; defaults to postgres.js. Tests pass PGlite through the same type. */
  readonly connect?: SqlConnect;
  /**
   * The most connections the store's pool opens at once (the driver's default when unset). The
   * worker passes its in-flight limit plus two, so each lane has a connection when it needs one.
   */
  readonly maxConnections?: number;
  /**
   * Allows a connection without TLS to a host that is not on this machine. Off unless set, and the
   * composition root sets it only from an explicit flag of the operator's.
   */
  readonly allowInsecure?: boolean;
} & (
  | { readonly url: string; readonly pglite?: undefined }
  | { readonly pglite: PGlite; readonly url?: undefined }
);

export type SourceKind = "plugin" | "api";

export type Store = {
  readonly usage: UsageStore;
  readonly alerts: AlertStore;
  readonly cursors: CursorStore;
  readonly credentials: CredentialStore;
  readonly apiKeys: ApiKeyStore;
  /** Registers a project; registering it again changes nothing. */
  ensureProject(project: { readonly id: string; readonly name: string }): Promise<void>;
  /** Registers a plugin or API source of a project; registering it again changes nothing. */
  ensureSource(source: {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly kind: SourceKind;
  }): Promise<void>;
  /** The decision log of one source. */
  log(sourceId: string): DecisionLog;
  /**
   * The question-set versions of one source: `record` stores the set under the version it
   * should run under, which is the previous one when its content is unchanged and the next otherwise.
   */
  questionSets: {
    latest(sourceId: string): Promise<QuestionSetVersion | undefined>;
    record(sourceId: string, questionSet: QuestionSet): Promise<QuestionSetVersion>;
  };
  /** The queue and records of one source, claimed with `skip locked`. */
  connector(options: StoreConnectorOptions): StoreConnector;
  /** Lets go of the connection (a PGlite handed in stays open: its owner closes it). */
  close(): Promise<void>;
};

// An empty host is not here: a driver reads it as its default host or a socket, not as this machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);
/** The modes that may send the password in the clear; they win over `ssl=true`. */
const PLAINTEXT_MODES = new Set(["disable", "allow", "prefer"]);

/**
 * Connections use TLS. A URL that reaches another machine must ask for it
 * (`sslmode=require` or stronger, or `ssl=true`); a local one need not. `allowInsecure` is the one
 * explicit way out, for a database on a private network the operator trusts.
 */
export function requireTls(url: string, allowInsecure: boolean): void {
  if (allowInsecure) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new Error("the store URL is not a connection string (postgres://user:password@host/db)", {
      cause,
    });
  }
  if (LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return;
  }
  // The driver lets a later `sslmode` (or `ssl`) replace an earlier one, so the last one counts.
  const mode = parsed.searchParams.getAll("sslmode").at(-1);
  const ssl = parsed.searchParams.getAll("ssl").at(-1);
  const tls =
    mode !== undefined && PLAINTEXT_MODES.has(mode)
      ? false
      : (mode !== undefined && TLS_MODES.has(mode)) || ssl === "true";
  if (!tls) {
    throw new Error(
      `the store URL reaches ${parsed.hostname} without TLS; add ?sslmode=require to it, or set allowInsecure if that network is trusted`,
    );
  }
}

/**
 * The FacetDB store: Postgres in both editions, PGlite for `facetdb dev`. It refuses to start
 * without `FACETDB_SECRET`, without TLS to a remote host, or with a schema newer than this
 * FacetDB; it creates or updates its own tables, then derives the encryption key from the secret
 * and this install's salt.
 */
export async function createStore(options: StoreOptions): Promise<Store> {
  const secret = requireSecret(options.secret);
  const { clock } = options;
  let client: SqlClient;
  if (options.pglite !== undefined) {
    client = pgliteClient(options.pglite);
  } else {
    requireTls(options.url, options.allowInsecure ?? false);
    client = (options.connect ?? connectPostgres)(
      options.url,
      options.maxConnections === undefined ? undefined : { max: options.maxConnections },
    );
  }

  let closed = false;
  try {
    await migrateStore(client);
    const crypto = createCrypto(secret, await installSalt(client));

    return {
      usage: createUsageStore(client),
      alerts: createAlertStore(client),
      cursors: createCursorStore(client),
      credentials: createCredentialStore(client, crypto),
      apiKeys: createApiKeyStore(client),

      async ensureProject(project) {
        await client.query(
          "insert into facetdb.projects (id, name) values ($1, $2) on conflict (id) do nothing",
          [project.id, project.name],
        );
      },

      async ensureSource(source) {
        await client.query(
          `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $3, $4)
           on conflict (id) do nothing`,
          [source.id, source.projectId, source.name, source.kind],
        );
      },

      log: (sourceId) => createDecisionLog(client, sourceId),

      questionSets: {
        latest: (sourceId) => latestVersion(client.query, sourceId),
        async record(sourceId, questionSet) {
          return client.transaction(async (query) => {
            await query("select pg_advisory_xact_lock(hashtext($1))", [`question_set:${sourceId}`]);
            const previous = await latestVersion(query, sourceId);
            const version = nextVersion(previous, questionSet, {
              now: () => new Date(clock.now()),
            });
            if (version !== previous) {
              await query(
                `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set, created_at)
                 values ($1, $2, $3, $4::jsonb, to_timestamp($5::double precision / 1000))`,
                [
                  sourceId,
                  version.version,
                  version.contentHash,
                  JSON.stringify(questionSet),
                  version.createdAt.getTime(),
                ],
              );
            }
            return version;
          });
        },
      },

      connector: (connectorOptions) =>
        createStoreConnector(client, clock, () => closed, connectorOptions),

      async close() {
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** This install's key-derivation salt: made on the first start, read on every later one. */
async function installSalt(client: SqlClient): Promise<string> {
  await client.query(
    "insert into facetdb.install (key, value) values ('salt', $1) on conflict (key) do nothing",
    [newSalt()],
  );
  const rows = await client.query("select value from facetdb.install where key = 'salt'");
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the store has no install salt after creating it");
  }
  return text(row, "value");
}

async function latestVersion(
  query: SqlClient["query"],
  sourceId: string,
): Promise<QuestionSetVersion | undefined> {
  const rows = await query(
    `select version::text as version, content_hash, ${toMs("created_at", "created_ms")}
       from facetdb.question_set_versions where source_id = $1 order by version desc limit 1`,
    [sourceId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        version: integer(row, "version"),
        contentHash: text(row, "content_hash"),
        createdAt: new Date(integer(row, "created_ms")),
      };
}
