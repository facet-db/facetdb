// The dither module's door: the meters, and the quantisation a caller may need to agree with
// what a meter draws.
export type { DitherContext } from "./bayer.ts";
export { clampProbability, ditherLevel, ditherSteps } from "./bayer.ts";
export type {
  DitherContextFactory,
  DitherGradientProps,
  DitherProps,
  DitherStripProps,
} from "./Dither.tsx";
export { Dither, DitherGradient, DitherStrip } from "./Dither.tsx";
export { rampValue } from "./gradient.ts";
