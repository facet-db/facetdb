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

## Layout

| Path | Package | What |
|---|---|---|
| `packages/core` | `@facetdb/core` | question sets, thresholds, decisions, statuses, the worker loop, the contracts every adapter implements |
| `packages/model` | `@facetdb/model` | the TypeSafe client, backoff, compatible providers, the fake provider |
| `packages/postgres` | `@facetdb/postgres` | the Postgres connector, the polling connector, the FacetDB store |
| `packages/server` | `@facetdb/server` | the check API, webhooks, review endpoints |
| `packages/facetdb` | `facetdb` | the config DSL, the CLI, the SDK, `facetdb/plugin` |
| `plugins/*` | `@facetdb/<name>` | first-party plugins |
| `apps/studio` | | the dashboard |

## License

Apache 2.0. See [LICENSE](LICENSE).
