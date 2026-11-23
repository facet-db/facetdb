// pack-check.ts <root> <out> <package dir>...: the checks of scripts/pack-check.sh on the tarballs
// `pnpm pack` wrote to <out>, each unpacked under <out>/unpacked/<tarball>/package. Prints one line
// per tarball, then one line per problem; exit 1 on any problem.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [, , root, out, ...dirs] = process.argv;
if (root === undefined || out === undefined || dirs.length === 0) {
  console.error("usage: pack-check.ts <root> <out> <package dir>...");
  process.exit(2);
}

type Manifest = {
  name: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** A package.json, which this script did not write: a boundary, so its shape is checked here. */
function readManifest(file: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    throw new Error(`${file}: no package name`);
  }
  return parsed as Manifest;
}

/** Every string target of an `exports` value, with the subpath it sits under. */
function exportTargets(value: unknown, subpath: string): [string, string][] {
  if (typeof value === "string") return [[subpath, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    exportTargets(inner, key.startsWith(".") ? key : subpath),
  );
}

/**
 * Any quoted relative specifier ending in .ts, in whatever position: wider than the pattern
 * dts-extensions.ts rewrites, so a form the rewriter misses (or JavaScript tsc left alone) still
 * fails here.
 */
const RELATIVE_TS = /["'`]\.{1,2}\/[^"'`\n]*\.ts["'`]/;

/** The files git tracks under a package directory, relative to it. */
function tracked(repository: string, packageDir: string): Set<string> {
  const listing = execFileSync("git", ["-C", repository, "ls-files", "-z", "--", packageDir], {
    encoding: "utf8",
  });
  const prefix = `${packageDir}/`;
  return new Set(
    listing
      .split("\0")
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length)),
  );
}

const FORBIDDEN: [RegExp, string][] = [
  [/^src\//, "a path under src/"],
  [/(^|\/)\.facetdb\//, "local data of facetdb dev (.facetdb/)"],
  [/(^|\/)node_modules\//, "an installed dependency (node_modules/)"],
  [/(^|\/)[^/]*\.test\.[^/]*$/, "a test file"],
  [/(^|\/)testing\//, "a test helper under testing/"],
  [/(^|\/)[^/]*-world\.[^/]*$/, "a test world"],
  [/(^|\/)e2e\//, "an end-to-end test file"],
  [/(^|\/)fixtures\//, "a test fixture"],
  [/\.map$/, "a source map"],
  [/\.tsbuildinfo$/, "tsc build info"],
  [/(^|\/)\.env(\.[^/]*)?$/, "an .env file"],
  [/\.(pem|key)$/, "a key file"],
];

const hasLicense = existsSync(join(root, "LICENSE"));
const tarballs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
const unpacked = new Map<string, { tarball: string; dir: string; manifest: Manifest }>();
for (const tarball of tarballs) {
  const dir = join(out, "unpacked", tarball.replace(/\.tgz$/, ""), "package");
  const manifest = readManifest(join(dir, "package.json"));
  unpacked.set(manifest.name, { tarball, dir, manifest });
}

const problems: string[] = [];
const lines: string[] = [];
for (const packageDir of dirs) {
  const { name } = readManifest(join(root, packageDir, "package.json"));
  const found = unpacked.get(name);
  if (found === undefined) {
    problems.push(`${name}: no tarball in ${out} (${packageDir} was not packed)`);
    continue;
  }
  const { tarball, dir, manifest } = found;
  const files = readFileSync(
    join(out, "unpacked", `${tarball.replace(/\.tgz$/, "")}.files`),
    "utf8",
  )
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith("/"));
  const bad = (what: string): void => {
    problems.push(`${tarball}: ${what}`);
  };
  const bytes = statSync(join(out, tarball)).size;
  lines.push(`${tarball}: ${files.length} files, ${Math.ceil(bytes / 1024)} kB`);

  // Outside the build output, a tarball ships only what git tracks: a file someone left on disk
  // under examples/ (a .facetdb/ data directory, a database file) is never published, whatever the
  // `files` list lets through.
  const inGit = tracked(root, packageDir);
  const built = (f: string): boolean =>
    f.startsWith("dist/") || f === "package.json" || (hasLicense && f === "LICENSE");
  for (const file of files.filter((f) => !built(f) && !inGit.has(f))) {
    bad(`${file} is not tracked by git under ${packageDir}; only committed files ship`);
  }

  for (const file of files) {
    for (const [pattern, what] of FORBIDDEN) if (pattern.test(file)) bad(`${file} is ${what}`);
    const isSource = /\.(ts|tsx|mts|cts)$/.test(file) && !/\.d\.(ts|mts|cts)$/.test(file);
    // The facetdb package's examples/ are project templates `facetdb init --example` copies into
    // the user's project as text; nothing loads them from node_modules.
    if (isSource && !(name === "facetdb" && file.startsWith("examples/"))) {
      bad(`${file} is a TypeScript source; only dist/ JavaScript and declarations ship`);
    }
    if (/\.(d\.ts|js)$/.test(file) && RELATIVE_TS.test(readFileSync(join(dir, file), "utf8"))) {
      bad(`${file} names a relative .ts file, which does not ship (scripts/lib/dts-extensions.ts)`);
    }
  }

  for (const [subpath, target] of exportTargets(manifest.exports, ".")) {
    if (subpath === "./testing" || subpath.startsWith("./testing/")) {
      bad(`exports "${subpath}" is a testing subpath; publishConfig.exports leaves it out`);
    }
    if (!existsSync(join(dir, target)))
      bad(`exports "${subpath}" names ${target}, not in the tarball`);
  }
  const bins = typeof manifest.bin === "string" ? { [name]: manifest.bin } : (manifest.bin ?? {});
  for (const [command, target] of Object.entries(bins)) {
    if (!existsSync(join(dir, target))) bad(`bin "${command}" names ${target}, not in the tarball`);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) bad(`${field} ${dependency} keeps the range ${range}`);
    }
  }
  if (hasLicense && !files.includes("LICENSE")) bad("no LICENSE, though the root has one");

  if (name === "facetdb") {
    // The reverse of the git rule: every committed example file ships, so a `files` pattern too
    // narrow for a new kind of example file fails here instead of shipping a broken example.
    const shipped = new Set(files);
    const examples = [...inGit].filter((f) => f.startsWith("examples/"));
    if (examples.length === 0) bad("no examples/ in git (init --example reads them)");
    for (const file of examples.filter((f) => !shipped.has(f))) {
      bad(`${file} is a committed example file the tarball leaves out (package.json "files")`);
    }
    const main = bins.facetdb;
    if (main === undefined) bad('no bin "facetdb"');
    else if (existsSync(join(dir, main))) {
      const first = readFileSync(join(dir, main), "utf8").split("\n", 1)[0];
      if (first !== "#!/usr/bin/env node")
        bad(`bin ${main} does not start with #!/usr/bin/env node`);
    }
  }
  if (name === "@facetdb/studio") {
    const allowed = (f: string): boolean =>
      f.startsWith("dist/") || f === "package.json" || (hasLicense && f === "LICENSE");
    for (const file of files.filter((f) => !allowed(f))) {
      bad(`${file}: the studio ships only dist/ and its package.json`);
    }
    if (!files.includes("dist/index.html")) bad("no dist/index.html (the studio bundle)");
    if (Object.keys(manifest.dependencies ?? {}).length > 0) {
      bad("has dependencies; vite bundles them, so they are devDependencies");
    }
  }
}
for (const name of unpacked.keys()) {
  if (!dirs.some((d) => readManifest(join(root, d, "package.json")).name === name)) {
    problems.push(`${name}: packed, but not in the publishable list`);
  }
}

for (const line of lines) console.log(line);
for (const problem of problems) console.log(`FAILED: ${problem}`);
console.log(
  `pack-check: ${lines.length} tarballs in ${out}, ${problems.length === 0 ? "GREEN" : `RED (${problems.length} problems)`}`,
);
process.exit(problems.length === 0 ? 0 : 1);
