import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motionMs, tokenVar } from "../tokens/index.ts";
import {
  type DitherContext,
  ditherCellCssPx,
  ditherGrid,
  ditherLevel,
  paintDither,
} from "./bayer.ts";
import { rampLevelAt } from "./gradient.ts";

// The probability meters: a square (<Dither>), a strip (<DitherStrip>) and the slider's track
// (<DitherGradient>), each a canvas painted at the device pixel ratio in the dither-ink token. A
// meter is role="img" with the caller's label, which says the words and the number ("Scam? 58%
// likely yes"): the dither is never the only carrier.

// How a meter gets its 2D context; tests pass a factory returning a handwritten fake.
export type DitherContextFactory = (canvas: HTMLCanvasElement) => DitherContext | null;

const canvasContext: DitherContextFactory = (canvas) => canvas.getContext("2d");

// Optional on every meter: the device pixel ratio defaults to the window's, and the context
// factory to the canvas's own.
type CanvasOptions = { ratio?: number; context?: DitherContextFactory };

export type DitherProps = CanvasOptions & {
  value: number;
  label: string;
  // The square's side in CSS px: 24 in a row, 40 on the review card.
  size?: number;
};

export type DitherStripProps = CanvasOptions & {
  value: number;
  label: string;
  width: number;
  // Rows of 2 px cells: 4 in the rail, 6 in a table's measure column (the mockups).
  rows?: number;
};

export type DitherGradientProps = CanvasOptions & { width: number; rows?: number };

const lightScheme = "(prefers-color-scheme: light)";

// The theme the canvas was painted under: the OS preference and the rail's switch (data-theme
// on the root). `currentcolor` is resolved when the canvas is painted, so a theme switch repaints.
function subscribeToTheme(onChange: () => void): () => void {
  const scheme = window.matchMedia(lightScheme);
  const root = new MutationObserver(onChange);
  scheme.addEventListener("change", onChange);
  root.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => {
    scheme.removeEventListener("change", onChange);
    root.disconnect();
  };
}

function themeSnapshot(): string {
  const chosen = document.documentElement.getAttribute("data-theme") ?? "auto";
  return `${chosen} ${String(window.matchMedia(lightScheme).matches)}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The level on screen: a new value swaps thresholds one level at a time over the state duration
// ("dither density animates by swapping thresholds, not by fading"); under prefers-reduced-motion
// the new level shows at once and nothing moves.
function useSteppedLevel(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const reduced = prefersReducedMotion();
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    const show = (level: number): void => {
      shownRef.current = level;
      setShown(level);
    };
    if (reduced) {
      show(target);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const step = (now: number): void => {
      start ??= now;
      const progress = Math.min(1, (now - start) / motionMs["motion-state"]);
      show(Math.round(from + (target - from) * progress));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, reduced]);
  return reduced ? target : shown;
}

type DitherCanvasProps = {
  widthCssPx: number;
  heightCssPx: number;
  // One level for every column (a meter), or the slider's ramp.
  level: number | "ramp";
  // The accessible name; null for the slider's track, which the slider's own label describes.
  label: string | null;
  ratio: number;
  context: DitherContextFactory;
};

function DitherCanvas({
  widthCssPx,
  heightCssPx,
  level,
  label,
  ratio,
  context,
}: DitherCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useSyncExternalStore(subscribeToTheme, themeSnapshot);
  const { columns, rows, cellDevicePx } = ditherGrid(widthCssPx, heightCssPx, ratio);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is read by the paint itself (currentcolor), so a switch repaints
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const drawing = context(canvas);
    // A DOM without a canvas backend has no context: the label still carries the value.
    if (drawing === null) return;
    const levelAt = level === "ramp" ? rampLevelAt(columns) : () => level;
    paintDither(drawing, { columns, rows, cellDevicePx }, levelAt);
  }, [columns, rows, cellDevicePx, level, context, theme]);

  // The CSS box stays the size asked for; the backing store is whole cells of whole device pixels.
  // At a ratio like 2.625 the two differ by a pixel or two, and `pixelated` keeps every edge hard
  // when the browser scales.
  const style: CSSProperties = {
    display: "inline-block",
    verticalAlign: "middle",
    flex: "none",
    width: `${widthCssPx}px`,
    height: `${heightCssPx}px`,
    color: tokenVar("dither-ink"),
    imageRendering: "pixelated",
  };
  const a11y = label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  return (
    <canvas
      ref={ref}
      width={columns * cellDevicePx}
      height={rows * cellDevicePx}
      style={style}
      {...a11y}
    />
  );
}

// A probability as a square whose ink density is the value.
export function Dither({
  value,
  label,
  size = 24,
  ratio = window.devicePixelRatio,
  context = canvasContext,
}: DitherProps) {
  const level = useSteppedLevel(ditherLevel(value));
  return (
    <DitherCanvas
      widthCssPx={size}
      heightCssPx={size}
      level={level}
      label={label}
      ratio={ratio}
      context={context}
    />
  );
}

// A probability as a strip: a table's measure column, the rail's spending, a backfill's progress.
export function DitherStrip({
  value,
  label,
  width,
  rows = 4,
  ratio = window.devicePixelRatio,
  context = canvasContext,
}: DitherStripProps) {
  const level = useSteppedLevel(ditherLevel(value));
  return (
    <DitherCanvas
      widthCssPx={width}
      heightCssPx={rows * ditherCellCssPx}
      level={level}
      label={label}
      ratio={ratio}
      context={context}
    />
  );
}

// The threshold slider's track: empty at the left, full at the right; decorative, since the
// slider's legend names the thresholds in words.
export function DitherGradient({
  width,
  rows = 6,
  ratio = window.devicePixelRatio,
  context = canvasContext,
}: DitherGradientProps) {
  return (
    <DitherCanvas
      widthCssPx={width}
      heightCssPx={rows * ditherCellCssPx}
      level="ramp"
      label={null}
      ratio={ratio}
      context={context}
    />
  );
}
