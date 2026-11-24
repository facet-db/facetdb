import { dirname, join, resolve } from "node:path";
import { suggestedVariable } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  loadPlugin,
  type Plugin,
  PluginError,
  PluginNotInstalledError,
  packageNames,
  type RegistryIndex,
  type RegistryListing,
  satisfies,
  shortName,
} from "../../plugin/index.ts";
import { type CliDeps, CliError, defineCommand, EXIT_USAGE } from "../program.ts";
import {
  checkRegistryAddress,
  DEFAULT_REGISTRY,
  plain,
  readRegistry,
  registryAddress,
} from "../registry/index.ts";

/**
 * `facetdb add`: with a name, it finds the plugin in the registry's index, refuses a core range
 * this facetdb does not satisfy, prints the package manager's command line and then runs it, and
 * prints the lines to paste into the config; it writes no file. With no name it lists the registry.
 * The package manager is the one a package.json declares or a lockfile shows, from the project's
 * directory up to the nearest `.git`, run with an argument list and no shell. Everything the index
 * says is data: the reader checked each field's shape, and a package name is checked against the
 * loader's naming rule again before the package manager sees it.
 */

type AddOptions = {
  readonly registry?: string;
  readonly search?: string;
};

/** The last line after an install: the one step that puts the plugin into a worker. */
const RESTART_LINE = "Restart facetdb worker to load it.";

const REGISTRY_FIX =
  "if it says to upgrade facetdb, upgrade it; otherwise check the address and your network, or read another copy of the index with --registry <url or file> (or the FACETDB_REGISTRY variable)";

/**
 * The registry's index and the address it was read at, as shown: the one reader of `cli/registry`,
 * which the studio's gallery uses too. A refused address is never fetched, and no word of what
 * failed is more than the reader's fixed words.
 */
async function readIndex(
  deps: CliDeps,
  flag: string | undefined,
): Promise<{
  readonly index: RegistryIndex;
  readonly address: string;
  /** Whether this is the FacetDB team's own registry: only that one speaks for the team. */
  readonly official: boolean;
}> {
  if (flag !== undefined && flag.trim() === "") {
    throw new CliError(
      "add-usage",
      "--registry needs an address",
      "give the address of an index.json, or the path of one: --registry https://example.com/index.json",
      EXIT_USAGE,
    );
  }
  // The operator's own terminal: a file's path, once it passed the check, may be shown.
  const checked = checkRegistryAddress(
    registryAddress(deps.env, flag),
    flag === undefined ? "env" : "flag",
  );
  if (!checked.usable) {
    throw new CliError("registry-address", checked.why, REGISTRY_FIX);
  }
  const read = await readRegistry(checked, deps);
  if ("why" in read) {
    throw new CliError(
      "registry-unreadable",
      `${read.why} (the registry at ${checked.shown})`,
      REGISTRY_FIX,
    );
  }
  return {
    index: read.index,
    address: checked.shown,
    official: checked.address === DEFAULT_REGISTRY,
  };
}

/** The edit distance of two words: how many single letters turn one into the other. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row.push(
        Math.min(
          (previous[j] as number) + 1,
          (row[j - 1] as number) + 1,
          (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    previous = row;
  }
  return previous[b.length] as number;
}

/** Up to three listed names that look like the one asked for, the closest first. */
function nearest(asked: string, listed: readonly RegistryListing[]): readonly string[] {
  const reach = Math.max(2, Math.floor(asked.length / 3));
  return listed
    .map(({ name }) => ({ name, away: distance(asked, name) }))
    .filter(
      ({ name, away }) =>
        away <= reach ||
        (asked.length >= 3 && name.includes(asked)) ||
        (name.length >= 3 && asked.includes(name)),
    )
    .sort((a, b) => (a.away === b.away ? (a.name < b.name ? -1 : 1) : a.away - b.away))
    .slice(0, 3)
    .map(({ name }) => name);
}

function kindsOf(entry: RegistryListing): string {
  return entry.kinds.join(", ");
}

/** The registry as a table: name, a verified mark, the download figure and the description. */
function table(listed: readonly RegistryListing[]): string[] {
  const nameWidth = Math.max("name".length, ...listed.map(({ name }) => name.length));
  const downloadsWidth = Math.max(
    "downloads".length,
    ...listed.map(({ downloads }) => String(downloads).length),
  );
  const row = (name: string, verified: string, downloads: string, description: string) =>
    `  ${name.padEnd(nameWidth)}  ${verified.padEnd("verified".length)}  ${downloads.padStart(downloadsWidth)}  ${description}`;
  return [
    row("name", "verified", "downloads", "description"),
    ...listed.map((entry) =>
      row(
        entry.name,
        entry.verified ? "verified" : "",
        String(entry.downloads),
        `${entry.description} (${kindsOf(entry)})`,
      ),
    ),
  ];
}

