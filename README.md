# FacetDB

AI answers as database columns. You write "Is this listing a scam?" once; every row of your table
gets a stored answer with a probability from TypeSafe's Jev decision model. Sure answers are final,
unsure ones go to a person on a review screen, and that person's decision is written back too.
Open source, for every major database; FacetDB Cloud runs it for you.

## Quick start

```bash
corepack enable --install-directory ~/.local/bin   # once; pnpm 11 comes from package.json
pnpm install --frozen-lockfile                    # dependencies, exactly as locked
pnpm test                                         # the unit tests: an embedded Postgres and a fake model
pnpm run                                          # the whole command surface
```

Node 24 LTS (`.node-version`; 22.18+ works), pnpm 11, TypeScript everywhere. Development runs on an
embedded Postgres (PGlite) and a scripted fake model, so nothing has to be installed; a real
Postgres (`DATABASE_URL`) runs the `*.db.test.ts` suites, and the real TypeSafe API is only ever
called by hand with `TYPESAFE_API_KEY`.

## Connecting a database

A source's connection string picks its engine by its scheme; `facetdb init` names the engine it
read and asks what that engine needs, and `facetdb init --example listings --engine <name>` copies
the listings example for any engine below. The string is the worker login's (the one credential
FacetDB keeps, read from the environment, never from the config); the admin's is given to
`facetdb migrate` per run and never stored. Every engine but Postgres keeps its decision log, usage
and alerts in a Postgres of yours, the store, named by `DATABASE_URL`.

`facetdb init` takes every answer as a flag too, so a script or a coding agent runs it without a
terminal: `--database-url`, `--store-url`, `--table`, `--skills plugin|npx|none`, and
`--triggers allowed|forbidden` for whether the host lets FacetDB add a trigger (forbidden: Postgres
is polled, SQL Server read through Change Tracking). With no terminal, init reads each answer
from standard input, one line per question in the order a terminal asks
(`printf 'postgres://…\nlistings\nyes\n' | facetdb init`); when the input runs out at the
triggers question it takes them as allowed and says so, and at any other question it stops and
names the flag to pass.

| Database | Connection string | How FacetDB notices a change |
|---|---|---|
| Postgres | `postgres://facetdb_worker:<password>@<host>:5432/<database>?sslmode=require` | a trigger and LISTEN/NOTIFY; `connector: "polling"` where triggers are forbidden |
| MySQL 8, MariaDB 10.5 | `mysql://facetdb_worker:<password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}` (or `mariadb://`) | triggers, the jobs table polled every second |
| SQL Server 2016, Azure SQL | `mssql://facetdb_worker:<password>@<host>:1433/<database>` (or `sqlserver://`) | a trigger, or Change Tracking with `capture: "change-tracking"` |
| SQLite | `sqlite:///absolute/path/app.db`, `file:./app.db`, or a path ending in `.db`, `.sqlite`, `.sqlite3` | triggers, one worker per file |
| libSQL (Turso, sqld) | `libsql://<database>-<organization>.turso.io` or `https://<host>` with `turso.io` or `libsql` in it, the token in `<variable>_AUTH_TOKEN`; a sqld on this machine `libsql://127.0.0.1:8080?tls=0` | triggers, one worker per database |
| MongoDB 4.4, Atlas | `mongodb://facetdb_worker:<password>@<host>:27017/<database>?replicaSet=rs0`, or `mongodb+srv://…/<database>?authSource=admin` | a change stream (a replica set is needed) |
| CockroachDB | `cockroachdb://facetdb_worker:<password>@<host>:26257/<database>?sslmode=verify-full` | polling every 10 seconds by a last-changed column |
| Oracle | `oracle://facetdb_worker:<password>@<host>:2484/<service>?protocol=tcps` | polling every 10 seconds by a last-changed column |

## Layout

| Path | Package | What |
|---|---|---|
| `packages/core` | `@facetdb/core` | question sets, thresholds, decisions, statuses, the worker loop, the contracts every adapter implements |
| `packages/model` | `@facetdb/model` | the TypeSafe client, backoff, compatible providers, the fake provider |
| `packages/postgres` | `@facetdb/postgres` | the Postgres connector, the polling connector, the FacetDB store |
| `packages/mysql` | `@facetdb/mysql` | the MySQL and MariaDB connector over `mysql2` |
| `packages/mssql` | `@facetdb/mssql` | the SQL Server and Azure SQL connector over `tedious` |
| `packages/sqlite` | `@facetdb/sqlite` | the SQLite connector: files over Node's `node:sqlite`, libSQL servers over `@libsql/client` |
| `packages/mongodb` | `@facetdb/mongodb` | the MongoDB connector, by change streams over `mongodb` |
| `packages/sql-polling` | `@facetdb/sql-polling` | the polling connector for any SQL database behind a dialect: CockroachDB over `postgres`, Oracle over `oracledb` in thin mode |
| `packages/server` | `@facetdb/server` | the check API, webhooks, review endpoints |
| `packages/facetdb` | `facetdb` | the config DSL, the CLI, the SDK, `facetdb/plugin` |
| `plugins/*` | `@facetdb/<name>` | first-party plugins |
| `apps/studio` | | the dashboard |

## License

Apache 2.0. See [LICENSE](LICENSE).
