import { act, cleanup, render, screen } from "@testing-library/react";
import type { DetachedWindowAPI } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenVar } from "../tokens/index.ts";
import { bayerThreshold, isLit } from "./bayer.ts";
import {
  Dither,
  type DitherContext,
  DitherGradient,
  DitherStrip,
  ditherLevel,
  rampValue,
} from "./index.ts";

// A handwritten 2D context: it keeps the squares of the last paint (clearRect starts a paint) and
// every fill style it was given.
type Square = { x: number; y: number; width: number; height: number };

function fakeCanvas() {
  const squares: Square[] = [];
  const styles: string[] = [];
  let paints = 0;
  const context: DitherContext = {
    get fillStyle() {
      return styles.at(-1) ?? "";
    },
    set fillStyle(style) {
      styles.push(String(style));
    },
    clearRect() {
      squares.length = 0;
      paints++;
    },
    fillRect(x, y, width, height) {
      squares.push({ x, y, width, height });
    },
  };
  return { squares, styles, paints: () => paints, factory: () => context };
}

// happy-dom's own setting for the prefers-reduced-motion media feature (the environment's switch,
// not a patched global).
const device = (window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

afterEach(() => {
  cleanup();
  device.prefersReducedMotion = "no-preference";
  document.documentElement.removeAttribute("data-theme");
  vi.useRealTimers();
});

describe("the Bayer matrix", () => {
  it("is the mockups' 4x4 matrix, every threshold once", () => {
    const rows = [0, 1, 2, 3].map((y) => [0, 1, 2, 3].map((x) => bayerThreshold(x, y)));
    expect(rows).toEqual([
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ]);
    expect(bayerThreshold(5, 6)).toBe(bayerThreshold(1, 2));
  });

  it("quantises a value to the matrix's 16 steps", () => {
    expect(ditherLevel(0.58)).toBe(9);
    expect(ditherLevel(0)).toBe(0);
    expect(ditherLevel(1)).toBe(16);
    expect(ditherLevel(0.03)).toBe(0);
    expect(ditherLevel(0.04)).toBe(1);
  });
});

describe("<Dither>", () => {
  const scam = "Scam? 58% likely yes";

  it("lights the matrix's 9 of 16 cells for 0.58", () => {
    const canvas = fakeCanvas();
    // 8 px at 2 px cells: one 4x4 tile.
    render(<Dither value={0.58} size={8} label={scam} ratio={1} context={canvas.factory} />);
    expect(canvas.squares).toHaveLength(9);
    for (const { x, y } of canvas.squares) expect(bayerThreshold(x / 2, y / 2)).toBeLessThan(9);
  });

  it("lights 9 of every 16 cells across a 24 px square", () => {
    const canvas = fakeCanvas();
    render(<Dither value={0.58} label={scam} ratio={1} context={canvas.factory} />);
    // 12 x 12 cells, nine tiles.
    expect(canvas.squares).toHaveLength(81);
  });

  it("keeps the cell count and paints each cell in whole device pixels as the ratio grows", () => {
    for (const [ratio, cellDevicePx] of [
      [1, 2],
      [1.5, 3],
      [2, 4],
      [3, 6],
    ] as const) {
      const canvas = fakeCanvas();
      const name = `ratio ${ratio}`;
      render(<Dither value={0.58} label={name} ratio={ratio} context={canvas.factory} />);
      const element = screen.getByRole("img", { name });
      expect(element.getAttribute("width")).toBe(String(12 * cellDevicePx));
      expect(element.getAttribute("height")).toBe(String(12 * cellDevicePx));
      expect(element.style.width).toBe("24px");
      expect(canvas.squares).toHaveLength(81);
      for (const square of canvas.squares) {
        expect(square.width).toBe(cellDevicePx);
        expect(square.height).toBe(cellDevicePx);
        expect(square.x % cellDevicePx).toBe(0);
        expect(square.y % cellDevicePx).toBe(0);
      }
    }
  });

  it("draws 2 px cells as 4 device pixels at ratio 2, with crisp edges", () => {
    const canvas = fakeCanvas();
    render(<Dither value={1} size={8} label="Certain" ratio={2} context={canvas.factory} />);
    const element = screen.getByRole("img", { name: "Certain" });
    expect(element.getAttribute("width")).toBe("16");
    expect(element.style.width).toBe("8px");
    expect(element.style.imageRendering).toBe("pixelated");
    expect(canvas.squares).toHaveLength(16);
    expect(canvas.squares[5]).toEqual({ x: 4, y: 4, width: 4, height: 4 });
  });

  it("is an image named by the caller's label", () => {
    render(<Dither value={0.58} label={scam} ratio={1} context={fakeCanvas().factory} />);
    expect(screen.getByRole("img", { name: scam }).tagName).toBe("CANVAS");
  });

  it("clamps a value outside 0 to 1 to the nearest end", () => {
    const below = fakeCanvas();
    render(<Dither value={-0.4} label="below" ratio={1} context={below.factory} />);
    expect(below.squares).toHaveLength(0);
    const above = fakeCanvas();
    render(<Dither value={1.7} label="above" ratio={1} context={above.factory} />);
    expect(above.squares).toHaveLength(144);
  });

  it("paints in currentcolor on a canvas whose color is the dither-ink token", () => {
    const canvas = fakeCanvas();
    render(<Dither value={0.5} label="Half" ratio={1} context={canvas.factory} />);
    expect(canvas.styles).toEqual(["currentcolor"]);
    expect(screen.getByRole("img", { name: "Half" }).style.color).toBe(tokenVar("dither-ink"));
  });

  it("paints the brand mark in the facet token, and nothing else unless asked", () => {
    const mark = fakeCanvas();
    render(
      <Dither
        value={0.75}
        size={16}
        ink="facet"
        label="FacetDB"
        ratio={1}
        context={mark.factory}
      />,
    );
    expect(screen.getByRole("img", { name: "FacetDB" }).style.color).toBe(tokenVar("facet"));
    expect(mark.styles).toEqual(["currentcolor"]);
    render(<DitherStrip value={0.5} width={16} label="Strip" ratio={1} context={mark.factory} />);
    expect(screen.getByRole("img", { name: "Strip" }).style.color).toBe(tokenVar("dither-ink"));
  });

  it("repaints when the theme switch changes the ink", async () => {
    const canvas = fakeCanvas();
    render(<Dither value={0.5} label="Half" ratio={1} context={canvas.factory} />);
    const before = canvas.paints();
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
    });
    expect(canvas.paints()).toBeGreaterThan(before);
  });

  it("swaps thresholds a level at a time toward a new value", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const canvas = fakeCanvas();
    const meter = (value: number) => (
      <Dither value={value} size={8} label="Moving" ratio={1} context={canvas.factory} />
    );
    const { rerender } = render(meter(0.25));
    expect(canvas.squares).toHaveLength(4);
    rerender(meter(0.75));
    expect(canvas.squares).toHaveLength(4);
    const seen = new Set<number>();
    for (let frame = 0; frame < 12; frame++) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      seen.add(canvas.squares.length);
    }
    expect(canvas.squares).toHaveLength(12);
    expect([...seen].some((count) => count > 4 && count < 12)).toBe(true);
  });

  it("shows a new value at once under prefers-reduced-motion", () => {
    device.prefersReducedMotion = "reduce";
    const canvas = fakeCanvas();
    const meter = (value: number) => (
      <Dither value={value} size={8} label="Still" ratio={1} context={canvas.factory} />
    );
    const { rerender } = render(meter(0.25));
    const paintsBefore = canvas.paints();
    rerender(meter(0.75));
    expect(canvas.squares).toHaveLength(12);
    expect(canvas.paints()).toBe(paintsBefore + 1);
  });
});

