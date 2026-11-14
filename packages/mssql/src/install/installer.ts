import type { DatabaseEngine } from "@facetdb/core";
import type { MssqlConnect } from "../sql/index.ts";
import { planInstall } from "./install.ts";
import { planPrune } from "./prune.ts";
import { render } from "./render.ts";
import { runPlan } from "./run.ts";
import { planUninstall } from "./uninstall.ts";

/**
 * The part of the SQL Server engine (`DatabaseEngine`) that plans, prints and runs: install,
 * uninstall and prune. The engine spreads it beside its `open`, `doctor` and `checkUrl`.
 */
export type MssqlInstaller = Pick<
  DatabaseEngine,
  "planInstall" | "planUninstall" | "planPrune" | "render" | "run"
>;

/** The installer over a driver: tedious's `connectMssql` in production, a recording client in a test. */
export function createInstaller(deps: { readonly connect: MssqlConnect }): MssqlInstaller {
  const { connect } = deps;
  return {
    planInstall: (target, url, options) => planInstall(connect, target, url, options),
    planUninstall: (target, url, options) => planUninstall(connect, target, url, options),
    planPrune: (target, url, engineDeps) => planPrune(connect, target, url, engineDeps),
    render,
    run: (target, plan, url, options) => runPlan(connect, target, plan, url, options),
  };
}
