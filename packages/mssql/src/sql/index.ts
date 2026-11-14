export {
  ADMIN_REQUEST_TIMEOUT_MS,
  connectionConfig,
  connectMssql,
  type MssqlClient,
  type MssqlConnect,
  type MssqlQuery,
  type MssqlRow,
  serverFailure,
} from "./client.ts";
export { qualifiedName, quoteName, quoteString } from "./identifier.ts";
export {
  adminUrlRefusal,
  DEFAULT_PORT,
  MSSQL_SCHEMES,
  type MssqlUrl,
  MssqlUrlError,
  parseMssqlUrl,
  type TlsProblem,
  tlsProblem,
  URL_FORM,
  withoutSecrets,
} from "./url.ts";
