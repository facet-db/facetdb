import { type ModelChange, modelChangedWords } from "../alerts/index.ts";
import type { Clock, ProbeClaim, VersionHold, VersionModels } from "../contracts/index.ts";

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
   * it. A change holds the source, in the store too; an answer naming the held model releases it,
   * in the store too. The worker and the backfill both check through this, after the call's spend
   * is counted.
   */
  check(named: string): Promise<ModelChangedError | undefined>;
  /** The change that holds the source, while the last response checked named another model. */
  readonly holding: ModelChangedError | undefined;
  /** While the source is held, when its next probe may be asked (ms, on the clock); else undefined. */
  readonly probeAt: number | undefined;
  /**
   * Whether the held source's probe may be asked now, by the probe time this loop last learned from
   * the store; false while it is not held. Spends nothing and asks the store nothing.
   */
  probeDue(): boolean;
  /**
   * Whether a model request may be sent now, asked as it is about to be sent: always while the
   * source is not held; while it is, once per `MODEL_CHANGED_PROBE_EVERY_MS` among every worker of
   * the store, and that yes spends the probe (the store's claim), so a probe that ends with no
   * request (a record needing no call) spends nothing. A source another worker released is asked.
   */
  mayAsk(): Promise<boolean>;
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
    mayAsk: () => Promise.resolve(held.holding === undefined),
  };
}

/**
 * The held model of `version` of one source, its hold read from the store once, as the loop opens
 * and before its first claim: a source another worker holds starts held, so this loop claims
 * nothing and sends no request until a probe is claimed. The name the version is held to is read
 * from the store at the first answer that asks (or with the hold) and kept: every later answer is
 * compared with no store call. Concurrent first answers share one store call; one that fails is
 * tried again by the next answer.
 *
 * The hold is the store's: a changed answer writes it, an answer naming the held model clears it,
 * and the probe is claimed there, so of every worker of the store one probe goes per 5 minutes. A
 * loop learns another worker's hold at its open, or from its own next changed answer; it learns
 * another's release at its next probe claim, which the store answers `released`.
 */
export async function holdModel(
  store: VersionModels,
  sourceId: string,
  version: number,
  clock: Pick<Clock, "now">,
): Promise<HeldModel> {
  return heldModelFrom(store, sourceId, version, clock, await store.readHold(sourceId, version));
}

/**
 * The held model of `version` as `holdModel` makes it, from a hold already read (null: not held).
 * For a caller that knows the version's hold without a store call, as a test's fresh store.
 */
export function heldModelFrom(
  store: VersionModels,
  sourceId: string,
  version: number,
  clock: Pick<Clock, "now">,
  hold: VersionHold | null,
): HeldModel {
  let held: Promise<string> | undefined = hold === null ? undefined : Promise.resolve(hold.held);
  let holding: ModelChangedError | undefined =
    hold === null
      ? undefined
      : new ModelChangedError({ version, held: hold.held, named: hold.named });
  let probeAt = hold === null ? 0 : hold.probeAt;
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
        if (holding !== undefined) {
          // Released in the store first: a release that fails leaves this loop held, to probe again.
          await store.clearHold(sourceId, version);
          holding = undefined;
        }
        return undefined;
      }
      // Held here before the store answers, so this loop asks nothing more meanwhile; the store's
      // probe time wins, so every worker of the fleet keeps one.
      const change = new ModelChangedError({ version, held: name, named });
      holding = change;
      probeAt = clock.now() + MODEL_CHANGED_PROBE_EVERY_MS;
      probeAt = await store.setHold(sourceId, version, named, probeAt);
      return change;
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
    async mayAsk() {
      if (holding === undefined) {
        return true;
      }
      const now = clock.now();
      if (now < probeAt) {
        return false;
      }
      // Spent here before the store answers, so the lanes that came this far together wait.
      const before = probeAt;
      probeAt = now + MODEL_CHANGED_PROBE_EVERY_MS;
      let claim: ProbeClaim;
      try {
        claim = await store.claimProbe(sourceId, version, now, probeAt);
      } catch (error) {
        // Nothing was claimed: the next record that needs a call claims again.
        probeAt = before;
        throw error;
      }
      switch (claim.kind) {
        case "claimed":
          return true;
        case "released":
          holding = undefined;
          return true;
        case "taken":
          // Another worker's probe: the store's next one, or 5 minutes from now when the claim that
          // took it committed while this statement read the time it replaced.
          probeAt = claim.probeAt > now ? claim.probeAt : now + MODEL_CHANGED_PROBE_EVERY_MS;
          return false;
      }
    },
  };
}
