import { ditherLevel } from "./bayer.ts";

// The threshold slider's track: a dither gradient from empty at the left edge to full at the right,
// so a cut line at p stands on a p-dense texture. The value of a column, as the mockups ramp it:
// column / (columns - 1).
export function rampValue(column: number, columns: number): number {
  return columns === 1 ? 1 : column / (columns - 1);
}

// The level each column of the track is drawn at, for paintDither.
export function rampLevelAt(columns: number): (column: number) => number {
  return (column) => ditherLevel(rampValue(column, columns));
}
