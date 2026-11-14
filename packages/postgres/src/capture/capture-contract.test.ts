import { CONTRACT_QUESTIONS, runConnectorContract } from "@facetdb/core/testing";
import { describe } from "vitest";
import { useCaptureWorld, World } from "./capture-world.ts";

/**
 * The trigger-and-jobs connector against the connector contract suite, in both storage modes, on
 * PGlite. Its own cases are capture.test.ts (split by subject so no file passes 10 s).
 */

useCaptureWorld();

// The suite runs the connector with `onChange: "keep"`: one of its cases edits a record and then
// expects the stored decision, status included, untouched, which a `reset` trigger changes on the
// edit by design. Reset against keep has its own case below.
for (const storage of ["inline", "side-table"] as const) {
  describe(`postgres connector contract (${storage})`, () => {
    runConnectorContract(async () => {
      // The suite's questions, one of each type, so `current` reads every kind of answer column.
      const world = await new World(storage, "keep", { questions: CONTRACT_QUESTIONS }).create();
      return {
        connector: world.connector({ workerId: "w1" }),
        peer: world.connector({ workerId: "w2" }),
        fields: world.questionSet.read,
        edit: (key, state) => world.edit(key, state),
        decisionOf: (key) => world.decisionOf(key),
        clock: world.clock,
        close: () => world.close(),
      };
    });
  });
}
