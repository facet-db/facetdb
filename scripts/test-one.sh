#!/usr/bin/env bash
# test-one.sh <pattern>: run the unit tests whose file path matches <pattern> in every workspace
# package that has a test script. Exit 1 when any matched test fails or when no test file matched
# anywhere. Replaces `pnpm -r run test -- <pattern>`: pnpm drops what follows `--`, so that form
# ran every suite unfiltered and could not fail for a pattern that matches nothing.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
pat="${1:-}"; [[ -n "$pat" ]] || { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
ran=0; failed=0
while IFS= read -r pkg; do
  [[ -n "$pkg" ]] || continue
  out="$(pnpm --filter "$pkg" --fail-if-no-match run test "$pat" 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then ran=1; echo "ok: $pkg ($pat)"
  elif grep -q 'No test files found' <<<"$out"; then :
  else failed=1; echo "FAILED: $pkg"; echo "$out" | tail -n 30 | sed 's/^/  /'; fi
done < <(pnpm -r ls --depth -1 --json 2>/dev/null | node -e '
  const fs=require("fs"); const root=process.cwd(); let pk=[]; try{pk=JSON.parse(fs.readFileSync(0,"utf8")||"[]")}catch{}
  for (const p of pk) { if (p.path===root) continue; try { if (JSON.parse(fs.readFileSync(p.path+"/package.json","utf8")).scripts?.test) console.log(p.name); } catch {} }')
[[ $failed -eq 0 ]] || exit 1
[[ $ran -eq 1 ]] || { echo "test-one: no test file matched '$pat' in any package"; exit 1; }
exit 0
