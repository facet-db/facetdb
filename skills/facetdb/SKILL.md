---
name: facetdb
license: MIT
description: >
  FacetDB integration craft: AI answers as database columns. Use when editing facetdb.config.ts or
  the project JSON, adding, rewording or removing a FacetDB question, choosing thresholds or stakes,
  running or explaining a FacetDB CLI command (init, preview, migrate, backfill, doctor, explain),
  reading a record's status (pending, done, needs_review, error, unchecked, skipped), sending
  records through facetdb.check, or writing a FacetDB plugin with facetdb/plugin. Not for writing
  the Jev questions' own wording and state design: that is the typesafe-ai skill.
---

# Build with FacetDB

FacetDB is open source software that turns a model's answers into columns of your own database.

- A worker asks TypeSafe's **Jev** a fixed set of questions about every record of a source.
- It applies thresholds to each answer and writes the decision back, next to the record.
- Answers it is unsure about become `needs_review` and go to a review screen, where a person decides.
- Every model answer and every human decision is kept in a decision log; a human decision is never
  overwritten by the model.
- The project is one config file, `facetdb.config.ts`, or the same project as JSON; the CLI sets it up and runs it.

This skill covers FacetDB itself. It does not teach how to write good Jev questions or design their
state: install the `typesafe-ai` skill for that and follow it when you write wording. TypeSafe asks
for one install method per project, and FacetDB asks the same: use one of the two methods below,
never both.

```bash
# Claude Code's plugin manager
claude plugin marketplace add facetdb/facetdb
claude plugin install facetdb@facetdb

# any coding agent
npx skills add facetdb/facetdb --skill facetdb
```

## Never invent a field

The config is validated with zod at the boundary, and the loader reports the field path and the fix
for anything it does not know. Do not guess a setting, an option or a command flag from memory or
from another tool. The schemas are in `facetdb/schema`: read them, and the exports of `facetdb` and
`facetdb/plugin`, before you write a field you have not seen in this skill. If a setting is not
there, it does not exist: say so and suggest the nearest one that does.

The model key, the store key and the API key are never in the config file. They come from the
environment: `TYPESAFE_API_KEY`, `FACETDB_SECRET`, `FACETDB_API_KEY`. A connection string is read
from the environment too: `database: env("DATABASE_URL")` names the variable, and the file never
holds the string (`process.env.DATABASE_URL` still loads, its variable then found by its value: a
guess where two variables hold one string). The worker logs in as `facetdb_worker`; a
connection pooler's suffixed user is fine (the Supabase session pooler wants
`facetdb_worker.<project ref>`), and `migrate` and `doctor` accept it. A pooler must be in session
mode (Supabase port 5432), never transaction mode (Supabase port 6543, PgBouncer
`pool_mode = transaction`): the worker prepares each statement once per connection, and `doctor`
fails its `pooler` check when the connection cannot keep one.

## The config file

```ts
// facetdb.config.ts: one project, any number of sources, one question set per source
import { env, facetdb, noul, choice, score } from "facetdb";
import { slack } from "@facetdb/slack";

export default facetdb({
  model: "jev-1.14.0",                        // project default; pinned, never an alias
  alerts: { channels: ["slack:#ops", "email:ops@example.com"] },
  sources: [
    {
      name: "support_messages",
      database: env("DATABASE_URL"),          // the variable's name, never its value
      table: "support_messages",
      where: "channel <> 'internal'",         // optional filter on state fields; the rest are skipped
      read: ["subject", "body", "channel"],   // the state: only what the questions need
      storage: "inline",                      // or "side-table"
      onChange: "reset",                      // or "keep": leave the old decision until the new one lands
      onOutage: "hold",                       // or "release": mark records unchecked instead of waiting
      questions: {
        urgency: score("How urgent is this message?", ["low", "medium", "high"]),
        team: choice("Which team should handle it?", {
          billing:  "Charges, payments, invoices",
          shipping: "Delivery times, tracking, countries",
          returns:  "Damaged items, exchanges, refunds",
        }),
        wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
      },
      thresholds: { urgency: { confidenceAtLeast: 0.6 } },   // wants_refund keeps the high-stakes defaults
      actions: [slack.notify({ channel: "#support-urgent", when: { urgency: "high" } })],
    },
    {
      name: "support_tickets",                // an API source: your code sends records
      api: true,
      read: ["subject", "body"],
      questions: { urgency: score("How urgent is this ticket?", ["low", "medium", "high"]) },
    },
  ],
});
```

