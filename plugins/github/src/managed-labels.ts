import { type SourceAction, z } from "facetdb/plugin";
import { labelName } from "./actions.ts";

/**
 * The labels an issues source's own label actions manage. The worked example reads `labels` as
 * state and writes labels as actions: were FacetDB's own labels read back, every label it adds or
 * removes would change the state, queue the issue and cost a second request for the same answer. So
 * a label this source's actions manage is not state: `read` and `scan` leave it out of `labels`
 * (issues-state.ts), and the webhook names no key for its `labeled` and `unlabeled` events
 * (issues-webhook.ts). Every other label, and every other event, whoever sent it, moves the state
 * as before: a person's `bug` label asks again, and so does a maintainer's edit even when the token
 * is the maintainer's own.
 *
 * Managed: every name in `add` and `remove` of each `label` action of this plugin configured on the
 * source (the SDK hands the source those actions as the file writes them, `ctx.source.actions`),
 * its own settings and its `else` alike. Each name is read as the label action's schema reads it
 * (`labelName`, actions.ts: trimmed); one the schema refuses is never sent to GitHub by the action,
 * so it manages nothing.
 *
 * Case: GitHub holds one label per name whatever its case, and the label action adds and removes by
 * name in any case (actions.ts, `changes`), so the label `Not Priority` adds may sit on an issue as
 * `not priority` when the repository spells it so. A name is therefore matched in any case (the
 * same `toLowerCase` the action compares with), and in no other way: GitHub's name is neither
 * trimmed nor normalised.
 *
 * Not knowable here: a name written as a variable (`add: [env("LABEL")]`), since the SDK hands a
 * source the variable's name and never its value; such a label stays in the state.
 */

/** The label names a source manages, and the test of one of GitHub's names against them. */
export type ManagedLabels = {
  /** As the actions write them (trimmed), each once in any case, in the file's order. */
  readonly names: readonly string[];
  /** Whether a label's name, as GitHub gives it, is one of `names` in any case. */
  readonly has: (name: string) => boolean;
};

/** A label action's settings, or its `else`, as the file writes them: only the two lists are read. */
const lists = z.object({
  add: z.array(z.unknown()).optional(),
  remove: z.array(z.unknown()).optional(),
});

/** A label's name as GitHub matches it: in any case. */
function folded(name: string): string {
  return name.toLowerCase();
}

/** The labels `actions` (the source's own, `ctx.source.actions`) manage. */
export function managedLabels(actions: readonly SourceAction[]): ManagedLabels {
  const names = new Map<string, string>();
  for (const use of actions) {
    if (use.action !== "label") {
      continue;
    }
    // `else` is laid over the action's own settings when its condition does not hold: what either
    // branch adds or removes is the action's.
    for (const settings of [use.config, use.config["else"]]) {
      const parsed = lists.safeParse(settings);
      if (!parsed.success) {
        continue;
      }
      for (const entry of [...(parsed.data.add ?? []), ...(parsed.data.remove ?? [])]) {
        const name = labelName.safeParse(entry);
        if (name.success && !names.has(folded(name.data))) {
          names.set(folded(name.data), name.data);
        }
      }
    }
  }
  return { names: [...names.values()], has: (name) => names.has(folded(name)) };
}
