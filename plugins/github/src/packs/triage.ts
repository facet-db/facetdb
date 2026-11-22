import { choice, noul } from "facetdb";
import { pack } from "facetdb/plugin";

/**
 * The GitHub issue triage pack: three questions on an issue or a pull request, over the four fields
 * the `issues` source returns (issues-state.ts): `title`, `body`, `labels` (the label names,
 * sorted, one a line) and `changed_files` (empty for an issue; for a pull request the number of
 * files it changes, then the first 100 paths). A project copies them as ordinary questions ("Start
 * from a pack"), so nothing here is referenced after that.
 *
 * The wording is written for a System One model (the `typesafe-ai` skill): one judgment per
 * question with its criteria in the wording, each criterion a concrete situation the model can see
 * in the record, the borderline left to fall between yes and no, no counting, no dates, at most one
 * negation per sentence. The criteria name kinds of situations, never an issue of the committed
 * sample.
 * - `kind` is a choice, its option names the kinds themselves; a pull request takes the kind of
 *   the change it makes, so the same five options sort both. No two options share a phrase.
 * - `missing_reproduction` is a noul whose no side covers every item that reports no bug, a pull
 *   request included: an answer for each record, so a feature request is never sent to review on
 *   a question that does not concern it (one undecided question puts the whole record in
 *   review).
 * - `not_priority` keeps its documented name, so the worked example's label actions apply to it as
 *   written, and its criteria made observable: cosmetic issues, feature requests with no concrete
 *   use case, unsupported setups, a basic question of the kind a getting-started guide covers (the
 *   model never sees a project's documentation, so "a question the docs answer" is asked as what it
 *   looks like), and posts that ask nothing of the project's software, such as spam or thanks.
 *
 * Stakes: each answer feeds a label, which a maintainer removes in a click, or a comment, which a
 * maintainer can edit or delete though its notification has already been sent. Neither removes,
 * hides, rejects or charges, and the plugin's actions never close, lock or delete an issue, so
 * every question is low stakes. `kind` and `missing_reproduction` keep the low-stakes defaults
 * (confidence 0.50; 0.70 and 0.30). `not_priority` keeps the worked example's 0.80 and 0.20: a
 * wrong yes buries a real bug under a "Not Priority" label, so it takes a clearer answer than the
 * defaults ask for.
 *
 * The pack was run on `jev-1.14.0` against its sample and reworded where the answers showed the
 * model reading wrongly: a pull request's kind is the change it makes, a label is a hint, naming
 * what causes a bug is a reproduction, and documentation that misleads and the maintainers' release
 * planning are not low priority.
 */
export const triage = pack({
  description:
    "GitHub issue triage for any repository: three questions about an issue or a pull request. They read the four fields the GitHub source returns: `title`, `body`, `labels` and `changed_files`, which is empty for an issue and lists a pull request's changed files. The kind question sorts the item as a bug report, a feature request, a usage question, a documentation problem or something else. A pull request takes the kind of the change it makes. The missing_reproduction question asks whether a bug report leaves out the steps, command, code or input needed to see the bug. It answers no for anything that reports no bug, pull requests included. The not_priority question asks whether the maintainers would treat the item as low priority. Low priority means cosmetic issues, feature requests with no concrete use case, basic questions a getting-started guide covers, unsupported setups, and posts that ask nothing of the project, such as spam or thanks. All three are low stakes, and nothing irreversible hangs on any answer. A label can be removed, and a comment edited or deleted, though its notification has already been sent. The GitHub plugin's actions never close, lock or delete an issue. The kind question decides its top option at confidence 0.50 or above. The missing_reproduction question decides yes at 0.70 or above and no at 0.30 or below. The not_priority question decides yes at 0.80 or above and no at 0.20 or below, as in FacetDB's GitHub triage example, so a real bug is marked not priority only on a clear answer. Everything between goes to review. After applying the pack, edit the not_priority criteria to match how your maintainers rank work, and add your own rules as questions, such as which parts of your product an issue touches.",
  questions: {
    kind: choice(
      "What kind of issue do `title` and `body` describe? A pull request, which lists the files it changes in `changed_files`, takes the kind of the change it makes. A label in `labels` is a hint that can be wrong.",
      {
        bug_report:
          "A bug report: someone says the software fails or gives a wrong result, such as a crash, an error message, wrong output, lost data, a failed install or something that broke in an upgrade.",
        feature_request:
          "A feature request: a wish for new behaviour, or for a change to behaviour that works as designed, including support for a platform, a format or an integration the project has never had.",
        usage_question:
          "A usage question: someone asks how to install, configure or use the software for their own case, and makes no claim that it is broken.",
        documentation_problem:
          "A documentation problem: the README, the guides, the reference or the examples leave something out, state something wrong, read unclearly or are out of date, and the fix belongs in that text rather than in the code.",
        something_else:
          "Something else about the project: upkeep such as a dependency update, a build or test pipeline change or a refactor that keeps behaviour the same; a question about releases; a discussion of the roadmap or of how the project is run; thanks or an announcement; or text that asks for nothing, such as spam or a test post.",
      },
      { stakes: "low" },
    ),
    missing_reproduction: noul(
      "Does the issue in `title` and `body` report a bug while leaving out what a maintainer needs to make the bug happen on their own machine?",
      {
        stakes: "low",
        criteria: {
          true: "The issue says something is broken but gives only the symptom: it leaves out the steps, the command, the code or the input that cause it, so a maintainer would have to ask the reporter how to see it happen.",
          false:
            "The issue gives the steps, the command, the code or the input that cause the bug, with the error output or the version where it helps; naming the setting or the action that causes the bug is enough. The item can also report a wish, a question, a documentation problem or project upkeep instead of a bug, or be a pull request, which lists the files it changes in `changed_files`.",
        },
      },
    ),
    not_priority: noul(
      "Would the maintainers treat the issue or pull request in `title` and `body` as low priority?",
      {
        stakes: "low",
        criteria: {
          true: "It is cosmetic: something looks or reads slightly off while it still works, such as a typo, a spacing or a colour; it asks for a feature, a format or a platform with no concrete use case behind it; it asks a basic question of the kind a getting-started guide covers, such as how to install the software, what it needs to run or how to change a common setting; it happens only on a setup the project does not support, such as an end-of-life runtime or a modified build; or it asks nothing of the project's software or documentation, such as a test post, spam, thanks or a question about release plans.",
          false:
            "It reports a fault on a supported setup that crashes, loses or corrupts data, gives wrong results, breaks a feature or blocks people from their work; it reports a security weakness; it reports or fixes documentation that would lead people to a wrong result or leaves out what they need to use a feature; it plans or tracks the maintainers' work for a coming release; it asks for a feature and names the concrete use case it serves; or a label in `labels` already marks it as urgent, a regression or a security issue.",
        },
        thresholds: { yesAbove: 0.8, noBelow: 0.2 },
      },
    ),
  },
});