Rules of the shape:

- A project is one file with a `sources` list. A table is exactly one source, and a source has one
  question set. A source is either a database table (`database` + `table`) or an API source (`api: true`).
- `read` lists the state fields, the only columns the model sees. Keep it to what the questions need.
  FacetDB's own columns are never state fields.
- A question is `noul(text, options?)` (a yes or no with a probability), `choice(text, options)` (pick
  one of the named options) or `score(text, levels)` (a level on a scale, lowest first). The key under
  `questions` is the question's name and the name of its answer column.
- `model` is an exact version. The loader refuses an alias and names the pinned form: write `jev-1.14.0`.
  A source may set its own `model`.
- Optional project settings: `spendingCap` with `onCapReached` (`"pause"` or `"continue"`), `modelUrl`
  for a compatible server, and per source `maxStateTokens`.
- Of the built-in `provider` presets, the FacetDB team has run only `strands-decider`;
  `facetdb doctor` says so for the others. A Strands Decider server ignores the request's `model`,
  so `model` pins nothing there: when you change the checkpoint it serves, change `model` too
  (such as `strandsdecider-1.2610.0` for `strands-decider-2B-qwen3.5-v1-2610`), so a new
  question-set version starts and its thresholds are checked again for the new model.
- A table watched by polling (CockroachDB, Oracle, or `connector: "polling"`) is read by the column the
  application sets on every insert and every update: name it with `lastChanged: "changed_on"` (a time,
  NOT NULL), or write `lastChanged: false` to read the whole table every hour on purpose, without a
  warning. Left out, FacetDB looks for an `updated_at`, `modified_at` or the like and warns when it
  finds none. `facetdb migrate` refuses a name the table lacks or that is not a time, before it runs
  anything.
- An action is a call into a plugin (`slack.notify(...)`). `when` conditions compare decisions
  (`{ urgency: "high" }`). Actions run after a decision is written, never before.

### Example request

"Add a question that flags refund requests and routes them to billing." Add one `noul` question
to the source that reads the right fields, keep `read` covering the columns the text needs, make the
stakes `high` when a wrong automatic answer routes or hides something, and route with an action, not
with a question that asks the model what to do:

```ts
questions: {
  // ...the existing questions
  wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
},
actions: [
  slack.notify({ channel: "#billing", when: { wants_refund: true } }),
],
```

Then run `facetdb preview` on the changed source (see "Before changing a question"), and
`facetdb backfill --question wants_refund` for the rows that already exist: adding a question
starts a backfill for that question alone, with the cost shown first.

## Commands

Every command accepts `--dry-run` (print exactly what would happen) and `--json`. Exit codes: 0
success, 1 a problem in the user's setup (the message says the fix and links the page), 2 a bad
invocation.

