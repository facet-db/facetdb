# GitHub triage

The worked example: every new issue and pull request of one repository is labelled
`Not Priority`, `Impacts only OSS`, both, or neither. Two yes-or-no questions are asked in one
request per issue; "no label" is the outcome when both answers are no. When the model is unsure,
the issue gets `needs-triage`, a card waits on the review screen and a message goes to `#triage`;
once a person decides the card, the label it decides is set and `needs-triage` leaves.

`facetdb init --example github-triage` writes `facetdb.config.ts` and this file,
`facetdb-github-triage.md` (a name no repository's own files take, so init never stands in for
your README). Five steps run it on your repository:

1. **Add the two plugins the config imports.** `facetdb add github` and `facetdb add slack` (the
   packages `@facetdb/github` and `@facetdb/slack`; `npm install` them by name works too).

2. **Name your repository.** Replace `your-org/your-repo` in the source and in each of the three
   `github.label` actions with your `owner/name`. Every GitHub action names its repository for
   now, the source's own: an action cannot yet see the source it runs on when the config loads.

3. **Set the variables where the worker runs.** The config names each one and holds no value:
   - `GITHUB_TOKEN`: a fine-grained token on the repository with Issues and Pull requests set to
     read and write (a classic token needs the `repo` scope, `public_repo` for a public one).
   - `GITHUB_WEBHOOK_SECRET`: a long random string; GitHub signs each delivery with it.
   - `SLACK_WEBHOOK_TRIAGE`: the incoming-webhook URL of your `#triage` channel
     (`https://hooks.slack.com/services/...`).
   - `TYPESAFE_API_KEY` for the model, `DATABASE_URL` for the store (a Postgres of yours, where
     the answers live since GitHub cannot hold columns; a free Supabase or Neon project is
     enough), and `FACETDB_SECRET`.

   The plugin talks to `https://api.github.com`. On GitHub Enterprise Server, add its REST API to
   the plugin's settings: `plugins: { github: { ..., apiUrl: "https://<host>/api/v3" } }`.

4. **Start the worker where GitHub can reach it, and add the webhook.** An address other than
   this machine's needs a reviewer account first, `facetdb users add <your name>`; then
   `facetdb worker --host 0.0.0.0` (behind HTTPS) creates the store's tables on its first start,
   and `facetdb doctor` checks the setup. In the repository's Settings, Webhooks, add one with
   the payload URL `https://<your worker>/v1/hooks/github/issues`, the content type
   `application/json`, the secret of `GITHUB_WEBHOOK_SECRET`, and the events Issues and Pull
   requests.

5. **Open an issue.** Its labels appear within seconds. `facetdb backfill` labels every open issue
   once, with its cost shown first. An issue the model is unsure about gets `needs-triage` and a
   message in `#triage`; decide it on the studio's Review page and its label follows. GitHub does
   not send a failed delivery again, so the source also asks GitHub what changed every 5 minutes.

The labels FacetDB sets are not part of an issue's state: setting them never asks the model again.
