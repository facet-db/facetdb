import type { DatabaseEngine } from "@facetdb/core";
import type { MysqlConnect } from "../sql/index.ts";
import { planInstall } from "./install.ts";
import { planPrune } from "./prune.ts";
import { runPlan } from "./run.ts";
import { renderScript } from "./sql.ts";
import { planUninstall } from "./uninstall.ts";

/**
 * The part of the MySQL engine (`DatabaseEngine`) that writes into a database: the three plans,
 * their script and their run, typed by the contract itself. The engine adds the name, the schemes,
 * `open`, `checkUrl` and `doctor` around it, with `connectMysql` in production.
 */
export type MysqlInstaller = Pick<
  DatabaseEngine,
  "planInstall" | "planUninstall" | "planPrune" | "render" | "run"
>;

export type MysqlInstallerOptions = {
  /** The driver: mysql2 in production, the recording driver of `../testing` in a unit test. */
  readonly connect: MysqlConnect;
};

export function createMysqlInstaller(options: MysqlInstallerOptions): MysqlInstaller {
  const { connect } = options;
  return {
    planInstall: (target, url, installOptions) => planInstall(connect, target, url, installOptions),
    planUninstall: (target, url, uninstallOptions) =>
      planUninstall(connect, target, url, uninstallOptions),
    planPrune: (target, url, deps) => planPrune(connect, target, url, deps),
    render: renderScript,
    run: (target, plan, url, runOptions) => runPlan(connect, target, plan, url, runOptions),
  };
}