function list(
  index: RegistryIndex,
  address: string,
  search: string | undefined,
  print: (text: string) => void,
) {
  const term = search?.trim().toLowerCase();
  const matching =
    term === undefined || term === ""
      ? index.plugins
      : index.plugins.filter((entry) =>
          [entry.name, entry.description, ...entry.kinds].some((field) =>
            field.toLowerCase().includes(term),
          ),
        );
  if (matching.length === 0) {
    print(
      term === undefined || term === ""
        ? `The registry at ${address} lists no plugin yet.`
        : `No plugin in the registry at ${address} matches "${plain(search ?? "")}". Run facetdb add to list them all.`,
    );
  } else {
    print(
      [
        `${matching.length === index.plugins.length ? "Plugins" : "Matching plugins"} in the registry at ${address}:`,
        "",
        ...table(matching),
        "",
        "Install one with: facetdb add <name>",
      ].join("\n"),
    );
  }
  return { ok: true, registry: address, plugins: matching };
}

/** The four package managers: the verbs that add a package and that remove it. */
const VERBS = {
  pnpm: { add: "add", remove: "remove" },
  yarn: { add: "add", remove: "remove" },
  bun: { add: "add", remove: "remove" },
  npm: { add: "install", remove: "uninstall" },
} as const;

type ManagerName = keyof typeof VERBS;

/** Each lockfile a package manager leaves. */
const LOCKFILES: readonly { readonly lockfile: string; readonly program: ManagerName }[] = [
  { lockfile: "pnpm-lock.yaml", program: "pnpm" },
  { lockfile: "yarn.lock", program: "yarn" },
  { lockfile: "bun.lock", program: "bun" },
  { lockfile: "bun.lockb", program: "bun" },
  { lockfile: "package-lock.json", program: "npm" },
  { lockfile: "npm-shrinkwrap.json", program: "npm" },
];

/** The most of a package.json read to look for its `packageManager`: a real one is a few KB. */
const MAX_PACKAGE_JSON = 1_000_000;

