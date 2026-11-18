// doctor's look at Change Tracking as the capture.
export { CHANGE_TRACKING_CHECK, trackingRightsMissing } from "./change-tracking.ts";
// The SQL Server and Azure SQL engine the CLI registers: the install's plans and run, the
// connector, doctor.
export {
  checksOf,
  DOCTOR_CHECKS,
  doctorChecks,
  MINIMUM_MAJOR_VERSION,
  serverName,
} from "./doctor.ts";
export {
  createMssqlEngine,
  ENGINE_NAME,
  lazyCursors,
  type MssqlEngineOptions,
  mssqlEngine,
  type OpenCursors,
  type OpenedCursors,
} from "./engine.ts";
