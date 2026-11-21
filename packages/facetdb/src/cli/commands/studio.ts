import { defineCommand } from "../program.ts";
import { ALLOW_INSECURE_OPTION, loadWorkerConfig } from "./database.ts";
import {
  CONNECTIONS_OPTION,
  DEFAULT_PORT,
  HOST_OPTION,
  hostInUrl,
  parseHost,
  parsePort,
  requiredStudio,
  requireModel,
  runWorkerProcess,
  type WorkerOptions,
} from "./worker.ts";

/**
 * `facetdb studio` ("opens the local dashboard, including the review screen, on your machine"): the
 * worker, as `facetdb worker` runs it, with the studio's build served beside the API, its address
 * printed and the browser opened there. It is one process: the queue loops, the heartbeat, the
 * check API and the studio. With no build it stops and says to run `pnpm build`; it never starts
 * Vite. The worker's rules stand: 127.0.0.1 unless `--host` says otherwise, any other address only
 * once a reviewer account exists, and `FACETDB_SECRET` set.
 */

type StudioOptions = Omit<WorkerOptions, "http" | "once"> & {
  /** False under `--no-open`: the address is printed and nothing else is started. */
  readonly open: boolean;
};

/**
 * The address a browser on this machine opens: the bound host, except an address that means
 * "every interface", which no browser can open; its loopback stands for it.
 */
export function studioUrl(host: string, port: number): string {
  const browsable =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "::1" : host;
  return `http://${hostInUrl(browsable)}:${port}`;
}

export const studioCommand = defineCommand<StudioOptions>("studio", {
  description:
    "Opens the studio, the local dashboard with the review screen, in your browser: runs the worker and serves the studio beside the check API on 127.0.0.1 port 4040",
  options: [
    { flags: "--config <path>", description: "the config file", defaultValue: "facetdb.config.ts" },
    {
      flags: "--port <port>",
      description: "the port of the studio and the check API",
      defaultValue: String(DEFAULT_PORT),
    },
    CONNECTIONS_OPTION,
    HOST_OPTION,
    { flags: "--no-open", description: "print the address and open no browser" },
    {
      flags: "--studio-dir <path>",
      description:
        "the studio build to serve (a built apps/studio dist/); by default this install's own",
    },
    ALLOW_INSECURE_OPTION,
  ],
  run: async (context) => {
    const { options, deps, print } = context;
    // The worker's own start: the plugins the config names are loaded and checked, as it does.
    const { config, plugins } = await loadWorkerConfig(deps, options.config);
    requireModel(config, deps.env);
    parsePort(options.port);
    // Before the address can reach the opener: a host is an address or a plain name (worker.ts).
    parseHost(options.host);
    const studio = await requiredStudio(deps, options.studioDir);
    if (options.dryRun) {
      print(
        `Would answer ${config.sources.map((source) => source.name).join(", ")}, serve the studio from ${studio.dir} and the check API on ${options.host}, port ${options.port}${options.open ? ", and open it in your browser" : ""}. Dry run: nothing was started.`,
      );
      return { ok: true, dryRun: true };
    }
    const { open, ...worker } = options;
    return runWorkerProcess(
      { ...context, options: { ...worker, http: true, once: false } },
      config,
      {
        studio,
        plugins,
        listening: async (host, port) => {
          const url = studioUrl(host, port);
          if (!open) {
            print(`The studio is at ${url}: open it in your browser.`);
            return;
          }
          try {
            await deps.openBrowser(url);
            print(`Opened ${url} in your browser.`);
          } catch (error) {
            // The studio runs on: a server with no browser is a fine place for it.
            print(
              `Could not open a browser (${error instanceof Error ? error.message : String(error)}): open ${url} yourself.`,
            );
          }
        },
      },
    );
  },
});
