import { describe, expect, it } from "vitest";
import { compactTokens, tokenWords } from "../../shell/index.ts";
import { capFromText, capText } from "./words.ts";

describe("capFromText", () => {
  it("reads digits with the separators a person types", () => {
    expect(capFromText("5,000,000")).toEqual({ ok: true, tokens: 5_000_000 });
    expect(capFromText(" 5 000 000 ")).toEqual({ ok: true, tokens: 5_000_000 });
    expect(capFromText("5_000_000")).toEqual({ ok: true, tokens: 5_000_000 });
  });

  it("reads the short forms 500k, 5M, 1.5m and 2B", () => {
    expect(capFromText("500k")).toEqual({ ok: true, tokens: 500_000 });
    expect(capFromText("5M")).toEqual({ ok: true, tokens: 5_000_000 });
    expect(capFromText("1.5m")).toEqual({ ok: true, tokens: 1_500_000 });
    expect(capFromText("2B")).toEqual({ ok: true, tokens: 2_000_000_000 });
    expect(capFromText("3.0001M")).toEqual({ ok: true, tokens: 3_000_100 });
    // Shifted on the digits, never a float product.
    expect(capFromText("1.005M")).toEqual({ ok: true, tokens: 1_005_000 });
    expect(capFromText("1.005k")).toEqual({ ok: true, tokens: 1_005 });
    expect(capFromText("0.5M")).toEqual({ ok: true, tokens: 500_000 });
  });

  it("refuses an empty, zero, fractional or lettered cap, saying the forms it takes", () => {
    expect(capFromText("")).toMatchObject({ ok: false, problem: { message: "The cap is empty." } });
    expect(capFromText("0")).toMatchObject({
      ok: false,
      problem: {
        message: "The cap is 0 tokens, which would pause the project before its first record.",
      },
    });
    expect(capFromText("1.5")).toMatchObject({
      ok: false,
      problem: {
        message: "The cap is a whole number of billable input tokens.",
        fix: "Type a number of tokens such as 5,000,000 or 5M, or tick No monthly cap.",
      },
    });
    expect(capFromText("0.0001k")).toMatchObject({ ok: false });
    expect(capFromText("5 million")).toMatchObject({ ok: false });
  });
});

describe("capText", () => {
  it("shows the short form when it says the whole cap, else the digits grouped", () => {
    expect(capText(5_000_000)).toBe("5M");
    expect(capText(1_500_000)).toBe("1.5M");
    expect(capText(500_000)).toBe("500k");
    expect(capText(6_000_000)).toBe("6M");
    expect(capText(5_000_001)).toBe("5,000,001");
    expect(capText(12_345)).toBe("12,345");
    expect(capText(8_500)).toBe("8,500");
  });
});

/** The same cases as packages/core/src/spending/figures.test.ts: the two spellings of one rule. */
describe("compactTokens (the studio's twin of core's)", () => {
  it("agrees with core on every case", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(9_999)).toBe("9,999");
    expect(compactTokens(10_000)).toBe("10k");
    expect(compactTokens(12_500)).toBe("12.5k");
    expect(compactTokens(99_950)).toBe("100k");
    expect(compactTokens(850_000)).toBe("850k");
    expect(compactTokens(999_500)).toBe("1M");
    expect(compactTokens(1_007_553)).toBe("1M");
    expect(compactTokens(3_000_134)).toBe("3M");
    expect(compactTokens(595_238_096)).toBe("595M");
    expect(compactTokens(2_400_000_000)).toBe("2.4B");
    expect(compactTokens(-5)).toBe("0");
  });

  it("words a cap at a glance, with the exact count after it when they differ", () => {
    expect(tokenWords(40_000_000)).toBe("40M billable input tokens (40,000,000)");
    expect(tokenWords(8_500)).toBe("8,500 billable input tokens");
  });
});
