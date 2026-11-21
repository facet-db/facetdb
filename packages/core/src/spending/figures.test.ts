import { describe, expect, it } from "vitest";
import { compactTokens, groupedTokens, readableTokenCounts, tokensOfCap } from "./figures.ts";

describe("compactTokens", () => {
  it("groups the digits under ten thousand", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(800)).toBe("800");
    expect(compactTokens(9_999)).toBe("9,999");
  });

  it("writes thousands with one decimal while it says something", () => {
    expect(compactTokens(10_000)).toBe("10k");
    expect(compactTokens(12_500)).toBe("12.5k");
    expect(compactTokens(15_843)).toBe("15.8k");
    expect(compactTokens(99_950)).toBe("100k");
    expect(compactTokens(102_000)).toBe("102k");
    expect(compactTokens(850_000)).toBe("850k");
  });

  it("writes millions and billions the same way, rounding onto the next unit at its edge", () => {
    expect(compactTokens(999_500)).toBe("1M");
    expect(compactTokens(1_007_553)).toBe("1M");
    expect(compactTokens(1_500_000)).toBe("1.5M");
    expect(compactTokens(3_000_134)).toBe("3M");
    expect(compactTokens(25_000_000)).toBe("25M");
    expect(compactTokens(595_238_096)).toBe("595M");
    expect(compactTokens(2_400_000_000)).toBe("2.4B");
  });

  it("takes a fraction of a token as the nearest whole one, and nothing below zero", () => {
    expect(compactTokens(1_234.6)).toBe("1,235");
    expect(compactTokens(-5)).toBe("0");
  });
});

describe("tokensOfCap", () => {
  it("adds the exact figures after the pair when the compact form hides them", () => {
    expect(tokensOfCap(3_000_134, 3_000_000)).toBe(
      "3M of 3M input tokens (3,000,134 of 3,000,000)",
    );
    expect(tokensOfCap(800_000, 1_000_000)).toBe("800k of 1M input tokens (800,000 of 1,000,000)");
  });

  it("rewrites a stored alert's bare digits on read, and leaves the new form alone", () => {
    expect(
      readableTokenCounts(
        "This month's usage reached the spending cap: 3000134 of 3000000 input tokens. Paused.",
      ),
    ).toBe(
      "This month's usage reached the spending cap: 3M of 3M input tokens (3,000,134 of 3,000,000). Paused.",
    );
    const already = "at 80%: 2.4M of 3M input tokens (2,400,097 of 3,000,000).";
    expect(readableTokenCounts(already)).toBe(already);
    expect(readableTokenCounts("800 of 1000 input tokens")).toBe("800 of 1,000 input tokens");
    expect(readableTokenCounts("50000 records queued")).toBe("50000 records queued");
  });

  it("writes small counts once, grouped", () => {
    expect(tokensOfCap(800, 1_000)).toBe("800 of 1,000 input tokens");
    expect(tokensOfCap(5_000, 5_000)).toBe("5,000 of 5,000 input tokens");
    expect(groupedTokens(3_000_134)).toBe("3,000,134");
  });
});
