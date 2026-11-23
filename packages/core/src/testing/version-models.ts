import type { VersionModels } from "../contracts/index.ts";
import { type HeldModel, holdModel } from "../worker/index.ts";
import { FakeClock } from "./clock.ts";

/**
 * The store's held models in memory: per source and version, the first name asked wins and every
 * call is answered it. `calls` counts the store calls a test may want none of.
 */
export class FakeVersionModels implements VersionModels {
  readonly held = new Map<string, string>();
  calls = 0;

  answeredBy(sourceId: string, version: number, named: string): Promise<string> {
    this.calls += 1;
    const key = `${sourceId}@v${version}`;
    const name = this.held.get(key) ?? named;
    this.held.set(key, name);
    return Promise.resolve(name);
  }
}

/**
 * A held model over a store of its own, as a version nothing has answered: the first response
 * sets it. What a test passes when it is not about the model, as it passes an unlimited gate.
 */
export function freshHeldModel(version = 1): HeldModel {
  return holdModel(new FakeVersionModels(), "source", version, new FakeClock());
}
