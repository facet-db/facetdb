#!/usr/bin/env bash
# test-databases.sh: the engines' test databases (infra/test-databases/compose.yml), one
# container per engine on a fixed loopback port, for their *.db.test.ts suites. It runs with
# rootless Podman or with Docker Compose (CI uses Docker Compose, before the database tests);
# every port binds to 127.0.0.1.
#
#   ./scripts/test-databases.sh up [engine…]   start every engine or the named ones, wait until each
#                                              is healthy, then print one `export <VARIABLE>=<url>`
#                                              line per running engine (progress goes to stderr)
#   ./scripts/test-databases.sh env            print those lines again
#   ./scripts/test-databases.sh status         each engine's health
#   ./scripts/test-databases.sh down           stop every engine and delete its container and data
#
#   out="$(./scripts/test-databases.sh up mysql)" && eval "$out"    MYSQL_URL in this shell (a bare
#   eval "$(…)" returns 0 even when up fails, so a command chained after it runs without the URL)
#
# Memory: the whole set needs about 6 GB (SQL Server alone 2 GB, Oracle Free about 2 GB), more than
# a laptop can spare beside other work: start fewer, by name (mysql mariadb mssql mongo libsql
# cockroach oracle). CI starts them all. DATABASE_URL stays your own Postgres, not one of these.
# Compose: `podman-compose` when it is on PATH, else `podman compose` when it works (Podman needs a
# provider: sudo apt-get install podman-compose), else `docker compose`;
# TEST_DATABASES_COMPOSE=podman|docker picks one (CI: docker). TEST_DATABASES_TIMEOUT bounds the
# wait for health (seconds, default 300).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
say() { echo "test-databases: $*" >&2; }
die() { say "$*"; exit 1; }


FILE="infra/test-databases/compose.yml"
PROJECT="facetdb-test-databases"
# Engine (the compose service; its container is facetdb-<engine>), URL variable, URL. The
# passwords are compose.yml's test-only ones. A URL stays shell-safe (no quote, space, ?, &, $ or
# ~): eval and $GITHUB_ENV read it unquoted.
TABLE="
mysql      MYSQL_URL      mysql://root:facetdb@127.0.0.1:3306/facetdb
mariadb    MARIADB_URL    mariadb://root:facetdb@127.0.0.1:3307/facetdb
mssql      MSSQL_URL      mssql://sa:Facetdb-test-1@127.0.0.1:1433/master
mongo      MONGODB_URL    mongodb://127.0.0.1:27017/facetdb
libsql     LIBSQL_URL     http://127.0.0.1:8080
cockroach  COCKROACH_URL  cockroachdb://root@127.0.0.1:26257/defaultdb
oracle     ORACLE_URL     oracle://system:facetdb@127.0.0.1:1521/FREEPDB1
"
mapfile -t ENGINES < <(awk 'NF { print $1 }' <<<"$TABLE")
field() { awk -v e="$1" -v n="$2" '$1 == e { print $n }' <<<"$TABLE"; } # field <engine> 2|3
ENGINE=""
T0=$SECONDS

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }

# pick_compose: Podman first, else `docker compose`, unless TEST_DATABASES_COMPOSE names one. For
# Podman, `podman-compose` on PATH is called directly, before `podman compose`, whose provider
# lookup prefers Docker's compose plugin when Docker is installed beside podman. `compose version`
# fails when Podman has no provider. Sets ENGINE (podman or docker: containers, logs, health) and
# COMPOSE (the compose command).
COMPOSE=()
pick_compose() {
  local want="${TEST_DATABASES_COMPOSE:-}" c
  case "$want" in podman | docker | "") ;; *) die "TEST_DATABASES_COMPOSE is podman or docker, not '$want'" ;; esac
  for c in ${want:-podman docker}; do
    command -v "$c" >/dev/null 2>&1 || continue
    if [[ "$c" == podman ]] && command -v podman-compose >/dev/null 2>&1 && podman-compose version >/dev/null 2>&1; then
      ENGINE=podman; COMPOSE=(podman-compose); return 0
    fi
    if "$c" compose version >/dev/null 2>&1; then ENGINE="$c"; COMPOSE=("$c" compose); return 0; fi
  done
  [[ -z "$want" ]] || die "'$want compose' does not work here ('$want compose version' fails)"
  die "neither podman compose nor docker compose works here; rootless Podman needs a compose provider: sudo apt-get install podman podman-compose"
}
# compose <args…>: the project's compose, its output on stderr (stdout carries only export lines).
compose() { PODMAN_COMPOSE_WARNING_LOGS=false "${COMPOSE[@]}" -p "$PROJECT" -f "$FILE" "$@" >&2; }

