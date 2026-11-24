import type { ProbeClaim, VersionHold, VersionModels } from "../contracts/index.ts";
import { type HeldModel, heldModelFrom } from "../worker/index.ts";
import { FakeClock } from "./clock.ts";

/**
 * The store's held models in memory: per source and version, the first name asked wins and every
 * call is answered it. Its holds are kept per version as the Postgres store keeps them: set with
 * the probe time kept while held, cleared, and claimed by the first caller whose `now` reached the
 * probe time. Each call runs whole before the next, as one statement does. `calls` counts the
 * `answeredBy` calls a test may want none of; `holdCalls` names every hold call in order.
 */
export class FakeVersionModels implements VersionModels {
  readonly held = new Map<string, string>();
  readonly holds = new Map<string, { named: string; probeAt: number }>();
  readonly holdCalls: string[] = [];
  calls = 0;

  answeredBy(sourceId: string, version: number, named: string): Promise<string> {
    this.calls += 1;
    const key = keyOf(sourceId, version);
    const name = this.held.get(key) ?? named;
    this.held.set(key, name);
    return Promise.resolve(name);
  }

  readHold(sourceId: string, version: number): Promise<VersionHold | null> {
    this.holdCalls.push("read");
    const key = keyOf(sourceId, version);
    const hold = this.holds.get(key);
    const held = this.held.get(key);
    return Promise.resolve(
      hold === undefined || held === undefined
        ? null
        : { held, named: hold.named, probeAt: hold.probeAt },
    );
  }

  setHold(sourceId: string, version: number, named: string, probeAt: number): Promise<number> {
    this.holdCalls.push("set");
    const key = keyOf(sourceId, version);
    const kept = this.holds.get(key)?.probeAt ?? probeAt;
    this.holds.set(key, { named, probeAt: kept });
    return Promise.resolve(kept);
  }

  clearHold(sourceId: string, version: number): Promise<void> {
    this.holdCalls.push("clear");
    this.holds.delete(keyOf(sourceId, version));
    return Promise.resolve();
  }

  claimProbe(sourceId: string, version: number, now: number, next: number): Promise<ProbeClaim> {
    this.holdCalls.push("claim");
    const key = keyOf(sourceId, version);
    const hold = this.holds.get(key);
    if (hold === undefined) {
      return Promise.resolve({ kind: "released" });
    }
    if (hold.probeAt > now) {
      return Promise.resolve({ kind: "taken", probeAt: hold.probeAt });
    }
    this.holds.set(key, { named: hold.named, probeAt: next });
    return Promise.resolve({ kind: "claimed" });
  }
}

function keyOf(sourceId: string, version: number): string {
  return `${sourceId}@v${version}`;
}

/**
 * A held model over a store of its own, as a version nothing has answered: the first response
 * sets it. What a test passes when it is not about the model, as it passes an unlimited gate.
 */
export function freshHeldModel(version = 1): HeldModel {
  return heldModelFrom(new FakeVersionModels(), "source", version, new FakeClock(), null);
}