/** The package manager a package.json declares in `packageManager` (`pnpm@9.1.0`), if it does. */
async function declaredManager(deps: CliDeps, path: string): Promise<ManagerName | undefined> {
  const found = await deps.workspace.peek(path).catch(() => undefined);
  if (found?.kind !== "file" || (found.bytes ?? 0) > MAX_PACKAGE_JSON) {
    return undefined;
  }
  let text = "";
  try {
    for await (const line of deps.workspace.lines(path)) {
      text += `${line}\n`;
      if (text.length > MAX_PACKAGE_JSON) {
        return undefined;
      }
    }
    // A third party's file, read as data: only a name that is one of the four is taken from it.
    const field: unknown = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
    const name = typeof field === "string" ? field.split("@")[0] : undefined;
    return name !== undefined && Object.hasOwn(VERBS, name) ? (name as ManagerName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project's package manager, and what decided it. From the project's directory up to the
 * nearest `.git` (or the filesystem root), the first directory where a package.json declares
 * `packageManager` or a lockfile sits decides, so a member of a pnpm or yarn workspace gets its
 * root's manager. The first lockfile of its list counts when a directory holds several. With none
 * found it is npm.
 */
async function packageManager(deps: CliDeps): Promise<{
  readonly program: ManagerName;
  readonly add: string;
  readonly remove: string;
  readonly why: string;
}> {
  const chosen = (program: ManagerName, why: string) => ({
    program,
    add: VERBS[program].add,
    remove: VERBS[program].remove,
    why,
  });
  let top = resolve(deps.projectDir);
  for (let level = 0; ; level += 1) {
    const prefix = "../".repeat(level);
    const directory = resolve(deps.projectDir, prefix);
    top = directory;
    const declared = await declaredManager(deps, `${prefix}package.json`);
    if (declared !== undefined) {
      return chosen(
        declared,
        `${join(directory, "package.json")} declares ${declared} as its packageManager, so ${declared}`,
      );
    }
    const found: (typeof LOCKFILES)[number][] = [];
    for (const candidate of LOCKFILES) {
      if (await deps.workspace.exists(`${prefix}${candidate.lockfile}`)) {
        found.push(candidate);
      }
    }
    const [first] = found;
    if (first !== undefined) {
      const others = found.slice(1).map((candidate) => candidate.lockfile);
      return chosen(
        first.program,
        `found ${join(directory, first.lockfile)}, so ${first.program}${others.length === 0 ? "" : ` (${others.join(" and ")} is there too; the first of them counts)`}`,
      );
    }
    if (dirname(directory) === directory || (await deps.workspace.exists(`${prefix}.git`))) {
      break;
    }
  }
  return chosen(
    "npm",
    `no lockfile and no packageManager from ${resolve(deps.projectDir)} up to ${top}, so npm`,
  );
}

/** The entries of each kind a plugin provides, by name. */
function provides(plugin: Plugin): Readonly<Record<string, readonly string[]>> {
  const kinds = {
    sources: Object.keys(plugin.sources),
    actions: Object.keys(plugin.actions),
    channels: Object.keys(plugin.channels),
    providers: Object.keys(plugin.providers),
    packs: Object.keys(plugin.packs),
  };
  return Object.fromEntries(Object.entries(kinds).filter(([, names]) => names.length > 0));
}

/** One place a secret lives in a plugin's settings, as the manifest's paths describe the shape. */
type Place = {
  readonly keys: Map<string, Place>;
  /** An element of a list, when the place is one. */
  item?: Place;
  /** Set where a secret sits: the variable to name there. */
  variable?: string;
};

function placeAt(): Place {
  return { keys: new Map() };
}

/** The tree of secret places a plugin's manifest lists (`token`, `auth.password`, `hooks[].secret`, `headers.*`). */
function secretTree(short: string, secrets: readonly string[]): Place {
  const root = placeAt();
  for (const pattern of secrets) {
    const steps = pattern.match(/\[\d*\]|[^.[\]]+/g) ?? [];
    let at = root;
    for (const step of steps) {
      if (step.startsWith("[")) {
        at.item ??= placeAt();
        at = at.item;
      } else {
        let next = at.keys.get(step);
        if (next === undefined) {
          next = placeAt();
          at.keys.set(step, next);
        }
        at = next;
      }
    }
    const named = steps.filter((step) => !step.startsWith("[") && step !== "*").at(-1);
    at.variable = suggestedVariable(short, named ?? "secret");
  }
  return root;
}

function keyText(key: string): string {
  if (key === "*") {
    return '"<name>"';
  }
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/** A value's lines with a comma after the last, the first preceded by `label` and everything by `indent`. */
function withComma(value: readonly string[], indent: string, label = ""): string[] {
  const lines = [`${indent}${label}${value[0]}`, ...value.slice(1)];
  lines[lines.length - 1] += ",";
  return lines;
}

/** The lines of a place as a value: `env("NAME")`, a list of one element, or an object closing at `indent`. */
function render(place: Place, indent: string): string[] {
  if (place.variable !== undefined) {
    return [`env("${place.variable}")`];
  }
  const inner = `${indent}  `;
  if (place.item !== undefined) {
    return ["[", ...withComma(render(place.item, inner), inner), `${indent}]`];
  }
  if (place.keys.size === 0) {
    return ["{}"];
  }
  return [
    "{",
    ...[...place.keys].flatMap(([key, child]) =>
      withComma(render(child, inner), inner, `${keyText(key)}: `),
    ),
    `${indent}}`,
  ];
}

/** The variables a plugin's secrets name, each once, in the order the manifest lists them. */
function variablesOf(place: Place): string[] {
  const found: string[] = [];
  const walk = (at: Place) => {
    if (at.variable !== undefined) {
      found.push(at.variable);
    }
    for (const child of at.keys.values()) {
      walk(child);
    }
    if (at.item !== undefined) {
      walk(at.item);
    }
  };
  walk(place);
  return [...new Set(found)];
}

/** The lines to paste: the import when a secret needs `env`, and the plugin's entry in `plugins`. */
function configLines(
  short: string,
  plugin: Plugin,
): {
  readonly import: string | null;
  readonly plugins: string;
  readonly variables: readonly string[];
} {
  const tree = secretTree(short, plugin.manifest.secrets);
  const variables = variablesOf(tree);
  const body = ["plugins: {", ...withComma(render(tree, "  "), "  ", `${keyText(short)}: `), "},"];
  return {
    import: variables.length === 0 ? null : 'import { env } from "facetdb";',
    plugins: body.join("\n"),
    variables,
  };
}

/** The error for a plugin the registry does not list, with the names that come close. */
function unknownPlugin(asked: string, index: RegistryIndex, address: string): CliError {
  const close = nearest(asked, index.plugins);
  return new CliError(
    "plugin-unknown",
    `the registry at ${address} lists no plugin named "${asked}"${close.length === 0 ? "" : `; the nearest names are ${close.join(", ")}`}`,
    close.length === 0
      ? "run facetdb add to list every plugin in the registry, or check the spelling"
      : `run facetdb add ${close[0]}, or facetdb add to list every plugin in the registry`,
  );
}

/** What loading the plugin just installed refused, as a failure the user can act on. */
function notLoadable(
  error: unknown,
  entry: RegistryListing,
  deps: CliDeps,
  /** The command that removes the package again, with the project's package manager. */
  removal: string,
): CliError {
  if (error instanceof PluginNotInstalledError) {
    return new CliError(
      "plugin-not-installed",
      `${entry.package} was installed, but it cannot be found from ${deps.projectDir}`,
      `check that the package manager installed it under ${deps.projectDir}/node_modules, then run facetdb doctor`,
    );
  }
  // The install took the registry's latest version, which this facetdb refuses: it is in the
  // project now, so the way to take it out again is part of what the user is told.
  const undo = `to take it out again, run in ${deps.projectDir}: ${removal}`;
  if (error instanceof PluginError) {
    return new CliError(
      "plugin-invalid",
      plain(error.message),
      `install a version of the plugin that works with this facetdb, or ${undo}`,
    );
  }
  return new CliError(
    "plugin-invalid",
    // Fixed words: what the plugin's own code threw may quote a value it was handed.
    `${entry.package} was installed, but it failed while it loaded`,
    `reinstall the plugin, or install a version of it that loads; ${undo}`,
  );
}

async function add(
  asked: string,
  short: string,
  index: RegistryIndex,
  address: string,
  official: boolean,
  deps: CliDeps,
  print: (text: string) => void,
  dryRun: boolean,
) {
  const entry = index.plugins.find((listed) => listed.name === short);
  if (entry === undefined) {
    throw unknownPlugin(short, index, address);
  }
  if (asked !== short && asked !== entry.package) {
    throw new CliError(
      "plugin-package",
      `the registry lists "${entry.name}" as the package ${entry.package}, not ${asked}`,
      `run facetdb add ${entry.name}`,
      EXIT_USAGE,
    );
  }
  if (!satisfies(VERSION, entry.facetdb)) {
    throw new CliError(
      "plugin-core-version",
      `the plugin "${entry.name}" supports FacetDB ${entry.facetdb}, but this is FacetDB ${VERSION}`,
      `upgrade or downgrade facetdb to a version in ${entry.facetdb}, or wait for a release of the plugin that supports ${VERSION}`,
    );
  }
  // The reader checked this already; the package manager is never handed a name that skipped it.
  if (!packageNames(entry.name).includes(entry.package)) {
    throw new CliError(
      "registry-invalid",
      `the registry lists "${entry.name}" as the package "${plain(entry.package)}", which is not ${packageNames(entry.name).join(" or ")}`,
      "tell the registry's maintainers; nothing was installed",
    );
  }
  if (!(await deps.workspace.exists("package.json"))) {
    throw new CliError(
      "no-package-json",
      `there is no package.json in ${deps.projectDir}, so there is nowhere to install a plugin`,
      "run facetdb add in your project's directory, where facetdb.config.ts lives, or create a package.json there first (npm init)",
    );
  }

  const manager = await packageManager(deps);
  const args = [manager.add, entry.package];
  const line = [manager.program, ...args].join(" ");
  const removal = [manager.program, manager.remove, entry.package].join(" ");
  const result = {
    ok: true,
    registry: address,
    plugin: entry,
    install: { packageManager: manager.program, command: line, ran: false },
  };

  // Only the FacetDB team's own registry speaks for the team: another one marks, and says so.
  const verified = official
    ? "It is verified: the FacetDB team has reviewed it."
    : `The registry at ${address} marks it verified; that is the registry's word, not the FacetDB team's.`;
  print(
    [
      `${entry.name} (${entry.package}): ${entry.description}`,
      entry.verified
        ? verified
        : "It is not verified. A plugin runs inside your worker with the worker's access: install only plugins you trust.",
      `It supports FacetDB ${entry.facetdb}; this is ${VERSION}.`,
      `The project's package manager: ${manager.why}.`,
      dryRun
        ? `This would download ${entry.package} from npm and run its install scripts, if your package manager runs them, and then load the plugin into this process, which runs its code, with your access.`
        : `This downloads ${entry.package} from npm and runs its install scripts, if your package manager runs them; then facetdb loads the plugin into this process to read what it provides, which runs its code, with your access.`,
      dryRun
        ? `Would run, in ${deps.projectDir}: ${line}`
        : `Running, in ${deps.projectDir}: ${line}`,
    ].join("\n"),
  );
  if (dryRun) {
    print(
      "After the install, facetdb add prints the lines to paste into facetdb.config.ts. It writes no file.\nDry run: nothing was installed.",
    );
    return { ...result, dryRun: true };
  }

  let code: number;
  try {
    code = await deps.runCommand(manager.program, args, { cwd: deps.projectDir });
  } catch {
    // Fixed words: what a failed start says can be anything the system or the program wrote.
    throw new CliError(
      "install-not-started",
      `${manager.program} could not be started`,
      `install ${manager.program}, or run the command above yourself in ${deps.projectDir} and then run facetdb doctor`,
    );
  }
  if (code !== 0) {
    throw new CliError(
      "install-failed",
      `${line} ended with exit code ${code}, so ${entry.package} is not installed`,
      `read what ${manager.program} printed above, fix it, and run facetdb add ${entry.name} again`,
    );
  }

  let plugin: Plugin;
  try {
    plugin = await loadPlugin(entry.package, {
      coreVersion: VERSION,
      importModule: deps.importPlugin,
    });
  } catch (error) {
    throw notLoadable(error, entry, deps, removal);
  }
  const lines = configLines(entry.name, plugin);
  const provided = provides(plugin);
  const providedWords = Object.entries(provided)
    .map(([kind, names]) => `${kind}: ${names.join(", ")}`)
    .join("; ");
  print(
    [
      "",
      `Installed ${entry.package} ${plugin.manifest.version}. It provides ${providedWords}.`,
      "",
      "Add it to facetdb.config.ts (facetdb add writes no file).",
      ...(lines.import === null
        ? []
        : ['With the other imports from "facetdb":', "", `  ${lines.import}`, ""]),
      "In the project, next to the other keys:",
      "",
      ...lines.plugins.split("\n").map((text) => `  ${text}`),
      "",
      `Its other settings go in the same entry (the plugin's page lists them).${
        lines.variables.length === 0
          ? ""
          : ` Set ${lines.variables.join(" and ")} where the worker runs, then run facetdb doctor.`
      }`,
      // A worker loads plugin code only when it starts (how a plugin reaches a running worker): a
      // new plugin, or a new version of one it runs, waits for the restart.
      RESTART_LINE,
    ]
      .map((text) => plain(text))
      .join("\n"),
  );
  return {
    ...result,
    install: { ...result.install, ran: true },
    installed: { package: entry.package, version: plugin.manifest.version, provides: provided },
    config: { import: lines.import, plugins: lines.plugins, variables: lines.variables },
  };
}

export const addCommand = defineCommand<AddOptions>("add", {
  description:
    "Installs a plugin from the registry with the project's package manager and prints the lines to paste into the config; with no name, lists the registry",
  arguments: ["[name]"],
  options: [
    {
      flags: "--registry <url or file>",
      description: `the registry's index.json; by default the FACETDB_REGISTRY variable, else ${DEFAULT_REGISTRY}; an https address or the path of a file`,
    },
    { flags: "--search <term>", description: "with no name: only the plugins that match the term" },
  ],
  run: async ({ options, args, deps, print }) => {
    const [asked] = args;
    if (asked !== undefined && options.search !== undefined) {
      throw new CliError(
        "add-usage",
        "--search lists plugins, and a name installs one: not both",
        "run facetdb add --search <term> to search, or facetdb add <name> to install",
        EXIT_USAGE,
      );
    }
    // A name is judged before the network is asked anything.
    const short = asked === undefined ? undefined : shortName(asked);
    if (asked !== undefined && short === undefined) {
      throw new CliError(
        "plugin-name",
        `"${plain(asked)}" is not a plugin name`,
        "a plugin is named github, @facetdb/github or facetdb-plugin-github: lowercase letters, digits and dashes; facetdb add lists the registry's",
        EXIT_USAGE,
      );
    }
    const { index, address, official } = await readIndex(deps, options.registry);
    return asked === undefined || short === undefined
      ? list(index, address, options.search, print)
      : add(asked, short, index, address, official, deps, print, options.dryRun);
  },
});
