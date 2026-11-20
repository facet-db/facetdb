// The tokens of tokens.css by name, for the components (which reference a token, never a value) and
// for the tests (which hold tokens.css to this list in both themes). A role added to the design is
// added here and in tokens.css together.

// The color roles of the brief's two tables; `facet-text` is the light table's addition (on dark
// it equals `facet`).
export const colorRoles = [
  "canvas",
  "surface",
  "surface-2",
  "hairline",
  "text",
  "text-2",
  "text-3",
  "facet",
  "facet-ink",
  "facet-text",
  "yes",
  "no",
  "review",
  "pending",
  "skipped",
  "dither-ink",
] as const;
export type ColorRole = (typeof colorRoles)[number];

// The two faces (everything read, everything measured) and the measured face's two widths.
export const typeTokens = [
  "font-text",
  "font-measured",
  "font-measured-inline",
  "font-measured-wide",
] as const;

// The 4 px grid and the one radius there is (none).
export const shapeTokens = ["space", "radius"] as const;

// The brief's durations: 150 ms for state, 250 ms for layout, 600 ms for the column fill whose
// cells land 40 ms apart; all four read 0 under prefers-reduced-motion.
export const motionTokens = [
  "motion-state",
  "motion-layout",
  "motion-fill",
  "motion-fill-step",
] as const;

// The same durations as numbers, for motion a script drives (the dither's threshold swaps);
// tokens.test.ts keeps them equal to tokens.css. Reduced motion is the caller's check: these
// are the full-motion values.
export const motionMs = {
  "motion-state": 150,
  "motion-layout": 250,
  "motion-fill": 600,
  "motion-fill-step": 40,
} as const satisfies Record<(typeof motionTokens)[number], number>;

export const tokenNames = [...colorRoles, ...typeTokens, ...shapeTokens, ...motionTokens] as const;
export type TokenName = (typeof tokenNames)[number];

// The CSS reference a component writes in a style: `tokenVar("dither-ink")` is `var(--dither-ink)`.
export function tokenVar(name: TokenName): string {
  return `var(--${name})`;
}
