#!/usr/bin/env bash
# build-package.sh: the `build` script of every publishable TypeScript package, run by pnpm in the
# package's directory: tsc emits src/ into dist/ through the package's tsconfig.build.json
# (JavaScript and declarations, no tests, no test helpers, no fixtures), then dts-extensions.ts
# points the declarations' relative imports at the .js files that ship. The workspace keeps running
# src/ (each package.json's exports); only publishConfig names dist/. `pnpm build` at the root runs
# it for every package in dependency order, so a package's references (its tsconfig.build.json) are
# built before it reads their declarations.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f tsconfig.build.json ]] || { echo "build-package.sh: no tsconfig.build.json in $PWD; run it from a publishable package" >&2; exit 2; }
# tsc trusts its build info over the disk: with dist/ deleted and the info kept, it emits nothing
# and says it is up to date. No dist/ means no build info either.
[[ -d dist ]] || rm -f tsconfig.build.tsbuildinfo
tsc -b tsconfig.build.json
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$here/lib/dts-extensions.ts" dist