describe("<DitherStrip>", () => {
  it("is a strip of 2 px cells, as wide as asked and rows high, named by its label", () => {
    const canvas = fakeCanvas();
    render(
      <DitherStrip
        value={0.13}
        width={160}
        rows={4}
        label="13% of the monthly cap spent"
        ratio={2}
        context={canvas.factory}
      />,
    );
    const element = screen.getByRole("img", { name: "13% of the monthly cap spent" });
    expect(element.getAttribute("width")).toBe("320");
    expect(element.getAttribute("height")).toBe("16");
    expect(element.style.height).toBe("8px");
    // 0.13 is level 2: two cells of every 16 across 80 x 4 cells.
    expect(canvas.squares).toHaveLength((80 * 4 * 2) / 16);
  });
});

describe("<DitherGradient>", () => {
  it("rises from empty at the left edge to full at the right, hidden from the reader", () => {
    const canvas = fakeCanvas();
    const { container } = render(
      <DitherGradient width={64} rows={4} ratio={1} context={canvas.factory} />,
    );
    const element = container.querySelector("canvas");
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
    const litIn = (column: number) => canvas.squares.filter((s) => s.x === column * 2).length;
    expect(litIn(0)).toBe(0);
    expect(litIn(31)).toBe(4);
    const level = ditherLevel(rampValue(16, 32));
    expect(litIn(16)).toBe([0, 1, 2, 3].filter((y) => isLit(16, y, level)).length);
  });

  it("ramps a column's value from 0 to 1", () => {
    expect(rampValue(0, 5)).toBe(0);
    expect(rampValue(2, 5)).toBe(0.5);
    expect(rampValue(4, 5)).toBe(1);
    expect(rampValue(0, 1)).toBe(1);
  });
});
