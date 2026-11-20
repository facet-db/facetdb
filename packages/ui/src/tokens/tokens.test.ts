import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  type ColorRole,
  colorRoles,
  motionMs,
  motionTokens,
  tokenNames,
  tokenVar,
} from "./index.ts";

// tokens.css read as data: the rules it declares, by the media query around them and their
// selector, comments dropped. Enough CSS parsing for a file this package owns, nothing more.
type Rule = { media: string; selector: string; declarations: Map<string, string> };

// From the string: under happy-dom the global URL is the DOM's, which node:url does not accept.
const tokensDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(tokensDir, "..");
const tokensCss = readFileSync(join(tokensDir, "tokens.css"), "utf8");

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const line of body.split(";")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return declarations;
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (source: string, media: string): void => {
    let from = 0;
    for (let open = source.indexOf("{"); open !== -1; open = source.indexOf("{", from)) {
      let depth = 1;
      let end = open + 1;
      for (; depth > 0 && end < source.length; end++) {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
      }
      const head = source.slice(from, open).trim();
      const body = source.slice(open + 1, end - 1);
      if (head.startsWith("@media")) walk(body, head);
      else rules.push({ media, selector: head, declarations: parseDeclarations(body) });
      from = end;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), "");
  return rules;
}

const rules = parseRules(tokensCss);

function rule(media: string, selector: string): Map<string, string> {
  const found = rules.find((r) => r.media === media && r.selector === selector);
  if (found === undefined) throw new Error(`tokens.css has no rule ${media} ${selector}`);
  return found.declarations;
}

function customProperties(declarations: Map<string, string>): string[] {
  return [...declarations.keys()].filter((name) => name.startsWith("--")).map((n) => n.slice(2));
}

const dark = rule("", ":root");
const lightByPreference = rule(
  "@media (prefers-color-scheme: light)",
  ':root:not([data-theme="dark"])',
);
const lightBySwitch = rule("", ':root[data-theme="light"]');
const reducedMotion = rule("@media (prefers-reduced-motion: reduce)", ":root");
const themes = { dark, light: lightByPreference } as const;

// WCAG 2 relative luminance and contrast ratio, from a #rrggbb value.
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function value(theme: Map<string, string>, role: ColorRole): string {
  const found = theme.get(`--${role}`);
  if (found === undefined) throw new Error(`--${role} is not defined`);
  return found;
}

// The brief's text pairings ("every pairing passes 4.5:1 for text"), by the "Use" column: what each
// text role is set on. text-3 (placeholders, disabled) sits in a field on the canvas or in the
// listbox, never on the hover row (surface-2 reads 4.4:1 in both themes).
const textPairings: readonly [ColorRole, readonly ColorRole[]][] = [
  ["text", ["canvas", "surface", "surface-2"]],
  ["text-2", ["canvas", "surface", "surface-2"]],
  ["text-3", ["canvas", "surface"]],
  ["facet-text", ["canvas", "surface", "surface-2"]],
  ["facet-ink", ["facet"]],
];

// The status colors are squares beside their words (status is never color alone), and the light
// table allows `yes` and `no` as 16 px+ text only and `review` as the square alone: on the paper
// they read 4.48:1 and 4.49:1, so they are held to 3:1 (non-text, large text), and words that mean
// "review" take `facet-text`.
const statusColors = ["yes", "no", "review"] as const satisfies readonly ColorRole[];

