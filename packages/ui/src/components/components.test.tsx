import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { DetachedWindowAPI } from "happy-dom";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenNames } from "../tokens/index.ts";
import {
  Button,
  buttonClasses,
  DecisionTimeline,
  Dialog,
  DialogClose,
  decidedCount,
  EmptyState,
  Kbd,
  Kv,
  Listbox,
  type Schedule,
  ScrollRegion,
  SelfFillingTable,
  type StatusKind,
  StatusWord,
  statusKinds,
  statusWord,
  type TableColumn,
  Tag,
  ThresholdSlider,
  type Thresholds,
  Toast,
  ToastProvider,
  type WatchWidth,
} from "./index.ts";

// happy-dom lacks parts of what Radix calls (pointer capture, scrollIntoView, ResizeObserver):
// the environment gets them here, never the components.
function provide(target: object, name: string, value: unknown): void {
  if (!(name in target)) Object.defineProperty(target, name, { value, configurable: true });
}
provide(window.HTMLElement.prototype, "scrollIntoView", () => undefined);
provide(window.HTMLElement.prototype, "hasPointerCapture", () => false);
provide(window.HTMLElement.prototype, "setPointerCapture", () => undefined);
provide(window.HTMLElement.prototype, "releasePointerCapture", () => undefined);
provide(
  globalThis,
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

// happy-dom's own setting for the prefers-reduced-motion media feature.
const device = (window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

afterEach(() => {
  cleanup();
  device.prefersReducedMotion = "no-preference";
  vi.useRealTimers();
});

// No canvas backend: the meters keep their labels, which is what the tests read.
const noCanvas = () => null;

describe("<Button> and <Kbd>", () => {
  it("is a button by default, in the secondary variant and the product size", () => {
    render(<Button>Apply</Button>);
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset["variant"]).toBe("secondary");
    expect(button.dataset["size"]).toBe("medium");
  });

  it("takes the variant, the size and the focus brackets class", () => {
    render(
      <Button variant="primary" size="large">
        Apply
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button.dataset["variant"]).toBe("primary");
    expect(button.dataset["size"]).toBe("large");
    expect(button.classList.contains("fdb-brackets")).toBe(true);
    expect(buttonClasses("x").split(" ")).toEqual(["fdb-button", "fdb-brackets", "x"]);
  });

  it("shows its key hint, announces it once, and keeps its name to the words", () => {
    render(<Button keyHint="y">Yes</Button>);
    const button = screen.getByRole("button", { name: "Yes" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("y");
    const hint = within(button).getByText("y");
    expect(hint.tagName).toBe("KBD");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
  });

  it("is reached by Tab and pressed by Enter and by Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button>First</Button>
        <Button onClick={onClick}>Second</Button>
      </>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("is skipped by Tab and ignores keys when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Apply
      </Button>,
    );
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("draws a standalone key cap", () => {
    render(<Kbd>Esc</Kbd>);
    expect(screen.getByText("Esc").tagName).toBe("KBD");
  });
});

describe("<Listbox>", () => {
  const options = [
    { value: "pending", label: "Pending" },
    { value: "review", label: "Needs review" },
    { value: "done", label: "Done" },
    { value: "skipped", label: "Skipped", disabled: true },
  ];

  function Chosen({ hint }: { hint?: string }) {
    const [value, setValue] = useState("pending");
    return (
      <>
        <Listbox
          label="Status"
          options={options}
          value={value}
          onValueChange={setValue}
          {...(hint === undefined ? {} : { hint })}
        />
        <output>{value}</output>
      </>
    );
  }

  it("is a labelled combobox showing the chosen option", () => {
    render(<Chosen />);
    const trigger = screen.getByRole("combobox", { name: "Status" });
    expect(trigger.textContent).toContain("Pending");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on Arrow Down, moves with the arrows, picks with Enter and keeps the focus", async () => {
    const user = userEvent.setup();
    render(<Chosen />);
    await user.tab();
    const trigger = screen.getByRole("combobox", { name: "Status" });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{ArrowDown}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    // The chosen option is checked and highlighted first; the arrows move the highlight.
    expect(screen.getByRole("option", { name: "Pending" }).getAttribute("data-state")).toBe(
      "checked",
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Needs review" }));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("review");
    expect(trigger.textContent).toContain("Needs review");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape without choosing and returns the focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Chosen />);
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("pending");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Status" }));
  });

  it("jumps by type-ahead to the option that starts with the typed letters", async () => {
    const user = userEvent.setup();
    render(<Chosen />);
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("d");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Done" }));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe("done");
  });

  it("goes to the last and the first option with End and Home", async () => {
    const user = userEvent.setup();
    render(<Chosen />);
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{End}");
    // The last option is disabled, so the focus stops on the last one a person can choose.
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Done" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Pending" }));
  });

  it("describes the trigger with the hint, and keeps the hint out of the listbox's options", async () => {
    const user = userEvent.setup();
    render(<Chosen hint="This studio serves one project." />);
    const trigger = screen.getByRole("combobox", { name: "Status" });
    expect(trigger.getAttribute("aria-describedby")).not.toBeNull();
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(4);
    const describedBy = trigger.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "This studio serves one project.",
    );
  });

  it("is marked invalid and described by the words of a form's refusal, beside its hint", () => {
    render(
      <>
        <Listbox
          label="Time zone"
          options={options}
          hint="Every zone."
          invalid
          describedBy="zone-problem"
        />
        <p id="zone-problem">Choose a zone.</p>
      </>,
    );
    const trigger = screen.getByRole("combobox", { name: "Time zone" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(trigger.getAttribute("aria-describedby")).toContain("zone-problem");
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(<Listbox label="Status" options={options} defaultValue="done" disabled />);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is a box unless asked for the rail's ruled switcher, and marks a list that carries a hint", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Listbox label="Status" options={options} defaultValue="done" />);
    expect(screen.getByRole("combobox", { name: "Status" }).dataset["variant"]).toBe("box");
    unmount();
    render(
      <Listbox
        label="Project"
        options={[{ value: "marketplace", label: "marketplace" }]}
        value="marketplace"
        hint="This studio serves one project."
        variant="rule"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Project" });
    expect(trigger.dataset["variant"]).toBe("rule");
    await user.tab();
    await user.keyboard("{ArrowDown}");
    // The stylesheet keeps such a list narrow, so the hint wraps under the options.
    expect(screen.getByRole("listbox").closest("[data-hint]")).not.toBeNull();
  });
});

describe("<ScrollRegion>", () => {
  it("is a named region the keyboard reaches, whose frame and not the scroller wears the brackets", () => {
    render(
      <ScrollRegion aria-label="The record" className="max-h-40" frameClassName="mt-4">
        <p>Charged twice</p>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: "The record" });
    expect(region.tabIndex).toBe(0);
    expect(region.className).toBe("fdb-scroll max-h-40");
    // On the scroller the brackets overhang its edge and it shows scrollbars over text that fits.
    expect(region.classList.contains("fdb-brackets")).toBe(false);
    expect(region.parentElement?.className).toBe("fdb-scroll-frame fdb-brackets mt-4");
    expect(within(region).getByText("Charged twice")).toBeTruthy();
  });
});

describe("<StatusWord>", () => {
  const words: Record<StatusKind, string> = {
    pending: "pending",
    done: "done",
    needs_review: "needs review",
    error: "error",
    unchecked: "unchecked",
    skipped: "skipped",
    critical: "critical",
    warning: "warning",
    information: "information",
    resolved: "resolved",
  };

  it("says the word of every record status and every alert severity", () => {
    expect(statusKinds).toHaveLength(Object.keys(words).length);
    for (const status of statusKinds) {
      const { unmount } = render(<StatusWord status={status} />);
      expect(screen.getByText(words[status]).dataset["status"]).toBe(status);
      expect(statusWord(status)).toBe(words[status]);
      unmount();
    }
  });

  it("colors the square by the role of the status and nothing else", () => {
    const tones = {
      done: "yes",
      needs_review: "review",
      error: "no",
      pending: "pending",
      unchecked: "pending",
      skipped: "skipped",
    } as const;
    for (const [status, tone] of Object.entries(tones)) {
      const { unmount } = render(<StatusWord status={status as keyof typeof tones} />);
      expect(screen.getByText(words[status as keyof typeof tones]).dataset["tone"]).toBe(tone);
      unmount();
    }
  });

  it("keeps a word beside the square when the surface adds detail", () => {
    render(<StatusWord status="resolved" label="resolved 11:09 pm" size="small" />);
    const word = screen.getByText("resolved 11:09 pm");
    expect(word.dataset["status"]).toBe("resolved");
    expect(word.dataset["size"]).toBe("small");
  });

  it("merges a surface's class with its own instead of replacing it", () => {
    render(<StatusWord status="done" className="justify-self-start" />);
    const word = screen.getByText("done");
    expect([...word.classList]).toEqual(["fdb-status", "justify-self-start"]);
  });

  it("is one line unless the label is allowed to wrap, with the square staying on the first line", () => {
    const { unmount } = render(<StatusWord status="warning" label="One line" />);
    expect(screen.getByText("One line").dataset["wrap"]).toBe("false");
    unmount();
    render(<StatusWord status="warning" label="A sentence that wraps under the square" wrap />);
    expect(screen.getByText("A sentence that wraps under the square").dataset["wrap"]).toBe("true");
  });
});

describe("<Tag>", () => {
  it("is a rectangle of words with the role of its square", () => {
    render(<Tag tone="facet">Pick one, low stakes</Tag>);
    const tag = screen.getByText("Pick one, low stakes");
    expect(tag.dataset["tone"]).toBe("facet");
    render(<Tag>Plain</Tag>);
    expect(screen.getByText("Plain").dataset["tone"]).toBe("neutral");
  });
});

describe("<ThresholdSlider>", () => {
  // Twenty sample rows: the probabilities of yes.
  const sample = [
    0.02, 0.05, 0.08, 0.1, 0.27, 0.3, 0.42, 0.55, 0.58, 0.6, 0.66, 0.7, 0.75, 0.88, 0.9, 0.93, 0.95,
    0.97, 0.99, 0.64,
  ];
  const cuts: Thresholds = { kind: "cuts", noBelow: 0.1, yesAbove: 0.9 };
  const confidence: Thresholds = { kind: "confidence", confidenceAtLeast: 0.5 };

  function Controlled({
    start,
    onChange,
  }: {
    start: Thresholds;
    onChange?: (t: Thresholds) => void;
  }) {
    const [value, setValue] = useState(start);
    return (
      <ThresholdSlider
        question="is_scam"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        probabilities={sample}
        width={600}
        context={noCanvas}
      />
    );
  }

  it("counts the rows the cut lines decide: at or below no, at or above yes", () => {
    expect(decidedCount(cuts, sample)).toBe(9);
    expect(decidedCount(confidence, sample)).toBe(13);
    render(<Controlled start={cuts} />);
    expect(screen.getByRole("status").textContent).toBe(
      "9 of 20 decided automatically11 to review",
    );
  });

  it("names its group and gives each cut line its words and its value", () => {
    render(<Controlled start={cuts} />);
    const group = screen.getByRole("group", {
      name: "Thresholds for is_scam: no at or below 10%, yes at or above 90%",
    });
    const sliders = within(group).getAllByRole("slider");
    expect(sliders.map((s) => s.getAttribute("aria-label"))).toEqual([
      "No at or below",
      "Yes at or above",
    ]);
    expect(sliders.map((s) => s.getAttribute("aria-valuetext"))).toEqual(["10%", "90%"]);
    expect(sliders.map((s) => s.getAttribute("aria-valuenow"))).toEqual(["10", "90"]);
  });

  it("is reached by Tab in reading order and moved by the arrows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled start={cuts} onChange={onChange} />);
    await user.tab();
    const [low, high] = screen.getAllByRole("slider");
    expect(document.activeElement).toBe(low);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.12, yesAbove: 0.9 });
    expect(low?.getAttribute("aria-valuetext")).toBe("12%");
    await user.tab();
    expect(document.activeElement).toBe(high);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.12, yesAbove: 0.88 });
    // The counts follow: the row at 88% is now at or above the yes cut line.
    expect(screen.getByRole("status").textContent).toBe(
      "10 of 20 decided automatically10 to review",
    );
  });

  it("jumps by ten with Page Up", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled start={cuts} onChange={onChange} />);
    await user.tab();
    await user.keyboard("{PageUp}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.2, yesAbove: 0.9 });
  });

  // Radix alone would send the first thumb to Home and the last to End whichever has the focus,
  // and pull the focus to it: here each thumb takes the keys for its own cut line.
  it("sends only the focused cut line to its own limit with Home and End, and keeps the focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled start={cuts} onChange={onChange} />);
    const [low, high] = screen.getAllByRole("slider");
    await user.tab();
    expect(document.activeElement).toBe(low);
    await user.keyboard("{End}");
    // One step under the yes cut line, which has not moved.
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.89, yesAbove: 0.9 });
    expect(document.activeElement).toBe(low);
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0, yesAbove: 0.9 });
    expect(document.activeElement).toBe(low);
    await user.tab();
    expect(document.activeElement).toBe(high);
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0, yesAbove: 1 });
    expect(document.activeElement).toBe(high);
    await user.keyboard("{Home}");
    // One step over the no cut line.
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0, yesAbove: 0.01 });
    expect(document.activeElement).toBe(high);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("tells each cut line the room the other leaves it", () => {
    render(<Controlled start={cuts} />);
    const [low, high] = screen.getAllByRole("slider");
    expect([low, high].map((s) => s?.getAttribute("aria-valuemin"))).toEqual(["0", "11"]);
    expect([low, high].map((s) => s?.getAttribute("aria-valuemax"))).toEqual(["89", "100"]);
  });

  it("does not call back for Home or End on a cut line already at its limit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled start={{ kind: "cuts", noBelow: 0, yesAbove: 1 }} onChange={onChange} />);
    await user.tab();
    await user.keyboard("{Home}");
    await user.tab();
    await user.keyboard("{End}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the cut line it did not touch at its exact value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled start={{ kind: "cuts", noBelow: 0.725, yesAbove: 0.9 }} onChange={onChange} />,
    );
    await user.tab();
    await user.tab();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.725, yesAbove: 0.89 });
    await user.tab({ shift: true });
    await user.keyboard("{ArrowRight}");
    // The moved one is a whole percent (73 + 1 from the rounded display), the other still exact.
    expect(onChange).toHaveBeenLastCalledWith({ kind: "cuts", noBelow: 0.74, yesAbove: 0.89 });
  });

  it("keeps noBelow under yesAbove: a cut line does not move onto or past the other", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled start={{ kind: "cuts", noBelow: 0.5, yesAbove: 0.51 }} onChange={onChange} />,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
    const [low] = screen.getAllByRole("slider");
    expect(low?.getAttribute("aria-valuetext")).toBe("50%");
  });

  it("has one cut line for a pick-one or a rating, with its own words and counts", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled start={confidence} onChange={onChange} />);
    expect(
      screen.getByRole("group", { name: "Thresholds for is_scam: decide when 50% confident" }),
    ).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "Decide when confident at least" });
    expect(slider.getAttribute("aria-valuetext")).toBe("50%");
    expect(screen.getByRole("status").textContent).toBe(
      "13 of 20 decided automatically7 to review",
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "confidence", confidenceAtLeast: 0.51 });
  });

  it("anchors the tips inside the track and stacks them when the cut lines are close", () => {
    const { rerender } = render(
      <ThresholdSlider
        question="q"
        value={cuts}
        onChange={() => undefined}
        probabilities={sample}
        width={600}
        context={noCanvas}
      />,
    );
    const tips = () => document.querySelectorAll<HTMLElement>(".fdb-slider-tip");
    expect([...tips()].map((tip) => tip.dataset["anchor"])).toEqual(["start", "end"]);
    expect([...tips()].map((tip) => tip.dataset["row"])).toEqual(["first", "first"]);
    rerender(
      <ThresholdSlider
        question="q"
        value={{ kind: "cuts", noBelow: 0.4, yesAbove: 0.6 }}
        onChange={() => undefined}
        probabilities={sample}
        width={600}
        context={noCanvas}
      />,
    );
    expect([...tips()].map((tip) => tip.dataset["row"])).toEqual(["first", "second"]);
    rerender(
      <ThresholdSlider
        question="q"
        value={{ kind: "confidence", confidenceAtLeast: 0.95 }}
        onChange={() => undefined}
        probabilities={sample}
        width={600}
        context={noCanvas}
      />,
    );
    expect([...tips()].map((tip) => tip.dataset["anchor"])).toEqual(["end"]);
  });

  it("anchors each tip by where its cut line stands, whichever cut line it is", () => {
    const anchors = (value: Thresholds, width = 600): (string | undefined)[] => {
      const { unmount } = render(
        <ThresholdSlider
          question="q"
          value={value}
          onChange={() => undefined}
          probabilities={sample}
          width={width}
          context={noCanvas}
        />,
      );
      const found = [...document.querySelectorAll<HTMLElement>(".fdb-slider-tip")].map(
        (tip) => tip.dataset["anchor"],
      );
      unmount();
      return found;
    };
    // The no tip near the right edge ends at its line; the yes tip near the left edge starts at it.
    expect(anchors({ kind: "cuts", noBelow: 0.9, yesAbove: 0.95 })).toEqual(["end", "end"]);
    expect(anchors({ kind: "cuts", noBelow: 0.01, yesAbove: 0.05 })).toEqual(["start", "start"]);
    expect(anchors({ kind: "cuts", noBelow: 0.3, yesAbove: 0.7 })).toEqual(["center", "center"]);
    // The same cut line is nearer an edge on a narrower track.
    expect(anchors({ kind: "confidence", confidenceAtLeast: 0.25 }, 600)).toEqual(["center"]);
    expect(anchors({ kind: "confidence", confidenceAtLeast: 0.25 }, 300)).toEqual(["start"]);
  });

  it("fits its track to the width its watcher reports", () => {
    const watchers: ((width: number) => void)[] = [];
    const watchWidth: WatchWidth = (_element, onWidth) => {
      watchers.push(onWidth);
      return () => undefined;
    };
    render(
      <ThresholdSlider
        question="q"
        value={confidence}
        onChange={() => undefined}
        probabilities={sample}
        watchWidth={watchWidth}
        context={noCanvas}
      />,
    );
    const track = () => document.querySelector<HTMLCanvasElement>(".fdb-slider-track canvas");
    // Until measured, the mockups' 600 px.
    expect(track()?.style.width).toBe("600px");
    act(() => {
      for (const report of watchers) report(341.7);
    });
    expect(track()?.style.width).toBe("341px");
  });

  it("does not move when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ThresholdSlider
        question="q"
        value={confidence}
        onChange={onChange}
        probabilities={sample}
        width={600}
        context={noCanvas}
        disabled
      />,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("<SelfFillingTable>", () => {
  type Listing = {
    id: string;
    title: string;
    scam: { yes: number; decided: string | null } | undefined;
    status: StatusKind;
  };
  const columns: TableColumn<Listing>[] = [
    { kind: "text", id: "title", header: "Listing", cell: (row) => row.title },
    { kind: "answer", id: "scam", header: "Scam?", answer: (row) => row.scam?.decided },
    {
      kind: "measure",
      id: "scam-measure",
      header: "Scam? measure",
      measure: (row) =>
        row.scam === undefined
          ? undefined
          : {
              value: row.scam.yes,
              label: `Scam? ${String(Math.round(row.scam.yes * 100))}% likely yes`,
            },
    },
    { kind: "status", id: "status", header: "Status", status: (row) => row.status },
  ];
  const first: Listing = {
    id: "1",
    title: "Bike",
    scam: { yes: 0.04, decided: "No" },
    status: "done",
  };
  const second: Listing = {
    id: "2",
    title: "Phone",
    scam: { yes: 0.58, decided: null },
    status: "needs_review",
  };

  // A fake clock: every cell asks for a timer, and the test runs them by hand.
  function fakeClock() {
    const timers: { delay: number; run: () => void; cancelled: boolean }[] = [];
    const schedule: Schedule = (run, delay) => {
      const timer = { delay, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    };
    return {
      timers,
      schedule,
      fire(index: number) {
        const timer = timers[index];
        if (timer === undefined) throw new Error(`no timer ${String(index)}`);
        act(() => timer.run());
      },
    };
  }

  const cell = (row: number, column: number): HTMLElement => {
    const found = screen.getAllByRole("row")[row + 1]?.querySelectorAll("td")[column];
    if (found === undefined) throw new Error(`no cell ${String(row)}, ${String(column)}`);
    return found;
  };

  function table(rows: Listing[], clock: ReturnType<typeof fakeClock>, reducedMotion = false) {
    return (
      <SelfFillingTable
        label="Listings"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        schedule={clock.schedule}
        reducedMotion={reducedMotion}
        ratio={1}
        context={noCanvas}
      />
    );
  }

  it("is a labelled table with a header row and the record's own fields at once", () => {
    render(table([first, second], fakeClock()));
    // The scrolling region and the table each have a name of their own.
    expect(
      screen.getByRole("region", { name: "Listings, scrollable" }).getAttribute("tabindex"),
    ).toBe("0");
    expect(screen.getByRole("table", { name: "Listings" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Listing",
      "Scam?",
      "Scam? measure",
      "Status",
    ]);
    expect(cell(0, 0).textContent).toBe("Bike");
    expect(cell(1, 0).textContent).toBe("Phone");
    // Nothing of the answers yet.
    expect(cell(0, 1).textContent).toBe("");
    expect(cell(0, 2).textContent).toBe("");
    expect(cell(0, 3).textContent).toBe("");
  });

  it("asks for a timer per cell, 40 ms apart, in reading order: row by row, left to right", () => {
    const clock = fakeClock();
    render(table([first, second], clock));
    expect(clock.timers.map((timer) => timer.delay)).toEqual([0, 40, 80, 120, 160, 200]);
  });

  it("lands the cells one after another in that order", () => {
    const clock = fakeClock();
    render(table([first, second], clock));
    const landedOrder: string[] = [];
    const record = (): void => {
      const marks = [
        ["Bike answer", cell(0, 1)],
        ["Bike measure", cell(0, 2)],
        ["Bike status", cell(0, 3)],
        ["Phone answer", cell(1, 1)],
        ["Phone measure", cell(1, 2)],
        ["Phone status", cell(1, 3)],
      ] as const;
      for (const [name, element] of marks) {
        if (element.textContent !== "" || element.querySelector("[role=img]") !== null) {
          if (!landedOrder.includes(name)) landedOrder.push(name);
        }
      }
    };
    for (let index = 0; index < clock.timers.length; index++) {
      clock.fire(index);
      record();
      expect(landedOrder).toHaveLength(index + 1);
    }
    expect(landedOrder).toEqual([
      "Bike answer",
      "Bike measure",
      "Bike status",
      "Phone answer",
      "Phone measure",
      "Phone status",
    ]);
  });

  it("lands the answer in words, the unsure word, the measure's label and the status word", () => {
    const clock = fakeClock();
    render(table([first, second], clock));
    for (let index = 0; index < clock.timers.length; index++) clock.fire(index);
    expect(cell(0, 1).textContent).toBe("No");
    expect(cell(1, 1).textContent).toBe("unsure");
    expect(within(cell(1, 2)).getByRole("img", { name: "Scam? 58% likely yes" })).toBeTruthy();
    expect(cell(1, 2).textContent).toBe("58%");
    expect(cell(0, 3).textContent).toBe("done");
    expect(cell(1, 3).textContent).toBe("needs review");
    expect(cell(0, 1).hasAttribute("data-landed")).toBe(true);
  });

  it("queues rows that arrive later behind the cells still landing, and keeps what has landed", () => {
    const clock = fakeClock();
    const { rerender } = render(table([first], clock));
    expect(clock.timers.map((timer) => timer.delay)).toEqual([0, 40, 80]);
    clock.fire(0);
    rerender(table([first, second], clock));
    // Two of the first row's cells still wait: the new row's three go behind them.
    expect(clock.timers.map((timer) => timer.delay)).toEqual([0, 40, 80, 80, 120, 160]);
    expect(cell(0, 1).textContent).toBe("No");
  });

  it("staggers 20 cells at most: the rest land with the twentieth", () => {
    const clock = fakeClock();
    const rows = Array.from({ length: 9 }, (_, index) => ({ ...first, id: String(index) }));
    render(table(rows, clock));
    const delays = clock.timers.map((timer) => timer.delay);
    expect(delays).toHaveLength(27);
    expect(delays[19]).toBe(760);
    expect(delays.slice(19)).toEqual(Array.from({ length: 8 }, () => 760));
  });

  it("holds an empty cell back until its answer exists, then lands it", () => {
    const clock = fakeClock();
    const waiting: Listing = { id: "3", title: "Lamp", scam: undefined, status: "pending" };
    const { rerender } = render(table([waiting], clock));
    // Only the status has anything to show.
    expect(clock.timers).toHaveLength(1);
    clock.fire(0);
    expect(cell(0, 3).textContent).toBe("pending");
    rerender(table([{ ...waiting, scam: { yes: 0.97, decided: "Yes" }, status: "done" }], clock));
    expect(clock.timers).toHaveLength(3);
    clock.fire(1);
    clock.fire(2);
    expect(cell(0, 1).textContent).toBe("Yes");
  });

  it("fills a cell again when its answer goes blank and comes back", () => {
    const clock = fakeClock();
    const { rerender } = render(table([first], clock));
    for (let index = 0; index < 3; index++) clock.fire(index);
    expect(cell(0, 1).textContent).toBe("No");
    // The question preview is run again: the answer is cleared first.
    rerender(table([{ ...first, scam: undefined }], clock));
    expect(cell(0, 1).textContent).toBe("");
    expect(clock.timers).toHaveLength(3);
    rerender(table([first], clock));
    // Not shown until its timer fires; the status, which never went, is not queued again.
    expect(cell(0, 1).textContent).toBe("");
    expect(clock.timers.map((timer) => timer.delay)).toEqual([0, 40, 80, 0, 40]);
    clock.fire(3);
    clock.fire(4);
    expect(cell(0, 1).textContent).toBe("No");
  });

  it("drops the timers of cells that leave before they land", () => {
    const clock = fakeClock();
    const { rerender } = render(table([first, second], clock));
    rerender(table([first], clock));
    expect(clock.timers.map((timer) => timer.cancelled)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("renders every cell at once, with no timer and no fade, when reduced motion is set", () => {
    const clock = fakeClock();
    render(table([first, second], clock, true));
    expect(clock.timers).toHaveLength(0);
    expect(document.querySelectorAll("td[data-landed]")).toHaveLength(0);
    expect(cell(0, 1).textContent).toBe("No");
    expect(cell(1, 3).textContent).toBe("needs review");
    expect(within(cell(1, 2)).getByRole("img", { name: "Scam? 58% likely yes" })).toBeTruthy();
  });

  it("follows the user's reduced-motion preference when the prop is not given", () => {
    device.prefersReducedMotion = "reduce";
    const clock = fakeClock();
    render(
      <SelfFillingTable
        label="Listings"
        columns={columns}
        rows={[first]}
        rowKey={(row) => row.id}
        schedule={clock.schedule}
        context={noCanvas}
      />,
    );
    expect(clock.timers).toHaveLength(0);
    expect(cell(0, 3).textContent).toBe("done");
  });

  it("stops its timers when it unmounts", () => {
    const clock = fakeClock();
    const { unmount } = render(table([first], clock));
    unmount();
    expect(clock.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("fills on a real fake timer by default: 40 ms apart", () => {
    vi.useFakeTimers();
    render(
      <SelfFillingTable
        label="Listings"
        columns={columns}
        rows={[first]}
        rowKey={(row) => row.id}
        reducedMotion={false}
        context={noCanvas}
      />,
    );
    expect(cell(0, 1).textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(cell(0, 1).textContent).toBe("No");
    expect(cell(0, 2).querySelector("[role=img]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(39);
    });
    expect(cell(0, 2).querySelector("[role=img]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cell(0, 2).querySelector("[role=img]")).not.toBeNull();
    expect(cell(0, 3).textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(cell(0, 3).textContent).toBe("done");
  });
});

describe("<DecisionTimeline>", () => {
  it("is a labelled list that names each entry's kind before its words", () => {
    render(
      <DecisionTimeline
        label="Decisions for record 1042"
        entries={[
          { id: "a", kind: "human", when: "Today 2:31 pm, hailey", what: "Decided Scam? Yes" },
          {
            id: "b",
            kind: "answer",
            when: "Nov 3 10:02 am, jev-1.14.0, wording version 2",
            what: "First answer",
            detail: "Scam? 27% likely yes, so No.",
          },
          { id: "c", kind: "threshold", when: "Nov 4", what: "Thresholds changed" },
          { id: "d", kind: "version", when: "Nov 5", what: "Question set changed" },
          { id: "e", kind: "created", when: "Nov 3 9:55 am", what: "Record created" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Decisions for record 1042" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.dataset["kind"])).toEqual([
      "human",
      "answer",
      "threshold",
      "version",
      "created",
    ]);
    expect(items[0]?.textContent).toBe("Human decisionToday 2:31 pm, haileyDecided Scam? Yes");
    expect(items[1]?.textContent).toBe(
      "Model answerNov 3 10:02 am, jev-1.14.0, wording version 2First answerScam? 27% likely yes, so No.",
    );
    // The kind is a visible word on every entry (the square's color is never the only carrier),
    // and no two kinds share one.
    const kinds = items.map((item) => item.querySelector(".fdb-timeline-kind"));
    expect(kinds.map((kind) => kind?.textContent)).toEqual([
      "Human decision",
      "Model answer",
      "Threshold change",
      "Question set version",
      "Record created",
    ]);
    for (const kind of kinds) expect(kind?.closest("[aria-hidden]")).toBeNull();
  });
});

describe("<EmptyState>", () => {
  it("has a heading, one sentence and one action, and a cloud a screen reader skips", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Nothing installed yet"
        action={<Button onClick={onClick}>Browse the gallery</Button>}
        ratio={1}
        context={noCanvas}
      >
        Plugins arrive in a later version.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Nothing installed yet" })).toBeTruthy();
    expect(screen.getByText("Plugins arrive in a later version.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes its heading level from the page's outline", () => {
    render(
      <EmptyState title="No alerts" level={3} context={noCanvas}>
        Nothing has gone wrong.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "No alerts" })).toBeTruthy();
  });
});

describe("<Toast>", () => {
  const alert = {
    what: "Model failing",
    where: "support_messages",
    did: "FacetDB retried with backoff and held 12 records.",
  };

  function Host({
    severity,
    onOpenChange,
    onLink,
  }: {
    severity?: "critical" | "warning" | "information";
    onOpenChange?: (open: boolean) => void;
    onLink?: () => void;
  }) {
    const [open, setOpen] = useState(true);
    return (
      <ToastProvider>
        <Toast
          {...alert}
          // The page's own link: a router's, say, which handles the click itself.
          action={{
            element: (
              <a
                href="/alerts"
                onClick={(event) => {
                  event.preventDefault();
                  onLink?.();
                }}
              >
                Open the alert
              </a>
            ),
            altText: "Open the alerts page, /alerts",
          }}
          {...(severity === undefined ? {} : { severity })}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange?.(next);
          }}
        />
      </ToastProvider>
    );
  }

  it("says what happened, where, what FacetDB did, with one link and the severity in words", () => {
    render(<Host severity="warning" />);
    const toast = document.querySelector<HTMLElement>(".fdb-toast");
    if (toast === null) throw new Error("no toast");
    expect(within(toast).getByText("warning")).toBeTruthy();
    expect(toast.textContent).toContain("Model failing");
    expect(toast.textContent).toContain(
      "support_messages. FacetDB retried with backoff and held 12 records.",
    );
    expect(within(toast).getByRole("link", { name: "Open the alert" }).getAttribute("href")).toBe(
      "/alerts",
    );
  });

  // Radix announces a toast in a live region of its own, a frame after it appears: assertive for
  // the foreground type, polite for the background one.
  it("announces a critical alert at once and the others politely, severity word first", async () => {
    const { unmount } = render(<Host severity="critical" />);
    const urgent = await screen.findByRole("status");
    expect(urgent.getAttribute("aria-live")).toBe("assertive");
    await waitFor(() => expect(urgent.textContent).toContain("critical Model failing"));
    unmount();
    render(<Host />);
    const calm = await screen.findByRole("status");
    expect(calm.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(calm.textContent).toContain("information Model failing"));
  });

  it("gives the page's link the focus brackets and hands the click to the page", async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();
    const onOpenChange = vi.fn();
    render(<Host onLink={onLink} onOpenChange={onOpenChange} />);
    const link = screen.getByRole("link", { name: "Open the alert" });
    expect(link.classList.contains("fdb-brackets")).toBe(true);
    expect(link.classList.contains("fdb-toast-link")).toBe(true);
    await user.click(link);
    expect(onLink).toHaveBeenCalledTimes(1);
    // A router's link prevents the default and Radix then leaves the toast open: closing it is
    // the page's call, through the open prop it controls.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // F8 is Radix's way into the viewport; from there Tab walks the toast, its link, its button.
  it("is reached by F8 and Tab, and dismissed from the keyboard with Enter on its button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Host onOpenChange={onOpenChange} />);
    await user.keyboard("{F8}");
    const toast = document.querySelector<HTMLElement>(".fdb-toast");
    if (toast === null) throw new Error("no toast");
    for (let presses = 0; presses < 4 && document.activeElement !== toast; presses++) {
      await user.tab();
    }
    expect(document.activeElement).toBe(toast);
    await user.tab();
    expect(document.activeElement).toBe(
      within(toast).getByRole("link", { name: "Open the alert" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(within(toast).getByRole("button", { name: "Dismiss" }));
    await user.keyboard("{Enter}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("is dismissed by Escape while it has the focus", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Host onOpenChange={onOpenChange} />);
    await user.keyboard("{F8}");
    const toast = document.querySelector<HTMLElement>(".fdb-toast");
    if (toast === null) throw new Error("no toast");
    for (let presses = 0; presses < 4 && document.activeElement !== toast; presses++) {
      await user.tab();
    }
    expect(document.activeElement).toBe(toast);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("<Dialog>", () => {
  function Host({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
    return (
      <Dialog
        title="Apply this change"
        description="The file's diff is shown first."
        trigger={<Button>Apply</Button>}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
        actions={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary">Write the file</Button>
          </>
        }
      >
        <p>Two lines change.</p>
      </Dialog>
    );
  }

  it("opens from its trigger by keyboard, named and described, with the focus inside", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Apply" });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", {
      name: "Apply this change",
      description: "The file's diff is shown first.",
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText("Two lines change.")).toBeTruthy();
  });

  it("keeps the focus inside while open", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.tab();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    for (let press = 0; press < 5; press++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Escape and returns the focus to the control that opened it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Host onOpenChange={onOpenChange} />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Apply" });
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from its Cancel button and returns the focus the same way", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Apply" });
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("is a dialog without a description when none is given", async () => {
    render(
      <Dialog title="Heads up" defaultOpen>
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Heads up" });
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("<Kv>", () => {
  it("lays an object out as key and value lines, never raw JSON", () => {
    const { container } = render(
      <Kv
        value={{
          title: "Bike, barely used",
          price: 390,
          negotiable: true,
          note: "",
          seller: { name: "pat", verified: false },
          tags: ["bike", "road"],
          history: [],
          deleted_at: null,
        }}
      />,
    );
    const keys = [...container.querySelectorAll(":scope > dl > div > dt")].map(
      (dt) => dt.textContent,
    );
    expect(keys).toEqual([
      "title",
      "price",
      "negotiable",
      "note",
      "seller",
      "tags",
      "history",
      "deleted_at",
    ]);
    expect(container.textContent).not.toContain("{");
    expect(container.textContent).not.toContain('"');
    const lines = container.querySelectorAll(":scope > dl > div");
    expect(lines[0]?.querySelector("dd")?.textContent).toBe("Bike, barely used");
    expect(lines[1]?.querySelector("dd")?.textContent).toBe("390");
    expect(lines[2]?.querySelector("dd")?.textContent).toBe("true");
    expect(lines[3]?.querySelector("dd")?.textContent).toBe("blank text");
    expect(lines[7]?.querySelector("dd")?.textContent).toBe("no value");
    // A nested object lays out again; a list is one line per item.
    expect([...(lines[4]?.querySelectorAll("dl dt") ?? [])].map((dt) => dt.textContent)).toEqual([
      "name",
      "verified",
    ]);
    expect([...(lines[5]?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      "bike",
      "road",
    ]);
    expect(lines[6]?.querySelector("dd")?.textContent).toBe("no items");
  });

  it("says each kind of nothing in its own words, apart from the text 'empty' itself", () => {
    const { container } = render(<Kv value={{ a: null, b: "", c: {}, d: [], e: "empty" }} />);
    const values = [...container.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(values).toEqual(["no value", "blank text", "no fields", "no items", "empty"]);
    // The first four are the muted role's words; a person's own text is never muted.
    const muted = [...container.querySelectorAll("dd")].map((dd) =>
      dd.querySelector(".fdb-kv-empty") === null ? "plain" : "muted",
    );
    expect(muted).toEqual(["muted", "muted", "muted", "muted", "plain"]);
  });

  it("reads each key with its value for a screen reader: a description list", () => {
    render(<Kv value={{ Sends: "Critical alerts and warnings." }} />);
    expect(screen.getByText("Sends").tagName).toBe("DT");
    expect(screen.getByText("Critical alerts and warnings.").closest("dd")).not.toBeNull();
  });

  it("shows a bare value as the one line it is", () => {
    render(<Kv value="just words" />);
    expect(screen.getByText("just words")).toBeTruthy();
  });
});

describe("components.css", () => {
  // From the string: under happy-dom the global URL is the DOM's, which node:url does not accept.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "components.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("reads only the variables of tokens.css (and the ones Radix sets on its popper)", () => {
    const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(10);
    const unknown = [...used].filter(
      (name) =>
        name !== undefined &&
        !tokenNames.some((token) => token === name) &&
        !name.startsWith("radix-"),
    );
    expect(unknown).toEqual([]);
  });

  it("tells a pressed button and the chosen option apart by more than color", () => {
    const rule = (selector: string): string => {
      const start = css.indexOf(`${selector} {`);
      return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
    };
    expect(rule('.fdb-button[aria-pressed="true"]')).toContain("text-decoration: underline");
    expect(rule('.fdb-listbox-item[data-state="checked"]')).toContain("font-weight: 600");
  });

  it("keeps a transparent outline where it hides the default one, so forced colors show focus", () => {
    expect(css).not.toContain("outline: none");
    expect(css).toContain("outline: 2px solid transparent");
  });

  it("holds no duration of its own: every transition and animation reads a motion token", () => {
    expect(css).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
  });
});