| Command | What it does |
| --- | --- |
| `facetdb init` | Creates the config file, asks for the database connection and what that engine needs (the store URL for a non-Postgres source, a MongoDB replica set, SQL Server's contained user, Oracle's service and schema), asks whether the host forbids triggers (`--triggers allowed|forbidden` in a script), recommends side-table mode when it finds Prisma or Drizzle, and prints the skill install commands; `facetdb init --example listings --engine <engine>` copies a ready example (config, seed, steps) for any of the nine engines; `facetdb init --example github-triage` copies the spec's GitHub issue triage (the config and its five steps in `facetdb-github-triage.md`, never over a repository's README) and names the two plugins to add, `facetdb add github` and `facetdb add slack` |
| `facetdb doctor` | Checks the connection, permissions, trigger, worker and model key, and says what is wrong (`--offline` skips the model) |
| `facetdb preview` | Answers the most recent rows in the terminal and changes nothing in the database |
| `facetdb test` | Runs the draft in facetdb.config.ts, as it stands on disk, on the newest records (`--sample`, 1,000 at most) and on every record a person decided, against the version the store keeps in force: prints the cost first and asks (`--yes`), then per question how many answers would change, how many move between unsure and decided, and how agreement with reviewers moves (no number when nobody decided that question). It changes nothing; the next steps are to commit the file and restart the worker, and `facetdb backfill` to re-answer existing records (`--sample`, `--source`, `--yes`, `--json`) |
| `facetdb migrate` | Installs every source: answer columns, jobs table, change capture. Prints the SQL first (`--yes`, `--source`, `--prune`) |
| `facetdb backfill` | Answers every existing row, paced and resumable, after showing the cost estimate (`--dry-run`, `--pace`, `--question`, `--yes`) |
| `facetdb explain` | Prints one record's full history in words: every answer and every human decision (`facetdb explain <source> <key>`) |
| `facetdb export` | Writes a source's whole decision log, oldest first, as JSONL or CSV (`facetdb export --source <name>`, `--format`, `--out`); it reads the FacetDB store only |
| `facetdb uninstall` | Shows the SQL that removes FacetDB from a source and asks you to type the project name before it runs (`--purge` also deletes the log) |
| `facetdb worker` | Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API, the studio's endpoints and, once `pnpm build` has built it, the studio itself on 127.0.0.1 port 4040 (`--host`, `--port`, `--no-http`, `--once`, `--studio-dir <path>` for another build; a `--host` that is not this machine needs a reviewer account first, `facetdb users add <name>`); refuses to start without `TYPESAFE_API_KEY` or a `modelUrl`. Each worker keeps its own heartbeat row and watches the other workers of its project: one that stops beating for 2 minutes is raised once as Worker not running by a worker that is still up, so a lone worker's death shows on Home only, and an alert for it needs a second worker (or FacetDB Cloud) |
| `facetdb studio` | Opens the studio, the local dashboard with the review screen, in the browser: runs the worker as `facetdb worker` does, serves the studio beside the check API on 127.0.0.1 port 4040, prints the address and opens it (`--host`, `--port`, `--no-open`, `--studio-dir <path>`); on this machine nobody signs in. With no build it stops and says to run `pnpm build`; it never starts a dev server |
| `facetdb add` | Installs a plugin from the registry: `facetdb add <name>` (`github`, `@facetdb/github` or `facetdb-plugin-github`) refuses a core version the plugin does not support, shows the install command (`pnpm add`, `yarn add`, `bun add` or `npm install`, by the `packageManager` of a package.json or the lockfile found from the project's directory up to the nearest `.git`), runs it and prints the config lines to paste; `--dry-run` shows the command and installs nothing. With no name it lists the registry (`--search <term>`, `--json`). The index is read from `--registry <url or file>`, else `FACETDB_REGISTRY` (an https address, or the path of a file), else `https://registry.facetdb.dev/index.json`, which is not hosted yet: until it is, pass `--registry <file or address>` or set `FACETDB_REGISTRY`, for example to the repository's `registry/index.json` |
| `facetdb dev` | Runs the worker offline on an embedded Postgres under `.facetdb/dev/` with the fake model, no key needed (`--model-url` for Ollama or another compatible server, `--reset` starts empty) |
| `facetdb types` | Writes facetdb.types.d.ts with each source's answer columns and the choice and score unions, typed as the source's database returns them (1 or 0 for a yes-or-no answer on MySQL, MariaDB, SQLite, libSQL and Oracle; the fields of the facetdb subdocument on MongoDB), and prints that database's Prisma and Drizzle snippets (`--prisma`, `--drizzle`, `--out <file>.d.ts`, `--dry-run`); where the database has no Drizzle (SQL Server, Oracle, MongoDB) or no Prisma (Oracle), one comment line says so |
| `facetdb users` | Manages the reviewer accounts the studio asks for on any address but this machine's: `facetdb users add <name>` (asks the password twice with the echo off, or `--password-stdin`; only a scrypt hash is stored), `facetdb users list` (`--json`), `facetdb users remove <name>` (asks for the name back; removing the last account leaves the studio loopback-only). It writes with the login in `DATABASE_URL`, which must be the store's owner login, not the worker's |
| `facetdb review` | Reviews the records that need a person in the terminal, one card at a time, from the same queue, lock (10 minutes, renewed while the card is open), log and actions as the studio: `y` and `n` for a yes-or-no question, a number for a choice or score option, `s` skip, `u` undo your last decision, `q` quit, `:` a note for the next decision; it needs a terminal and writes nothing before a decision. It judges cards by the question set the worker last recorded, and stops when `facetdb.config.ts` differs from it. If the model, the fields read or a question's wording, options or levels differ, restart `facetdb worker` with the file or review in the studio. If only thresholds, the where filter, stakes or the order of the questions differ, the store cannot tell whether the worker already runs the file (it keeps those values as they were when the version was made), so review in the studio, which judges by what the worker runs; do not tell the user to restart or to edit the file back. Flags: `--source`, `--question`, `--below <p>` (only cards where the model's figure for an open question is under p, 0.6 meaning 60%), `--limit <n>`, `--user <name>` (decide as that `facetdb users` account after its password is asked; by default as `os:<your user name>`), and `--json` to print the queue for another tool (no terminal needed). `--from <file>` applies decisions made elsewhere instead of walking cards: a JSONL file of `{"source","key","question","value","note"}` rows or the lines `facetdb export --format jsonl` wrote (export, edit a `needs review` answer into a decision, apply; an export names no source, so `--source` when the config has several), as the same reviewer (the password of `--user` is asked, or read from the first piped line without a terminal). It prints the plan and every refusal by line number first, then asks (`--yes`); `--dry-run` locks and writes nothing; `--json` prints the outcomes as one document. A line refused or not applied ends the run with exit 1 and `ok: false` (every outcome is printed first). An edited export row is compared with what the log says it should read, and is applied or refused with its reason, never left. A row of an export whose record changed since is refused, a question a person already decided is never overwritten (the same decision again is reported as already decided), and a minimal row has no state hash to compare, so it is applied to the record as its card shows it when opened |

