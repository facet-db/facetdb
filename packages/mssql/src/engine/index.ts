// The SQL Server and Azure SQL engine the CLI registers: the install's plans and run, the
// connector, doctor.
export {
  DOCTOR_CHECKS,
  doctorChecks,
  MINIMUM_MAJOR_VERSION,
  serverName,
} from "./doctor.ts";
export {
  createMssqlEngine,
  ENGINE_NAME,
  type MssqlEngineOptions,
  mssqlEngine,
} from "./engine.ts";
