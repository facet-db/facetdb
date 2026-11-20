import * as Slider from "@radix-ui/react-slider";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type DitherContextFactory, DitherGradient } from "../dither/index.ts";
import { focusBrackets } from "./Button.tsx";

// The thresholds, as the config holds them (0 to 1): a yes or no question has two cut lines, a
// pick-one or a rating one confidence line.
export type Thresholds =
  | { kind: "cuts"; noBelow: number; yesAbove: number }
  | { kind: "confidence"; confidenceAtLeast: number };

// How the slider learns the width of its track; the default watches the element with a
// ResizeObserver, a test passes a handwritten one.
export type WatchWidth = (element: HTMLElement, onWidth: (width: number) => void) => () => void;

export const watchElementWidth: WatchWidth = (element, onWidth) => {
  onWidth(element.getBoundingClientRect().width);
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) onWidth(entry.contentRect.width);
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
};

export type ThresholdSliderProps = {
  // The question's name: "is_scam". It names the group for a screen reader.
  question: string;
  value: Thresholds;
  onChange: (next: Thresholds) => void;
  // The sample rows' probabilities (a yes or no question's chance of yes) or confidences, from
  // which the counts beneath are drawn: how many the cut lines would decide, how many they would
  // send to review.
  probabilities: readonly number[];
  disabled?: boolean;
  // The track's width in CSS px; by default it fits its container.
  width?: number;
  watchWidth?: WatchWidth;
  // Passed to the gradient (tests pass fakes; by default the device's).
  ratio?: number;
  context?: DitherContextFactory;
};

// Used until the track has been measured (and where nothing can measure): the mockups' 600 px.
const fallbackWidth = 600;
// Two tips side by side need about this much room between their cut lines; closer, they stack.
const tipRoom = 320;
// Half of a tip's widest text, centered on its cut line.
const tipHalf = 80;

const percent = (p: number): number => Math.round(p * 100);
const words = (p: number): string => `${String(percent(p))}%`;

// How many of the rows the thresholds decide without a person: at or below noBelow, at or above
// yesAbove (a yes or no question); at or above confidenceAtLeast (a pick-one or a rating).
export function decidedCount(thresholds: Thresholds, probabilities: readonly number[]): number {
  const decides =
    thresholds.kind === "cuts"
      ? (p: number) => p <= thresholds.noBelow || p >= thresholds.yesAbove
      : (p: number) => p >= thresholds.confidenceAtLeast;
  return probabilities.filter(decides).length;
}

type Cut = { label: string; tip: string; at: number };

function cutsOf(thresholds: Thresholds): Cut[] {
  if (thresholds.kind === "cuts") {
    return [
      {
        label: "No at or below",
        tip: `no at or below ${words(thresholds.noBelow)}`,
        at: thresholds.noBelow,
      },
      {
        label: "Yes at or above",
        tip: `yes at or above ${words(thresholds.yesAbove)}`,
        at: thresholds.yesAbove,
      },
    ];
  }
  const at = thresholds.confidenceAtLeast;
  return [
    { label: "Decide when confident at least", tip: `decide when ${words(at)} confident`, at },
  ];
}

// A tip is centered on its cut line unless that would push half of it (about `tipHalf` px) outside
// the track: near the left edge it starts at the line, near the right edge it ends there.
function anchorOf(at: number, width: number): "start" | "center" | "end" {
  if (at * width < tipHalf) return "start";
  if ((1 - at) * width < tipHalf) return "end";
  return "center";
}

// The same thresholds with one cut line moved to a whole percent; the other keeps its exact value.
function withCut(thresholds: Thresholds, index: number, pct: number): Thresholds {
  const p = pct / 100;
  if (thresholds.kind === "confidence") return { kind: "confidence", confidenceAtLeast: p };
  return index === 0 ? { ...thresholds, noBelow: p } : { ...thresholds, yesAbove: p };
}

function useTrackWidth(pinned: number | undefined, watch: WatchWidth) {
  const ref = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (pinned !== undefined || element === null) return;
    return watch(element, setMeasured);
  }, [pinned, watch]);
  const width = pinned ?? (measured > 0 ? Math.floor(measured) : fallbackWidth);
  return { ref, width };
}