`facetdb add` with no name lists the registry (name, verified mark, downloads, description; `--search <term>` narrows it, `--json`
prints it as data). With a name it installs: it refuses a plugin whose core range this facetdb
does not satisfy, prints the package manager's command line, runs it, loads the plugin and prints
the lines to paste into `facetdb.config.ts`. It writes no file; add them by hand. The default
index is not hosted yet, so for now pass `--registry <file or address>` (or set
`FACETDB_REGISTRY`) with the repository's `registry/index.json`.

Always show before doing: run `--dry-run` or read the printed SQL and estimate before anything
writes. Never pass `--yes` for the user on a database you have not been told is safe to change.

## Thresholds and stakes

Each question declares `stakes`: `low` (the default) or `high`. Use `high` when a wrong automatic
answer removes, hides, rejects or charges. The defaults follow from it:

| Type | Settings, low stakes | Settings, high stakes | Automatic decision | Otherwise |
| --- | --- | --- | --- | --- |
| noul | `yesAbove` 0.70, `noBelow` 0.30 | 0.90 and 0.10 | yes at or above `yesAbove`; no at or below `noBelow` | needs review |
| choice | `confidenceAtLeast` 0.50 | 0.75 | the top option at or above the threshold | needs review |
| score | `confidenceAtLeast` 0.50 | 0.75 | the most likely level at or above the threshold | needs review |

