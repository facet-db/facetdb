// dts-extensions.ts <dist>: the last step of scripts/build-package.sh. tsc rewrites the relative
// `./x.ts` imports of the sources to `./x.js` in the JavaScript it emits
// (`rewriteRelativeImportExtensions`), but leaves them as `.ts` in the declarations, and a `.d.ts`
// in a published package must name the files that ship. This rewrites every relative specifier
// ending in `.ts` in an import, export or `import()` of each `.d.ts` under <dist> to `.js`; package
// specifiers (`@facetdb/core`) are left alone. Idempotent; prints nothing on success.
//   node --disable-warning=ExperimentalWarning scripts/lib/dts-extensions.ts packages/core/dist
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , dist] = process.argv;
if (dist === undefined) {
  console.error("usage: dts-extensions.ts <dist>");
  process.exit(2);
}

/** `from "./x.ts"`, `import "./x.ts"` and `import("../x.ts")`, single or double quotes. */
const RELATIVE_TS = /\b(from|import)(\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]*)\.ts\3/g;

for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
  const file = join(entry.parentPath, entry.name);
  const text = readFileSync(file, "utf8");
  const rewritten = text.replace(RELATIVE_TS, "$1$2$3$4.js$3");
  if (rewritten !== text) writeFileSync(file, rewritten);
}