describe("tokens.css", () => {
  it("declares every token on :root, the dark theme, and nothing the list does not name", () => {
    expect(customProperties(dark).sort()).toEqual([...tokenNames].sort());
    expect(dark.get("color-scheme")).toBe("dark");
  });

  it("declares every color role again in the light theme, by preference and by the switch alike", () => {
    expect(customProperties(lightByPreference).sort()).toEqual([...colorRoles].sort());
    expect(lightBySwitch).toEqual(lightByPreference);
    expect(lightByPreference.get("color-scheme")).toBe("light");
  });

  it("gives every color role a #rrggbb value in both themes", () => {
    for (const theme of Object.values(themes)) {
      for (const role of colorRoles) expect(value(theme, role)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps the facet fill and its ink the same in both themes, and the text role on dark", () => {
    expect(value(lightByPreference, "facet")).toBe(value(dark, "facet"));
    expect(value(lightByPreference, "facet-ink")).toBe(value(dark, "facet-ink"));
    expect(value(dark, "facet-text")).toBe(value(dark, "facet"));
  });

  for (const [name, theme] of Object.entries(themes)) {
    for (const [foreground, backgrounds] of textPairings) {
      for (const background of backgrounds) {
        it(`${name}: ${foreground} on ${background} reads at 4.5:1 or more`, () => {
          const ratio = contrast(value(theme, foreground), value(theme, background));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const background of ["canvas", "surface", "surface-2"] as const) {
      it(`${name}: the dither's ink on ${background} reads at 3:1 or more`, () => {
        expect(
          contrast(value(theme, "dither-ink"), value(theme, background)),
        ).toBeGreaterThanOrEqual(3);
      });
    }
    for (const status of statusColors) {
      it(`${name}: the ${status} square on the canvas reads at 3:1 or more`, () => {
        expect(contrast(value(theme, status), value(theme, "canvas"))).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it("gives the scripts the durations tokens.css declares", () => {
    for (const token of motionTokens) expect(dark.get(`--${token}`)).toBe(`${motionMs[token]}ms`);
  });

  it("stills every duration under prefers-reduced-motion", () => {
    expect(customProperties(reducedMotion).sort()).toEqual([...motionTokens].sort());
    for (const token of motionTokens) expect(reducedMotion.get(`--${token}`)).toBe("0ms");
  });

  it("self-hosts the face each type token names first, from packages/ui/fonts", () => {
    const faces = rules.filter((r) => r.selector === "@font-face").map((r) => r.declarations);
    const families = faces.map((face) => face.get("font-family"));
    const firstFamily = (token: string): string | undefined => dark.get(token)?.split(",")[0];
    expect(families.sort()).toEqual(
      [firstFamily("--font-text"), firstFamily("--font-measured")].sort(),
    );
    for (const face of faces) {
      const src = face.get("src") ?? "";
      const match = /^url\("\.\.\/\.\.\/fonts\/([a-z-]+)\.woff2"\) format\("woff2"\)$/.exec(src);
      expect(match, src).not.toBeNull();
      expect(face.get("font-display")).toBe("swap");
      // The file itself, and its license beside it: a declaration pointing at nothing falls back
      // to the next face in the stack without a word, so the test looks for the bytes.
      const stem = match?.[1] ?? "";
      const fontsDir = join(srcDir, "..", "fonts");
      const file = statSync(join(fontsDir, `${stem}.woff2`));
      expect(file.size, `${stem}.woff2`).toBeGreaterThan(10_000);
      const bytes = readFileSync(join(fontsDir, `${stem}.woff2`));
      expect(bytes.subarray(0, 4).toString("latin1"), `${stem}.woff2 is WOFF2`).toBe("wOF2");
      const licence = `${stem.replace(/-variable$/, "")}-OFL.txt`;
      expect(readFileSync(join(fontsDir, licence), "utf8"), licence).toContain(
        "SIL Open Font License, Version 1.1",
      );
    }
  });
});

// The face names the tokens give, minus CSS's generic families: what no other file may spell.
function namedFaces(): string[] {
  const generic = new Set(["sans-serif", "serif", "monospace", "ui-monospace", "system-ui"]);
  return ["--font-text", "--font-measured"]
    .flatMap((token) => (dark.get(token) ?? "").split(","))
    .map((face) => face.trim().replace(/^"|"$/g, ""))
    .filter((face) => !generic.has(face));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("no literal outside tokens.css", () => {
  const files = sourceFiles(srcDir).filter((path) => path !== join(tokensDir, "tokens.css"));
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

  it("scans the components and stylesheets of packages/ui", () => {
    const names = files.map((path) => path.slice(srcDir.length + 1));
    expect(names).toEqual(expect.arrayContaining(["dither/Dither.tsx", "tokens/theme.css"]));
  });

  it("finds no color value and no face name in any other file", () => {
    const faces = namedFaces();
    // Both faces and their named fallbacks, so the scan below is not vacuous.
    expect(faces.length).toBeGreaterThanOrEqual(4);
    const offenders = files.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const color = colorLiteral.exec(text);
      const face = faces.find((name) => text.includes(name));
      return [
        ...(color === null ? [] : [`${path}: ${color[0]}`]),
        ...(face === undefined ? [] : [`${path}: ${face}`]),
      ];
    });
    expect(offenders).toEqual([]);
  });
});

describe("theme.css under Tailwind v4", () => {
  // Compiles the theme the way a surface's stylesheet imports it, and asks Tailwind for classes.
  async function build(candidates: string[]): Promise<string> {
    const tailwindDir = join(srcDir, "..", "node_modules", "tailwindcss");
    const compiler = await compile('@import "tailwindcss";\n@import "./theme.css";', {
      base: tokensDir,
      loadStylesheet: async (id, base) => {
        const path = id === "tailwindcss" ? join(tailwindDir, "index.css") : join(base, id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
    return compiler.build(candidates);
  }

  it("maps every color role to a utility that reads its variable", async () => {
    const css = await build(colorRoles.map((role) => `bg-${role}`));
    for (const role of colorRoles) {
      expect(css).toContain(`.bg-${role} {\n    background-color: ${tokenVar(role)};`);
    }
  });

  it("maps the faces, the 4 px grid and the state duration to their tokens", async () => {
    const css = await build(["font-sans", "font-mono", "p-4", "transition-colors"]);
    expect(css).toContain(`font-family: ${tokenVar("font-text")}`);
    expect(css).toContain(`font-family: ${tokenVar("font-measured")}`);
    expect(css).toContain(`padding: calc(${tokenVar("space")} * 4)`);
    expect(css).toContain(tokenVar("motion-state"));
  });

  it("has no class for a color, a radius, a shadow or an animation the brief has no token for", async () => {
    const absent = ["bg-red-500", "text-white", "rounded-md", "shadow-lg", "animate-spin"];
    const css = await build(absent);
    for (const candidate of absent) expect(css).not.toContain(`.${candidate}`);
  });

  it("keeps the weights the type set uses", async () => {
    const css = await build(["font-medium", "font-extrabold"]);
    expect(css).toContain(".font-medium");
    expect(css).toContain(".font-extrabold");
  });
});