- `noBelow` is always lower than `yesAbove`. Compare exactly at the boundary; never round.
- Override per question with `thresholds` on the question, or under the source's `thresholds` by
  question name. A question you do not override keeps its stakes defaults.
- A threshold change never calls the model. FacetDB re-applies the new thresholds to the latest
  logged answer of every record, so a record in review can become decided and the reverse.
- Say probabilities in plain words to users ("Scam? 58% likely yes", "Yes or no", "Pick one"), never
  as `noul=0.58`.

## Record statuses

Each record has one status in `facetdb_status`. There are six, and no seventh.

| Status | Meaning | What the app should do |
| --- | --- | --- |
| `pending` | Queued, not yet answered; also while a spending cap pauses the project | Treat as unknown |
| `done` | Every question has a decision, automatic or human | Use the answer columns |
| `needs_review` | At least one question fell between the thresholds | Hold the record; the review screen resolves it |
| `error` | The model call failed after retries; FacetDB retries and alerts | Treat as pending |
| `unchecked` | `onOutage: "release"` and the model stayed unreachable past the retry window | Whatever the source's policy says; expect it to change |
| `skipped` | Every state field was blank, or the source's `where` excluded the record | Nothing to do |

A failed model call is an error, never an answer. A question's value column is NULL until it has a
decision. A question-set version is held to the model its first answer named: a response naming
another model writes nothing, raises Model changed and holds the source (one record asked every 5
minutes, the others waiting in the queue unasked) until that model answers again or a new `model`
in the config starts a new version; `facetdb doctor` says when the server answers under a name
other than the config's.

## State hash and when FacetDB asks again

The worker writes a decision only if the record's state hash still matches what it sent to the
model; if the record changed meanwhile, the answer is discarded and the record is queued again.
Human decisions are never overwritten.

| Event | Model called? |
| --- | --- |
| New record | Yes |
| A state field (a column in `read`) changed | Yes |
| FacetDB writes its own columns, or a column outside `read` changes | No |
| Thresholds changed | No: re-applied to the stored answers |
| Wording, criteria, state fields or model version changed | Only if the user chooses to re-answer existing records |
| A question added | Yes, for that question only (a backfill, cost shown first) |
| A question removed | No: its columns stay until `facetdb migrate --prune` |

Changing the wording of a question is a new question-set version. Say that to the user before
you do it, because it changes what the existing decisions mean.

## Before changing a question

Run `facetdb preview` before you save a change to a question's wording, options or state fields:
it answers the most recent rows without writing anything, so the user sees the effect on real data.
Run `facetdb doctor` when something does not work, before guessing at a cause. Then run
`facetdb test`: it runs the draft in facetdb.config.ts against the newest records and every record
a person decided, shows the cost first, and prints per question what would change and how agreement
with reviewers moves. It writes nothing; to use the draft, commit the file and restart the worker.

## The check API

An API source receives records from code instead of reading a table:

```ts
const result = await facetdb.check("support_tickets", {
  id: "T-1042",
  record: { subject: "Charged twice", body: "I was charged twice for my order, please fix this today" },
});
// result.answers.urgency -> { value: "high", confidence: 0.91 }
// result.status          -> "done" or "needs_review"
```

The `id` is the record's key. The same id with an unchanged record returns the stored answer with no
model call; a changed record asks again. When the model is unreachable the call returns 503 with a
`retry-after` header, the record is queued, and the answer arrives by webhook. Webhooks carry an
HMAC signature header (`facetdb-signature`), so verify it before you trust the body.

## Webhooks: getting each decision pushed

`webhook({ url })` in a source's `actions` is the way to get a push. It is built into `facetdb`, so
there is nothing to add: every decision of the source, the worker's and a reviewer's alike, is sent
to `url` as a signed POST, retried with backoff for 24 hours.

