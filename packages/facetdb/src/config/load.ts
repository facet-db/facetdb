import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectConfig } from "./dsl.ts";
import { ConfigError, type ConfigIssue, parseProjectConfig } from "./schema.ts";

/**
 * The loader: imports `facetdb.config.ts` through Node's type stripping, so there is no build step,
 * and judges what it exports with the schema. Evaluating a config runs the user's code, so the file
 * must live inside the project directory and is checked on its real path (a symlink or a `..` that
 * leads out is refused before anything is imported).
 */

export type LoadOptions = {
  /** The project directory; the config must be inside it. */
  readonly projectDir: string;
  /** The environment the config's `process.env` expressions were read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function realPathOf(path: string, what: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new ConfigError([
      {
        path: "",
        message: `${what} ${path} does not exist; create it with facetdb init, or pass the path of your config file`,
      },
    ]);
  }
}

/** The environment variable a connection string was read from: DATABASE_URL first, then by name. */
function variableHolding(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const names = Object.keys(env)
    .filter((name) => env[name] === value)
    .sort((a, b) => (a === "DATABASE_URL" ? -1 : b === "DATABASE_URL" ? 1 : a.localeCompare(b)));
  return names[0];
}

/**
 * Records, for each source, the variable its connection string came from. A string that no variable
 * holds was typed into the file, and a secret never lives there.
 */
function recordVariables(
  config: ProjectConfig,
  env: LoadOptions["env"],
): { config: ProjectConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const sources = config.sources.map((source, index) => {
    if (source.database === undefined || source.databaseEnv !== undefined) {
      return source;
    }
    const variable = variableHolding(source.database, env);
    if (variable === undefined) {
      issues.push({
        path: `sources[${index}].database`,
        message:
          "this connection string is written in the config file, and secrets never live there; read it from the environment: database: process.env.DATABASE_URL",
      });
      return source;
    }
    return { ...source, databaseEnv: variable };
  });
  return { config: { ...config, sources }, issues };
}

export async function loadConfig(path: string, options: LoadOptions): Promise<ProjectConfig> {
  const projectDir = await realPathOf(resolve(options.projectDir), "The project directory");
  const file = await realPathOf(resolve(projectDir, path), "The config file");
  if (!isInside(projectDir, file)) {
    throw new ConfigError([
      {
        path: "",
        message: `${path} is outside the project directory ${projectDir}; FacetDB only runs a config that lives in the project, so move it there or run facetdb from the directory that holds it`,
      },
    ]);
  }
  const { mtimeMs } = await stat(file);
  // The modification time in the URL makes an edited file load afresh in a long-running process.
  const loaded: unknown = await import(
    /* @vite-ignore */ `${pathToFileURL(file).href}?v=${mtimeMs}`
  );
  const exported = (loaded as { default?: unknown }).default;
  if (exported === undefined) {
    throw new ConfigError([
      {
        path: "",
        message: `${path} exports nothing; end it with export default facetdb({ ... })`,
      },
    ]);
  }
  const parsed = parseProjectConfig(exported);
  if (!parsed.ok) {
    throw new ConfigError(parsed.issues, path);
  }
  const { config, issues } = recordVariables(parsed.config, options.env);
  if (issues.length > 0) {
    throw new ConfigError(issues, path);
  }
  return config;
}
