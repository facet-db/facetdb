import type { StateValue } from "../records/index.ts";

/** TypeSafe's 64k request limit is design-room; FacetDB warns above 8,000 state tokens. */
export const STATE_WARN_TOKENS = 8_000;

/** FacetDB refuses above 32,000 state tokens unless the source sets `maxStateTokens`. */
export const STATE_REFUSE_TOKENS = 32_000;

/** Estimate at 4 characters per token before the call; the exact count comes after it. */
export const CHARACTERS_PER_TOKEN = 4;

export type StateSizeCheck =
  | { readonly kind: "ok"; readonly estimate: number }
  | { readonly kind: "warn"; readonly estimate: number; readonly warnAbove: number }
  | { readonly kind: "refuse"; readonly estimate: number; readonly refuseAbove: number };

/**
 * The state as the model will read it, estimated in tokens: the JSON text of the state fields,
 * counted in characters (code points, so a multi-byte letter is one character), divided by 4 and
 * rounded up.
 */
export function estimateTokens(state: Readonly<Record<string, StateValue>>): number {
  const characters = Array.from(JSON.stringify(state)).length;
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

/**
 * Warns above 8,000 estimated tokens and refuses above 32,000, or above the source's own
 * `maxStateTokens` when it sets one. Both comparisons are strict: exactly the limit is allowed.
 */
export function checkStateSize(estimate: number, maxStateTokens?: number): StateSizeCheck {
  const refuseAbove = maxStateTokens ?? STATE_REFUSE_TOKENS;
  if (estimate > refuseAbove) {
    return { kind: "refuse", estimate, refuseAbove };
  }
  if (estimate > STATE_WARN_TOKENS) {
    return { kind: "warn", estimate, warnAbove: STATE_WARN_TOKENS };
  }
  return { kind: "ok", estimate };
}
