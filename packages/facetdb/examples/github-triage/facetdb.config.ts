// The GitHub triage example (facetdb init --example github-triage; the worked example): every new
// issue and pull request of one repository gets Not Priority, Impacts only OSS, both or neither;
// one the model is unsure about gets needs-triage, a card on the review screen and a message in
// #triage, and the label leaves once a person decides it. facetdb-github-triage.md has the five
// steps to run it on your repository. Every secret is a variable's name, read where the worker
// runs. On GitHub Enterprise Server, add apiUrl: "https://<host>/api/v3" to plugins.github.
import { github } from "@facetdb/github";
import { slack } from "@facetdb/slack";
import { env, facetdb, noul } from "facetdb";

export default facetdb({
  source: github.issues({ repo: "your-org/your-repo", include: ["issues", "pull_requests"] }),
  read: ["title", "body", "labels", "changed_files"],
  model: "jev-1.14.0",
  plugins: {
    github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") },
    slack: { webhooks: { "#triage": env("SLACK_WEBHOOK_TRIAGE") } },
  },
  questions: {
    not_priority: noul(
      "Would the maintainers treat this as low priority? Low priority means cosmetic issues, " +
        "feature requests with no concrete use case, questions the docs answer, and unsupported setups.",
    ),
    impacts_only_oss: noul(
      "Does this affect only the self-hosted open-source version and not the hosted platform? " +
        "Hosted-only parts: billing, team management, cloud sync.",
    ),
  },
  thresholds: {
    not_priority: { yesAbove: 0.8, noBelow: 0.2 },
    impacts_only_oss: { yesAbove: 0.8, noBelow: 0.2 },
  },
  // Each GitHub action names the repository too, the source's own, until an action can see the
  // source it runs on when the config loads.
  actions: [
    github.label({
      repo: "your-org/your-repo",
      when: { not_priority: true },
      add: ["Not Priority"],
      else: { remove: ["Not Priority"] },
    }),
    github.label({
      repo: "your-org/your-repo",
      when: { impacts_only_oss: true },
      add: ["Impacts only OSS"],
      else: { remove: ["Impacts only OSS"] },
    }),
    github.label({
      repo: "your-org/your-repo",
      when: { status: "needs_review" },
      add: ["needs-triage"],
      else: { remove: ["needs-triage"] },
    }),
    slack.notify({ when: { status: "needs_review" }, channel: "#triage" }),
  ],
});