# inspect <engine> <template>: one field of the container, on one line; fails when there is none.
# Docker prints an empty line for a missing container before failing: the exit code decides, and
# the newlines go.
inspect() {
  local out
  out="$("$ENGINE" container inspect --format "$2" "facetdb-$1" 2>/dev/null)" || return 1
  out="${out//$'\n'/}"
  [[ -n "$out" ]] && echo "$out"
}
# state <engine>: running, exited, created… or absent.
state() { inspect "$1" '{{.State.Status}}' || echo absent; }
# health <engine>: healthy, starting, unhealthy, or the state of a container that is not running.
health() {
  local s; s="$(state "$1")"
  [[ "$s" == running ]] || { echo "$s"; return 0; }
  # Podman runs healthchecks from systemd timers, which a shell without a user manager lacks: run
  # the check here, so the answer never waits on them. Docker's daemon runs its own.
  if [[ "$ENGINE" == podman ]] && podman healthcheck run "facetdb-$1" >/dev/null 2>&1; then echo healthy; return 0; fi
  inspect "$1" '{{.State.Health.Status}}' || echo starting
}
logs_tail() { say "the last lines of facetdb-$1:"; "$ENGINE" logs --tail 20 "facetdb-$1" 2>&1 | sed 's/^/  /' >&2; }

# wait_healthy <engine…>: every one healthy, or exit 1 naming the others with their last log lines.
wait_healthy() {
  local timeout="${TEST_DATABASES_TIMEOUT:-300}" pending=("$@") next e h
  [[ "$timeout" =~ ^[0-9]+$ ]] || die "TEST_DATABASES_TIMEOUT is a number of seconds, not '$timeout'"
  local deadline=$((SECONDS + timeout))
  while :; do
    next=()
    for e in "${pending[@]}"; do
      h="$(health "$e")"
      case "$h" in
        healthy) say "$e healthy after $((SECONDS - T0))s" ;;
        starting | unhealthy) next+=("$e") ;;
        absent) die "$e was not created; ${COMPOSE[*]}'s output is above" ;;
        *) logs_tail "$e"; die "$e is $h, not running" ;;
      esac
    done
    ((${#next[@]})) || return 0
    pending=("${next[@]}")
    if ((SECONDS >= deadline)); then
      for e in "${pending[@]}"; do logs_tail "$e"; done
      die "not healthy after ${timeout}s: ${pending[*]} (./scripts/test-databases.sh status)"
    fi
    sleep 2
  done
}

print_env() {
  local e n=0
  for e in "${ENGINES[@]}"; do
    [[ "$(state "$e")" == running ]] || continue
    echo "export $(field "$e" 2)=$(field "$e" 3)"
    n=$((n + 1))
  done
  ((n)) || say "no engine is running: ./scripts/test-databases.sh up <engine>"
}

up() {
  (($#)) || set -- "${ENGINES[@]}"
  T0=$SECONDS
  say "starting $* with ${COMPOSE[*]} (a first start pulls the images)"
  compose up -d "$@" || die "${COMPOSE[*]} up failed; its output is above"
  say "created in $((SECONDS - T0))s; waiting until each engine is healthy"
  wait_healthy "$@"
  say "healthy in $((SECONDS - T0))s"
  print_env
}

status() {
  local e h
  for e in "${ENGINES[@]}"; do
    h="$(health "$e")"
    [[ "$h" != absent ]] || h="not started"
    printf '%-10s %-12s %s\n' "$e" "$h" "$(field "$e" 2)"
  done
}

# down: each engine's container goes with its anonymous volumes (`rm -v`: test data only, as
# facetdb-pg's `--rm`), then compose removes the rest of the project (its network; podman-compose's
# pod). `compose down` alone would leave those volumes behind under podman-compose.
down() {
  local e rc=0 now=()
  [[ "$ENGINE" != podman ]] || now=(-t 0) # podman's rm -f waits 10 s for a stop; the data goes anyway
  for e in "${ENGINES[@]}"; do
    [[ "$(state "$e")" != absent ]] || continue
    if "$ENGINE" rm -f -v "${now[@]}" "facetdb-$e" >/dev/null; then say "$e: container and data deleted"; else rc=1; fi
  done
  compose down || say "${COMPOSE[*]} down reported the lines above; the engines' containers are gone"
  return "$rc"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up) for e in "$@"; do [[ -n "$(field "$e" 2)" ]] || die "no engine '$e'; the engines: ${ENGINES[*]}"; done ;;
  env | status | down) (($# == 0)) || die "$cmd takes no engine name" ;;
  -h | --help | help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
pick_compose
case "$cmd" in
  up) up "$@" ;;
  env) print_env ;;
  status) status ;;
  down) down ;;
esac
