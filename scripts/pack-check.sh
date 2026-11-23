#!/usr/bin/env bash
# pack-check.sh [<empty folder>]: what a published tarball holds. Runs a clean `pnpm build`, packs
# every publishable package with `pnpm pack` (publishConfig applied, workspace: ranges replaced, the
# root LICENSE copied in when one exists) into a new folder under $TMPDIR, or into the empty folder
# given, lists each tarball, and fails (scripts/lib/pack-check.ts) on a path under src/, any file
# outside dist/, package.json and LICENSE that git does not track for the package (a .facetdb/ data
# directory left by `facetdb dev` under an example, a database file), a .facetdb/ or node_modules/
# path, a TypeScript source (the facetdb package's examples/ excepted: init copies them), a test, a
# testing/, *-world.*, e2e/ or fixtures/ file, a source map, build info, an .env or key file, a
# .d.ts or .js naming a relative .ts, a committed example file the tarball leaves out, an exports or
# bin target missing from the tarball, a ./testing subpath, a workspace: range, a facetdb tarball
# without examples/ or its bin, a studio tarball holding anything but dist/ and its package.json,
# and, while a root LICENSE exists, a tarball without it. The tarballs stay in the folder for an
# install test; the unpacked copies and each tarball's file list are under its unpacked/.
set -euo pipefail
shopt -s nullglob
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The publishable packages, and the workspace packages that never ship. A package added to the
# workspace must be named in one list or the other, so none is left out of the check.
PUBLISHABLE=(
  packages/facetdb packages/core packages/model packages/postgres packages/sql-polling
  packages/mysql packages/mssql packages/sqlite packages/mongodb packages/server
  apps/studio
  plugins/email plugins/github plugins/packs plugins/slack plugins/telegram
)
PRIVATE=(packages/ui)

unnamed=0
for d in packages/*/ plugins/*/ apps/*/; do
  d="${d%/}"
  [[ -f "$d/package.json" ]] || continue
  [[ " ${PUBLISHABLE[*]} ${PRIVATE[*]} " == *" $d "* ]] && continue
  echo "pack-check: $d is in neither list of scripts/pack-check.sh; name it publishable or private there"
  unnamed=1
done
[[ $unnamed -eq 0 ]] || exit 1

out="${1:-}"
if [[ -z "$out" ]]; then
  out="$(mktemp -d "${TMPDIR:-/tmp}/facetdb-pack.XXXXXX")"
else
  mkdir -p "$out"
  [[ -z "$(ls -A "$out")" ]] || { echo "pack-check: $out is not empty; give it a new or empty folder" >&2; exit 2; }
  out="$(cd "$out" && pwd)"
fi
log="$out/unpacked/pack.log"
mkdir -p "$out/unpacked"

# A clean build: tsc never deletes the output of a source that was renamed or removed, and a
# stale file in dist/ would ship.
for d in "${PUBLISHABLE[@]}"; do rm -rf "${d:?}/dist" "${d:?}/tsconfig.build.tsbuildinfo"; done
if ! pnpm build >"$log" 2>&1; then
  echo "pack-check: pnpm build failed (the whole log: $log)"; tail -n 20 "$log" | sed 's/^/  /'; exit 1
fi
for d in "${PUBLISHABLE[@]}"; do
  if ! (cd "$d" && pnpm pack --pack-destination "$out") >>"$log" 2>&1; then
    echo "pack-check: pnpm pack failed in $d (the whole log: $log)"; tail -n 20 "$log" | sed 's/^/  /'; exit 1
  fi
done
tarballs=("$out"/*.tgz)
if [[ ${#tarballs[@]} -ne ${#PUBLISHABLE[@]} ]]; then
  echo "pack-check: ${#tarballs[@]} tarballs in $out for ${#PUBLISHABLE[@]} publishable packages (the whole log: $log)"; exit 1
fi
for t in "${tarballs[@]}"; do
  b="$(basename "$t" .tgz)"
  mkdir "$out/unpacked/$b"
  tar -xzf "$t" -C "$out/unpacked/$b" || { echo "pack-check: $t does not unpack"; exit 1; }
  listing="$(tar -tzf "$t")" || { echo "pack-check: $t cannot be listed"; exit 1; }
  sed 's#^package/##' <<<"$listing" | sort >"$out/unpacked/$b.files"
done

exec node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  "$ROOT/scripts/lib/pack-check.ts" "$ROOT" "$out" "${PUBLISHABLE[@]}"
