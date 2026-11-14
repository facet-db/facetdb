export type { StoreConnector, StoreConnectorOptions, StoredRecord } from "./connector.ts";
export type { Crypto } from "./crypto.ts";
export { createCrypto, newSalt, requireSecret, SECRET_VARIABLE } from "./crypto.ts";
export {
  type PurgedSource,
  readStoreLog,
  type StoreLog,
  storePurgeRefusal,
  storePurgeStatements,
} from "./purge.ts";
export {
  migrateStore,
  PROJECTS_TABLE_SQL,
  rekeyNotes,
  SCHEMA_VERSION,
  STORE_APPEND_ONLY_TABLES,
  STORE_FUNCTIONS,
  STORE_SEQUENCES,
  STORE_TABLES,
  STORE_VERSION_TABLE,
  StoreNotInstalledError,
  storeInstallStatements,
  storeVersion,
} from "./schema.ts";
export type {
  ApiKeyOwner,
  ApiKeyStore,
  CreatedApiKey,
  CredentialStore,
} from "./secrets.ts";
export { sourceIdOf } from "./source-id.ts";
export type { SourceKind, Store, StoreOptions } from "./store.ts";
export { AmbiguousHostError, createStore, PlaintextUrlError, requireTls } from "./store.ts";
