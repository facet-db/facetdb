import { type ModelChange, modelChangedWords } from "../alerts/index.ts";
import type { Clock, VersionModels } from "../contracts/index.ts";

/**
 * Whether FacetDB checks the model a response names: while a response names another model, the
 * source is held and one of its records is asked again this often.
 */
export const MODEL_CHANGED_PROBE_EVERY_MS = 5 * 60_000;

/**
 * A response named another model than the one its question-set version is held to: a failed call,
 * never an answer. Its message is Model changed's own words, so a failed backfill says it as the
 * alert.
 */
export class ModelChangedError extends Error implements ModelChange {
  readonly version: number;
  readonly held: string;
  readonly named: string;

  constructor(change: ModelChange) {
    const { what, did } = modelChangedWords(change);
    super(`${what} ${did}`);
    this.name = "ModelChangedError";
    this.version = change.version;
    this.held = change.held;
    this.named = change.named;
  }
}

/**
 * One source's question-set version, the model it is held to, and whether the source is held, as a
 * loop knows it. The loop's worker, its check calls and its backfill jobs share one.
 */
export type HeldModel = {
  /**
   * Compares the model a response named with the one the version is held to: undefined when they
   * agree, the change when they do not. The first answer under a version nothing has answered sets
   * it. A change holds the source; an answer naming the held model releases it. The worker and the
   * backfill both check through this, after the call's spend is counted.
   */
  check(named: string): Promise<ModelChangedError | undefined>;
  /** The change that holds the source, while the last response checked named another model. */
  readonly holding: ModelChangedError | undefined;
  /** While the source is held, when its next probe may be asked (ms, on the clock); else undefined. */
  readonly probeAt: number | undefined;
  /** Whether the held source's probe may be asked now; false while it is not held. Spends nothing. */
  probeDue(): boolean;
  /**
   * Whether a model request may be sent now, asked as it is about to be sent: always while the
   * source is not held; while it is, once per `MODEL_CHANGED_PROBE_EVERY_MS`, and that yes spends
   * the probe, so a probe that ends with no request (a record needing no call) spends nothing.
   */
  mayAsk(): boolean;
};

/**
 * The loop's held model as a check call sees it (`POST /v1/check`): the same version, name and
 * hold, but never the source's probe, which is the loop's alone.
 */
export function withoutProbe(held: HeldModel): HeldModel {
  return {
    check: (named) => held.check(named),
    get holding() {
      return held.holding;
    },
    get probeAt() {
      return held.probeAt;
    },
    probeDue: () => false,
    mayAsk: () => held.holding === undefined,
  };
}

/**
 * The held model of `version` of one source, read from the store at the first answer that asks
 * and kept: every later answer is compared with no store call. Concurrent first answers share one
 * store call; one that fails is tried again by the next answer. The source's hold is this process's
 * own: a restart asks again, and holds the source at its first changed answer.
 */
export function holdModel(
  store: VersionModels,
  sourceId: string,
  version: number,
  clock: Pick<Clock, "now">,
): HeldModel {
  let held: Promise<string> | undefined;
  let holding: ModelChangedError | undefined;
  let probeAt = 0;
  return {
    async check(named) {
      const asked =
        held ??
        store.answeredBy(sourceId, version, named).catch((error: unknown) => {
          held = undefined;
          throw error;
        });
      held = asked;
      const name = await asked;
      if (name === named) {
        holding = undefined;
        return undefined;
      }
      holding = new ModelChangedError({ version, held: name, named });
      probeAt = clock.now() + MODEL_CHANGED_PROBE_EVERY_MS;
      return holding;
    },
    get holding() {
      return holding;
    },
    get probeAt() {
      return holding === undefined ? undefined : probeAt;
    },
    probeDue() {
      return holding !== undefined && clock.now() >= probeAt;
    },
    mayAsk() {
      if (holding === undefined) {
        return true;
      }
      if (clock.now() < probeAt) {
        return false;
      }
      probeAt = clock.now() + MODEL_CHANGED_PROBE_EVERY_MS;
      return true;
    },
  };
}
