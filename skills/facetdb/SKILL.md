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
from the environment too (`process.env.DATABASE_URL`).

## The config file

```ts
// facetdb.config.ts: one project, any number of sources, one question set per source
import { facetdb, noul, choice, score } from "facetdb";
import { slack } from "@facetdb/slack";

export default facetdb({
  model: "jev-1.14.0",                        // project default; pinned, never an alias
  alerts: { channels: ["slack:#ops", "email:ops@example.com"] },
  sources: [
    {
      name: "support_messages",
      database: process.env.DATABASE_URL,     // any supported database
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
| `facetdb init` | Creates the config file, asks for the database connection, recommends side-table mode when it finds Prisma or Drizzle, and prints the skill install commands |
| `facetdb doctor` | Checks the connection, permissions, trigger, worker and model key, and says what is wrong (`--offline` skips the model) |
| `facetdb preview` | Answers the most recent rows in the terminal and changes nothing in the database |
| `facetdb migrate` | Installs every source: answer columns, jobs table, change capture. Prints the SQL first (`--yes`, `--source`, `--prune`) |
| `facetdb backfill` | Answers every existing row, paced and resumable, after showing the cost estimate (`--dry-run`, `--pace`, `--question`, `--yes`) |
| `facetdb explain` | Prints one record's full history in words: every answer and every human decision (`facetdb explain <source> <key>`) |
| `facetdb uninstall` | Shows the SQL that removes FacetDB from a source and asks you to type the project name before it runs (`--purge` also deletes the log) |
| `facetdb worker` | Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API on port 7411 (`--port`, `--no-http`, `--once`); refuses to start without `TYPESAFE_API_KEY` or a `modelUrl` |
| `facetdb dev` | Runs the worker offline on an embedded Postgres under `.facetdb/dev/` with the fake model, no key needed (`--model-url` for Ollama or another compatible server, `--reset` starts empty) |

Other commands are not in this build yet; do not tell the user to run them as if
they were: `facetdb review`, `facetdb studio`, `facetdb add <plugin>`, `facetdb types`, and
`facetdb test`.

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
decision.

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
Run `facetdb doctor` when something does not work, before guessing at a cause. Once `facetdb test`
ships, run it too: it runs the current questions against a sample and every reviewed
row and prints what would change. Until then, preview is the check.

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
file. Look up the exact helpers in `facetdb/plugin` before you use one.

## Checklist before you finish

1. The config names only fields you found in the schemas or in this skill; `model` is a pinned version.
2. No secret is in the file; `read` lists only what the questions need.
3. Stakes are `high` wherever an automatic wrong answer is costly.
4. Routing is an action keyed on decisions, not a question asking what to do.
5. You ran `facetdb preview` on the changed source, and `facetdb migrate --dry-run` when you added a
   source or question, and told the user what the SQL and the cost estimate say.
