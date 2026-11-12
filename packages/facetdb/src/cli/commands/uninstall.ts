import { uninstall } from "@facetdb/postgres";
import { type CliDeps, CliError, defineCommand } from "../program.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminUrl,
  loadProjectConfig,
  refused,
  sameAsShown,
  type TableTarget,
  tableTargets,
} from "./database.ts";

/**
 * `facetdb uninstall`: prints the script for every table first, from a dry run of the connector,
 * then asks for the project's name back once; a wrong name runs nothing. The confirmed run refuses
 * any script but the one shown. The decision log stays unless `--purge`.
 */

type UninstallOptions = {
  readonly config: string;
  readonly adminUrl?: string;
  readonly source?: string;
  readonly purge: boolean;
  readonly allowInsecure?: boolean;
};

type Shown = { readonly target: TableTarget; readonly sql: string; readonly project: string };

function uninstallSource(target: TableTarget) {
  return { table: target.table, schema: target.schema, sourceId: target.source.name };
}

async function show(
  deps: CliDeps,
  url: string,
  target: TableTarget,
  purge: boolean,
): Promise<Shown> {
  const result = await uninstall({
    adminUrl: url,
    source: uninstallSource(target),
    purge,
    print: () => undefined,
    // A dry run asks nothing; the name is asked once, for every table, after all scripts are shown.
    confirm: () => Promise.resolve(""),
    dryRun: true,
    connect: deps.connect,
  });
  if (!result.ok) {
    throw refused("uninstall-refused", result.reason);
  }
  return { target, sql: result.sql, project: await installedProject(deps, url, target) };
}

const QUERY_PROJECT_NAME = `select p.name from facetdb.table_owners o join facetdb.projects p on p.id = o.project_id
 where o.table_schema = $1 and o.table_name = $2`;

/** The project's name as install recorded it: what has to be typed back. */
async function installedProject(deps: CliDeps, url: string, target: TableTarget): Promise<string> {
  const client = deps.connect(url);
  try {
    const rows = await client.query(QUERY_PROJECT_NAME, [target.schema, target.table]);
    return String(rows[0]?.["name"] ?? "");
  } finally {
    await client.close();
  }
}

export const uninstallCommand = defineCommand<UninstallOptions>("uninstall", {
  description:
    "Prints its SQL, asks for the project name back, and removes the columns, trigger and queue",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    {
      flags: "--admin-url <url>",
      description:
        "a connection string that may alter the tables; asked for when absent, never stored",
    },
    { flags: "--source <name>", description: "uninstall only this source" },
    { flags: "--purge", description: "also delete the decision log of these sources" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const config = await loadProjectConfig(deps, options.config);
    const targets = tableTargets(config, options.source);
    const url = await adminUrl(deps, options.adminUrl, options.allowInsecure);
    const shown: Shown[] = [];
    for (const target of targets) {
      shown.push(await show(deps, url, target, options.purge));
    }
    for (const item of shown) {
      const table = `${item.target.schema}.${item.target.table}`;
      print(
        `-- facetdb uninstall${options.purge ? " --purge" : ""}: ${item.target.source.name} (${table})`,
      );
      print(item.sql);
    }
    const summary = (applied: boolean) => ({
      ok: true,
      dryRun: options.dryRun,
      purge: options.purge,
      sources: shown.map((item) => ({
        source: item.target.source.name,
        table: `${item.target.schema}.${item.target.table}`,
        sql: item.sql,
        applied,
      })),
    });
    if (options.dryRun) {
      print("Dry run: nothing was changed.");
      return summary(false);
    }
    const names = [...new Set(shown.map((item) => item.project))];
    const typed = await deps.io.prompt(
      `This removes what FacetDB added to ${shown.length === 1 ? "this table" : "these tables"}${options.purge ? ", and the decision log" : ""}. Type the project name (${names.join(", ")}) to continue: `,
    );
    // The connector compares what was typed with the name on each table; check all before any runs.
    if (shown.some((item) => typed.trim() !== item.project)) {
      throw new CliError(
        "not-confirmed",
        `the name typed is not the project's name (${names.join(", ")}); nothing was changed`,
        "run facetdb uninstall again and type the project name exactly",
      );
    }
    for (const item of shown) {
      const result = await uninstall({
        adminUrl: url,
        source: uninstallSource(item.target),
        purge: options.purge,
        print: sameAsShown(item.sql),
        confirm: () => Promise.resolve(typed),
        connect: deps.connect,
      });
      if (!result.ok) {
        throw refused("uninstall-refused", result.reason);
      }
      print(`Removed FacetDB from ${item.target.schema}.${item.target.table}.`);
    }
    return summary(true);
  },
});
