// Probability as dither: ordered dither whose ink density is the value, drawn on a 4x4 Bayer matrix
// and quantised to its steps, so 0.58 is 9 of every 16 cells. Brief section 9's trap: a pattern
// drawn at device pixel ratio 1 blurs on a phone, so the grid is laid out in CSS pixels and each
// cell painted as a whole number of device pixels.

// The cell the mockups draw: 2 CSS px.
export const ditherCellCssPx = 2;

// The matrix's 16 thresholds; a value's level runs from 0 (no cell lit) to 16 (every cell).
export const ditherSteps = 16;

// The Bayer 4x4 threshold of a cell, computed rather than looked up (an index into a literal
// matrix is `number | undefined` under noUncheckedIndexedAccess). The matrix it produces, row by
// row, is the mockups' own:  0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5.
export function bayerThreshold(x: number, y: number): number {
  const d = (x ^ y) & 3;
  const r = y & 3;
  return ((d & 1) << 3) | ((r & 1) << 2) | (d & 2) | ((r & 2) >> 1);
}

// A probability outside 0 to 1 draws as the nearest end: the meter shows, it does not validate.
export function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// The value quantised to the matrix's steps: 0.58 is level 9.
export function ditherLevel(value: number): number {
  return Math.round(clampProbability(value) * ditherSteps);
}

export function isLit(x: number, y: number, level: number): boolean {
  return bayerThreshold(x, y) < level;
}

// The grid a box of CSS pixels holds at a device pixel ratio. The cell count depends on the CSS
// size alone; the ratio sets how many device pixels paint one cell: 2 at ratio 1, 4 at ratio 2,
// 3 at ratio 1.5. Rounded to a whole pixel so every edge falls on the device grid.
export type DitherGrid = { columns: number; rows: number; cellDevicePx: number };

export function ditherGrid(widthCssPx: number, heightCssPx: number, ratio: number): DitherGrid {
  return {
    columns: Math.max(1, Math.round(widthCssPx / ditherCellCssPx)),
    rows: Math.max(1, Math.round(heightCssPx / ditherCellCssPx)),
    cellDevicePx: Math.max(1, Math.round(ditherCellCssPx * ratio)),
  };
}

// The part of a canvas 2D context the dither uses; tests pass a handwritten fake.
export type DitherContext = Pick<CanvasRenderingContext2D, "clearRect" | "fillRect" | "fillStyle">;

// Paints the grid: each lit cell one square of whole device pixels in `ink`, a color the browser
// has already computed (the components read the canvas's own `color`, which they set to the
// dither-ink token). Never `currentcolor`: Chromium resolves that from the text of the canvas's
// inline style, where `var(--dither-ink)` is not a color, and paints black, which is invisible on
// the dark canvas. `levelAt` gives the level of a column: constant for a meter, rising for the
// slider's track.
export function paintDither(
  context: DitherContext,
  grid: DitherGrid,
  levelAt: (column: number) => number,
  ink: string,
): void {
  const { columns, rows, cellDevicePx } = grid;
  context.clearRect(0, 0, columns * cellDevicePx, rows * cellDevicePx);
  context.fillStyle = ink;
  for (let x = 0; x < columns; x++) {
    const level = levelAt(x);
    for (let y = 0; y < rows; y++) {
      if (isLit(x, y, level)) {
        context.fillRect(x * cellDevicePx, y * cellDevicePx, cellDevicePx, cellDevicePx);
      }
    }
  }
}
