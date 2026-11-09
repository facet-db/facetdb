#!/usr/bin/env bash
# changelog.sh: prepend the commits since the last tag to CHANGELOG.md under an "Unreleased"
# heading. Local and reversible (git checkout CHANGELOG.md undoes it).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
last=$(git describe --tags --abbrev=0 2>/dev/null || true)
range=${last:+$last..HEAD}
entries=$(git log --no-merges --format='- %s (%h)' ${range:-} 2>/dev/null)
[[ -n "$entries" ]] || { echo "changelog: nothing since ${last:-the first commit}"; exit 0; }
tmp=$(mktemp)
{ echo "# Changelog"; echo; echo "## Unreleased ($(date -u +%Y-%m-%d))"; echo; echo "$entries"; echo;
  [[ -f CHANGELOG.md ]] && sed '1{/^# Changelog$/d}' CHANGELOG.md | sed '/./,$!d'; } > "$tmp"
mv "$tmp" CHANGELOG.md
echo "changelog: $(echo "$entries" | wc -l | tr -d ' ') entries added"
