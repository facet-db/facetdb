// Change Tracking as the capture: the poll that fills the queue, the version's place in the store's
// cursors.
export {
  createTrackedCapture,
  NO_CURSORS,
  noteOnStderr,
  POLLER_LOCK,
  pollerLock,
  type TrackedCapture,
  type TrackedCaptureDeps,
  VERSION_SAVE_MS,
  versionRun,
  warnOnStderr,
} from "./change-tracking.ts";
// The runtime connector under the worker login and the pool it talks through.
export {
  connectMssqlPool,
  DEFAULT_MAX_CONNECTIONS,
  type MssqlPoolConnect,
  type MssqlPoolOptions,
  SESSION_STATEMENTS,
  WORKER_REQUEST_TIMEOUT_MS,
  workerConfig,
} from "./client.ts";
export {
  CLAIM_LEASE_MS,
  createMssqlConnector,
  MSSQL_CAPABILITIES,
  type MssqlConnector,
  type MssqlConnectorDeps,
  mssqlTime,
  POLL_MS,
  parseMssqlTime,
  stateTextOf,
} from "./connector.ts";
