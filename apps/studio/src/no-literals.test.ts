import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The app names no color, face or duration of its own: they are tokens of packages/ui's tokens.css,
 * read as variables and as the Tailwind theme's utilities. Tailwind's own palette is cleared by the
 * theme, so `bg-red-500` builds nothing; this test catches what a utility could still smuggle in:
 * an arbitrary value (`bg-[#fff]`, `duration-[300ms]`), a duration utility, a face named in a
 * style.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const RULES: readonly (readonly [string, RegExp])[] = [
  ["a color value", /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/],
  ["a duration", /\b\d+(?:\.\d+)?m?s\b|\bduration-\d|\bdelay-\d/],
  ["a face", /Schibsted|Martian|Grotesk|Helvetica|Arial|Menlo|Inter\b|Archivo|JetBrains/],
];

describe("the studio's sources", () => {
  const files = sourceFiles(srcDir).filter((path) => !path.endsWith(".test.tsx"));

  it("are scanned, the stylesheet and the shell included", () => {
    const names = files.map((path) => path.slice(srcDir.length + 1));
    expect(names).toEqual(expect.arrayContaining(["app.css", "shell/Rail.tsx", "main.tsx"]));
  });

  it("name no color, duration or face outside packages/ui's tokens", () => {
    const offenders = files.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return RULES.flatMap(([what, rule]) => {
        const found = rule.exec(text);
        return found === null ? [] : [`${path.slice(srcDir.length + 1)}: ${what} (${found[0]})`];
      });
    });
    expect(offenders).toEqual([]);
  });
});
