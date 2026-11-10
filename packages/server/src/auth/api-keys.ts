import type { ApiKeyOwner, ApiKeyStore, CreatedApiKey } from "@facetdb/postgres";

/**
 * Project API keys: `facetdb keys add` makes one, the SDK sends it as `Authorization: Bearer <key>`.
 * The store keeps only the SHA-256 of a key and finds it by that hash, so the plaintext exists in
 * memory at creation and while one request is checked.
 */
export type ApiKeys = {
  /** Makes a key for the project. The `secret` in the result is shown once and never stored. */
  create(projectId: string, name: string): Promise<CreatedApiKey>;
  /** The owner of the key in an `Authorization` header while it is live; undefined otherwise. */
  verify(header: string | undefined): Promise<ApiKeyOwner | undefined>;
  /** True when a live key was revoked. */
  revoke(id: string): Promise<boolean>;
};

const BEARER = /^Bearer +(\S+)$/i;

export function createApiKeys(store: ApiKeyStore): ApiKeys {
  return {
    create: (projectId, name) => store.create(projectId, name),

    async verify(header) {
      const secret = header === undefined ? undefined : BEARER.exec(header)?.[1];
      // A missing or malformed header is the caller's mistake, not a lookup: no store call is made.
      return secret === undefined ? undefined : store.verify(secret);
    },

    revoke: (id) => store.revoke(id),
  };
}
