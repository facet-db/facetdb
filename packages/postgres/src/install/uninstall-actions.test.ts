import { describe, expect, it } from "vitest";
import {
  count,
  freshWorld,
  install,
  project,
  q,
  runUninstall,
  useUninstallWorld,
} from "../testing/index.ts";

/**
 * What `uninstall` says of a project's pending plugin actions on PGlite: an outbox row with no
 * endpoint is named by its plugin and action, and one closed untried (superseded, or closed by its
 * runner: `gave_up_at` and `superseded_at` set) is not pending. Its own file, beside
 * uninstall-kept.test.ts, so neither passes 10 s.
 */

useUninstallWorld();

describe("uninstall and the outbox's plugin actions", () => {
  it("names a pending action by its plugin and action, and counts no action closed untried", async () => {
    await freshWorld();
    await install();
    await q(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ($1, 'https://hooks.example.com/f', '{}', 1, 1)`,
      [project.id],
    );
    // Two pending actions of one kind, one of another, one superseded and one delivered.
    for (const [action, closed, delivered] of [
      ["label", null, null],
      ["label", null, null],
      ["comment", null, null],
      ["comment", 2, null],
      ["label", null, 2],
    ] as const) {
      await q(
        `insert into facetdb.webhook_outbox (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, superseded_at, gave_up_at, delivered_at)
         values ($1, '{}', 1, 1, 'src', '1', 'github', $2, 0, $3, $3, $4)`,
        [project.id, action, closed, delivered],
      );
    }
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      pendingDeliveries: 4,
      pendingActions: [
        { plugin: "github", action: "comment", count: 1 },
        { plugin: "github", action: "label", count: 2 },
      ],
      projectKeptBy: ["pending-deliveries"],
      sharedTablesDropped: false,
    });
    expect(result.ok && result.notes).toContain(
      `4 deliveries of project ${project.id} still pending: 1 webhook and 3 plugin actions (comment of github, label of github (2)); the project and the webhook outbox stay until each is delivered or given up (retried for 24 hours).`,
    );
    expect(await count(`select 1 from facetdb.webhook_outbox`)).toBe(6);
  });

  it("drops the outbox with the project once every action is delivered or closed untried", async () => {
    await freshWorld();
    await install();
    await q(
      `insert into facetdb.webhook_outbox (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, superseded_at, gave_up_at, delivered_at)
       values ($1, '{}', 1, 1, 'src', '1', 'github', 'label', 0, 2, 2, null),
              ($1, '{}', 1, 1, 'src', '1', 'github', 'label', 0, null, null, 3)`,
      [project.id],
    );
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true, notes: [] });
    expect(result.ok && result.plan).toMatchObject({
      pendingDeliveries: 0,
      pendingActions: [],
      sharedTablesDropped: true,
    });
    expect((await q(`select to_regclass('facetdb.webhook_outbox') is null as gone`))[0]).toEqual({
      gone: true,
    });
  });
});
