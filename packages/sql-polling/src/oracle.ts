/**
 * @facetdb/sql-polling/oracle: Oracle Database as a polling dialect, through `oracledb` in thin
 * mode. A subpath of its own because `@facetdb/postgres` imports this package's root: a dialect
 * exported there would load `oracledb` for every Postgres user. The CLI imports this module only
 * for a source whose connection string is `oracle://`.
 */
export { createOracleEngine, oracleDialect } from "./dialects/oracle.ts";
export {
  connectOracle,
  type OracleTarget,
  oracleFailure,
  oracleTarget,
  SESSION_SETTINGS,
  settleSession,
} from "./dialects/oracle-connect.ts";
