#!/usr/bin/env bash
# require-env.sh VAR...: exit 1 with an "environment, not code" message when a variable is unset.
set -u
rc=0
for v in "$@"; do
  if [[ -z "${!v:-}" ]]; then echo "environment, not code: $v is unset" >&2; rc=1; fi
done
exit $rc