```ts
import { env, facetdb, webhook } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET") } },   // the variable's name, never its value
  sources: [{ name: "support_tickets", api: true, /* … */ actions: [webhook({ url: "https://app.example.com/facetdb" })] }],
});
```

- The signing secret is always `env("NAME")`; the worker refuses to start when the variable is not
  set. `url` is https (http only for a receiver on this machine), with no password and no `#`.
- The body is `{ event: "record.decided", delivery, source, id, status, decidedAt, answers }`. In the
  receiver, read the raw body and check it with `verifyWebhook(secret, headers, body)` from `facetdb`.
- Deliveries can arrive out of order, and a retry can repeat one: key them by `delivery`, and per
  `id` keep the one with the latest `decidedAt` (the signed time of the decision, not of the send).
  A threshold change re-decides a record from the same answer, so two decisions can share a
  `decidedAt`: between those, keep the larger `delivery`, compared as a whole number (it is the
  outbox's sequence number, taken when the delivery is queued).
- The worker does not queue a decision again while it is the record's latest delivery, however
  often it writes it again; two processes at the same instant can still queue it twice, so the
  rule above, not a count of deliveries, is what a receiver relies on.
- `url` and `endpoints` are written in the file as addresses, never `env(…)`. A worker sends a
  queued delivery only to an endpoint its config still names, and `facetdb review` queues none to an
  address that is not https (or http on this machine) or that holds a password or a `#`.
- For alerts, name endpoints under the plugin and address them as channels:
  `plugins: { webhook: { secret: env(…), endpoints: { ops: "https://…" } } }` with
  `alerts: { channels: ["webhook:ops"] }`; an alert's body is `{ event: "alert", delivery, severity,
  text, link }`, signed the same way.

## Plugins

Five extension points: **source** (a place records come from), **action** (what happens after a
decision), **alert channel** (where system alerts go), **model provider** (a compatible server) and
**question pack** (a ready-made set of questions). A plugin is a package that default-exports
`definePlugin` from `facetdb/plugin`:

```ts
import { definePlugin, action, z } from "facetdb/plugin";

export default definePlugin({
  name: "slack",                  // @facetdb/slack or facetdb-plugin-slack
  version: "1.0.0",
  facetdb: "^1.0.0",              // the range of FacetDB core versions it supports
  config: z.object({ token: z.secret() }),   // one schema: the file and the dashboard form
  actions: {
    notify: action({
      config: z.object({ channel: z.string() }),
      async run(ctx, record, decisions, settings) { /* call the service */ },
    }),
  },
});
```

A plugin never writes a decision. The worker, thresholds, review screen and log belong to core.
Secrets are declared in the schema and read from the environment by the host, never from the config
file. A setting the studio may change through Apply is marked `z.editable(...)` in the schema; mark
only one that moves neither a credential nor a record's data (never an address, host, port, login,
endpoint or secret: `definePlugin` refuses the mark on a secret). Every other setting is changed in
facetdb.config.ts by hand. Look up the exact helpers in `facetdb/plugin` before you use one.

To use someone else's plugin, run `facetdb add <name>`: it installs the package and prints the
`plugins` entry to paste, each secret as `env("NAME")`. A plugin runs inside the worker with the
worker's access, so install only plugins you trust. After an upgrade of facetdb, `facetdb doctor`
has a `plugins` check that fails, naming the plugin, its range and this version, when a plugin no
longer supports it.

## Checklist before you finish

1. The config names only fields you found in the schemas or in this skill; `model` is a pinned version.
2. No secret is in the file; `read` lists only what the questions need.
3. Stakes are `high` wherever an automatic wrong answer is costly.
4. Routing is an action keyed on decisions, not a question asking what to do.
5. You ran `facetdb preview` on the changed source, and `facetdb migrate --dry-run` when you added a
   source or question, and told the user what the SQL and the cost estimate say.