// A Radix slider over a dither gradient: one or two cut lines standing on the texture whose density
// is the probability under them, a tip at each saying what it means in words, and under them the
// counts of the sample rows. Keys: the arrows move the focused cut line by 1% and Page Up and Page
// Down by 10% (Radix's). Home and End are ours: Radix would send the first and the last cut line to
// the track's ends whichever has the focus and pull the focus along, so each thumb takes them
// itself and moves only its own cut line to its own limit: the start of the track or one step above
// the other cut line for Home, one step under it or the end of the track for End. The focus stays
// where it is.
export function ThresholdSlider({
  question,
  value,
  onChange,
  probabilities,
  disabled,
  width: pinnedWidth,
  watchWidth = watchElementWidth,
  ratio,
  context,
}: ThresholdSliderProps) {
  const { ref, width } = useTrackWidth(pinnedWidth, watchWidth);
  const cuts = cutsOf(value);
  const values = cuts.map((cut) => percent(cut.at));
  const decided = decidedCount(value, probabilities);
  const total = probabilities.length;
  const [first, second] = cuts;
  const stacked =
    first !== undefined && second !== undefined && (second.at - first.at) * width < tipRoom;

  // What one cut line may be: the other keeps a step between them (noBelow is always lower).
  const limitsOf = (index: number): { min: number; max: number } => {
    const [low, high] = values;
    if (low === undefined || high === undefined) return { min: 0, max: 100 };
    return index === 0 ? { min: 0, max: high - 1 } : { min: low + 1, max: 100 };
  };

  // Radix reports the whole list; only the thumb that moved changes, the other keeps its exact
  // value (0.725 stays 0.725, not 0.73).
  const change = (next: number[]): void => {
    const index = next.findIndex((pct, at) => pct !== values[at]);
    const pct = next[index];
    if (pct !== undefined) onChange(withCut(value, index, pct));
  };

  const jumpTo =
    (index: number) =>
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== "Home" && event.key !== "End") return;
      // Radix skips its own Home and End once the event is prevented.
      event.preventDefault();
      if (disabled === true) return;
      const { min, max } = limitsOf(index);
      const target = event.key === "Home" ? min : max;
      if (target !== values[index]) onChange(withCut(value, index, target));
    };

  const gradient = {
    ...(ratio === undefined ? {} : { ratio }),
    ...(context === undefined ? {} : { context }),
  };
  return (
    <fieldset className="fdb-slider" disabled={disabled === true}>
      <VisuallyHidden asChild>
        <legend>{`Thresholds for ${question}: ${cuts.map((cut) => cut.tip).join(", ")}`}</legend>
      </VisuallyHidden>
      <Slider.Root
        ref={ref}
        className="fdb-slider-root"
        value={values}
        onValueChange={change}
        min={0}
        max={100}
        step={1}
        minStepsBetweenThumbs={1}
        disabled={disabled === true}
      >
        <Slider.Track className="fdb-slider-track">
          <DitherGradient width={width} {...gradient} />
        </Slider.Track>
        {cuts.map((cut, index) => {
          const { min, max } = limitsOf(index);
          return (
            <Slider.Thumb
              key={cut.label}
              className={`fdb-slider-thumb ${focusBrackets}`}
              aria-label={cut.label}
              aria-valuetext={words(cut.at)}
              aria-valuemin={min}
              aria-valuemax={max}
              onKeyDown={jumpTo(index)}
            />
          );
        })}
      </Slider.Root>
      <div className="fdb-slider-tips" aria-hidden="true" data-stacked={stacked ? "" : undefined}>
        {cuts.map((cut, index) => (
          <span
            key={cut.label}
            className="fdb-slider-tip"
            data-anchor={anchorOf(cut.at, width)}
            data-row={stacked && index === 1 ? "second" : "first"}
            style={{ left: `${String(percent(cut.at))}%` }}
          >
            {cut.tip}
          </span>
        ))}
      </div>
      <div className="fdb-slider-counts" role="status">
        <span>
          <strong>{decided}</strong> of {total} decided automatically
        </span>
        <span>
          <strong>{total - decided}</strong> to review
        </span>
      </div>
    </fieldset>
  );
}
