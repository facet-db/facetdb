import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "../sql/index.ts";
import type { Crypto } from "./crypto.ts";
import { text } from "./rows.ts";

/**
 * What FacetDB keeps secret for a project: the worker login and webhook secrets (encrypted, so they
 * can be used again) and the API keys (hashed, so they can only be checked). The admin credential is
 * never stored, so there is no method here that could take it.
 */
export type CredentialStore = {
  /** Seals `plaintext` under the install's key and stores only the ciphertext. */
  put(projectId: string, name: string, plaintext: string): Promise<void>;
  /** Opens a stored credential, or undefined when there is none. A wrong `FACETDB_SECRET` throws. */
  get(projectId: string, name: string): Promise<string | undefined>;
  remove(projectId: string, name: string): Promise<void>;
  /** The names stored for the project, never their values. */
  names(projectId: string): Promise<readonly string[]>;
};

export type CreatedApiKey = {
  readonly id: string;
  /** The key itself. It is shown once: the store keeps only its hash. */
  readonly secret: string;
};

export type ApiKeyOwner = { readonly id: string; readonly projectId: string };

export type ApiKeyStore = {
  create(projectId: string, name: string): Promise<CreatedApiKey>;
  /** The key's owner while it is live; undefined for an unknown or revoked key. */
  verify(secret: string): Promise<ApiKeyOwner | undefined>;
  /** True when a live key was revoked. */
  revoke(id: string): Promise<boolean>;
};

export function createCredentialStore(client: SqlClient, crypto: Crypto): CredentialStore {
  const purpose = (projectId: string, name: string): string => `credential:${projectId}:${name}`;
  return {
    async put(projectId, name, plaintext) {
      await client.query(
        `insert into facetdb.credentials (project_id, name, ciphertext) values ($1, $2, $3)
         on conflict (project_id, name) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
        [projectId, name, crypto.encrypt(plaintext, purpose(projectId, name))],
      );
    },

    async get(projectId, name) {
      const rows = await client.query(
        "select ciphertext from facetdb.credentials where project_id = $1 and name = $2",
        [projectId, name],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : crypto.decrypt(text(row, "ciphertext"), purpose(projectId, name));
    },

    async remove(projectId, name) {
      await client.query("delete from facetdb.credentials where project_id = $1 and name = $2", [
        projectId,
        name,
      ]);
    },

    async names(projectId) {
      const rows = await client.query(
        "select name from facetdb.credentials where project_id = $1 order by name",
        [projectId],
      );
      return rows.map((row) => text(row, "name"));
    },
  };
}

const KEY_PREFIX = "fdb_";

/** A key is 192 random bits, so a plain SHA-256 is enough to store: there is nothing to guess. */
function hashKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createApiKeyStore(client: SqlClient): ApiKeyStore {
  return {
    async create(projectId, name) {
      const id = randomUUID();
      const secret = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
      await client.query(
        "insert into facetdb.api_keys (id, project_id, name, key_hash) values ($1, $2, $3, $4)",
        [id, projectId, name, hashKey(secret)],
      );
      return { id, secret };
    },

    async verify(secret) {
      const rows = await client.query(
        "select id, project_id from facetdb.api_keys where key_hash = $1 and revoked_at is null",
        [hashKey(secret)],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : { id: text(row, "id"), projectId: text(row, "project_id") };
    },

    async revoke(id) {
      const rows = await client.query(
        "update facetdb.api_keys set revoked_at = now() where id = $1 and revoked_at is null returning id",
        [id],
      );
      return rows.length > 0;
    },
  };
}
