import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { type RegistryIndex, readRegistryIndex } from "./registry.ts";
import {
  closingLine,
  type Fetch,
  REGISTRY_PAGE_FILES,
  writeRegistryIndex,
} from "./registry-build.ts";
import {
  countWords,
  kindsWords,
  PAGE_CSS,
  PAGE_FONT_LICENSES,
  PAGE_FONTS,
  PAGE_SCRIPT,
  README_ADDRESS,
  renderRegistryPage,
} from "./registry-page.ts";

const registryFolder = fileURLToPath(new URL("../../../../registry/", import.meta.url));
const uiFolder = fileURLToPath(new URL("../../../ui/", import.meta.url));
const tokensCss = await readFile(join(uiFolder, "src", "tokens", "tokens.css"), "utf8");

/** An index as the reader takes it from a file: every listing passes the boundary's schema. */
function indexOf(plugins: readonly Record<string, unknown>[]): RegistryIndex {
  return readRegistryIndex(
    JSON.stringify({ format: 1, generatedAt: "2026-11-13T09:00:00.000Z", plugins }),
  );
}

const ACME = {
  name: "acme",
  package: "facetdb-plugin-acme",
  description: "Send record notifications to Acme.",
  kinds: ["action", "channel"],
  facetdb: "^1.0.0",
  verified: false,
  homepage: "https://example.com/acme",
  downloads: 4210,
};
const GITHUB = {
  name: "github",
  package: "@facetdb/github",
  description: "Read GitHub issues as records.",
  kinds: ["action", "pack", "source"],
  facetdb: "^1.0.0",
  verified: true,
  downloads: 1,
};
const SLACK = {
  name: "slack",
  package: "@facetdb/slack",
  description: "Send system alerts to a Slack channel.",
  kinds: ["channel"],
  facetdb: "^1.0.0",
  verified: true,
  downloads: 0,
};
/** A description from a pull request that tries every way out of the text it is shown as. */
const HOSTILE =
  `</p><script>alert(1)</script><img src=x onerror=alert(2)> "quoted" 'single' & ` +
  `</style></script><!-- --> data-x="y" &amp; javascript:alert(3)`;
const EVIL = { ...ACME, name: "evil", package: "facetdb-plugin-evil", description: HOSTILE };

// ---------------------------------------------------------------------------------------------
// A reader for the page this module writes, and the few DOM calls its script makes, as handwritten
// fakes: enough HTML for a generated file whose shape the tests own, nothing more.

class FakeText {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeElement {
  readonly tag: string;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  parentElement: FakeElement | null = null;
  value = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(hidden: boolean) {
    if (hidden) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }
  get textContent(): string {
    return this.children
      .map((child) => (child instanceof FakeText ? child.text : child.textContent))
      .join("");
  }
  set textContent(text: string) {
    this.children.length = 0;
    this.children.push(new FakeText(String(text)));
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        yield child;
        yield* child.descendants();
      }
    }
  }
  /** Only the selectors the page's script uses: `[attribute]`. */
  querySelectorAll(selector: string): FakeElement[] {
    const attribute = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    if (attribute === undefined) throw new Error(`the fake DOM does not read ${selector}`);
    return [...this.descendants()].filter((element) => element.attributes.has(attribute));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  byTag(tag: string): FakeElement[] {
    return [...this.descendants()].filter((element) => element.tag === tag);
  }
  byId(id: string): FakeElement | null {
    return [...this.descendants()].find((element) => element.getAttribute("id") === id) ?? null;
  }
  /** Whether this element or one around it is hidden. */
  get shown(): boolean {
    for (let at: FakeElement | null = this; at !== null; at = at.parentElement) {
      if (at.hidden) return false;
    }
    return true;
  }
}

const VOID = new Set(["meta", "input", "br", "link", "img"]);
const RAW = new Set(["style", "script"]);

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_whole, name: string) => {
    const decoded: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      "#39": "'",
    };
    return decoded[name] ?? "";
  });
}

/** The page as a tree: tags, attributes (quoted or bare), text, and style and script as raw text. */
function parse(html: string): FakeElement {
  const root = new FakeElement("#document");
  let at = root;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!doctype html>", i)) {
      i += "<!doctype html>".length;
    } else if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const tag = html.slice(i + 2, end);
      if (tag !== at.tag) throw new Error(`</${tag}> closes <${at.tag}>`);
      at = at.parentElement ?? root;
      i = end + 1;
    } else if (html[i] === "<") {
      const tag = /^<([a-z0-9]+)/.exec(html.slice(i))?.[1];
      if (tag === undefined) throw new Error(`a < that opens no tag at ${i}`);
      const element = new FakeElement(tag);
      i += tag.length + 1;
      const attribute = /^\s+([a-z-]+)(?:="([^"]*)")?/;
      for (let m = attribute.exec(html.slice(i)); m !== null; m = attribute.exec(html.slice(i))) {
        element.attributes.set(m[1] as string, decode(m[2] ?? ""));
        i += m[0].length;
      }
      if (html[i] !== ">") throw new Error(`<${tag}> does not close where its attributes end`);
      i += 1;
      at.append(element);
      if (RAW.has(tag)) {
        const end = html.indexOf(`</${tag}>`, i);
        element.children.push(new FakeText(html.slice(i, end)));
        i = end + `</${tag}>`.length;
      } else if (!VOID.has(tag)) {
        at = element;
      }
    } else {
      const end = html.indexOf("<", i);
      const text = html.slice(i, end === -1 ? html.length : end);
      at.children.push(new FakeText(decode(text)));
      i += text.length;
    }
  }
  if (at !== root) throw new Error(`<${at.tag}> is never closed`);
  return root;
}

/** The page with its script run over the fake DOM, and the clipboard's answer chosen by the test. */
function run(html: string, clipboard: "allows" | "refuses" = "allows") {
  const page = parse(html);
  const copied: string[] = [];
  let selected: FakeElement | null = null;
  const document = {
    getElementById: (id: string) => page.byId(id),
    createElement: (tag: string) => new FakeElement(tag),
  };
  const navigator = {
    clipboard: {
      writeText: (text: string) => {
        if (clipboard === "refuses") return Promise.reject(new Error("not allowed"));
        copied.push(text);
        return Promise.resolve();
      },
    },
  };
  const window = {
    getSelection: () => ({
      selectAllChildren: (node: FakeElement) => {
        selected = node;
      },
    }),
  };
  const [script] = page.byTag("script");
  if (script === undefined) throw new Error("the page has no script");
  runInNewContext(script.textContent, { document, navigator, window });
  const field = page.byId("search-field");
  const count = page.byId("count");
  if (field === null || count === null) throw new Error("the page has no search field or count");
  return {
    page,
    copied,
    selected: () => selected,
    count,
    type: (words: string) => {
      field.value = words;
      field.fire("input");
    },
    shownNames: () =>
      page
        .byTag("article")
        .filter((article) => article.shown)
        .map((article) => article.byTag("h2")[0]?.textContent),
  };
}

function cellOf(page: FakeElement, name: string): FakeElement {
  const cell = page
    .byTag("article")
    .find((article) => article.byTag("h2")[0]?.textContent === name);
  if (cell === undefined) throw new Error(`no cell for ${name}`);
  return cell;
}

/** The text of each paragraph and line of a cell, in order. */
function linesOf(cell: FakeElement): string[] {
  return [...cell.descendants()]
    .filter((element) => ["h2", "span", "p", "code"].includes(element.tag))
    .map((element) => element.textContent);
}

// ---------------------------------------------------------------------------------------------

describe("the registry page", () => {
  const html = renderRegistryPage(indexOf([ACME, GITHUB, SLACK]), tokensCss);

  it("shows each listing's fields in its cell, and Verified on verified entries alone", () => {
    const page = parse(html);
    expect(page.byTag("h1")[0]?.textContent).toBe("FacetDB plugins");
    expect(page.byTag("title")[0]?.textContent).toBe("FacetDB plugins");
    expect(page.byTag("article").map((cell) => cell.byTag("h2")[0]?.textContent)).toEqual([
      "acme",
      "github",
      "slack",
    ]);

    const acme = cellOf(page, "acme");
    expect(linesOf(acme)).toEqual([
      "acme",
      "Action, alert channel",
      "Send record notifications to Acme.",
      "4,210 downloads last month",
      "4,210",
      "facetdb add acme",
    ]);
    expect(acme.textContent).not.toContain("Verified");

    const github = cellOf(page, "github");
    expect(linesOf(github)).toEqual([
      "github",
      "Verified",
      "Source, action, question pack",
      "Read GitHub issues as records.",
      "1 download last month",
      "1",
      "facetdb add github",
    ]);
    expect(cellOf(page, "slack").textContent).toContain("Verified");
    expect(cellOf(page, "slack").textContent).toContain("0 downloads last month");
    // The verified mark is a word, never a color alone.
    expect(page.byTag("span").filter((span) => span.getAttribute("class") === "tag")).toHaveLength(
      2,
    );
  });

  it("says the kinds and the counts in the studio gallery's words", () => {
    expect(kindsWords(["pack", "channel", "source", "provider", "action"])).toBe(
      "Source, action, alert channel, model provider, question pack",
    );
    expect(countWords(4210)).toBe("4,210");
    expect(countWords(1234567)).toBe("1,234,567");
  });

  it("says how to list a plugin, linking the README in the public repository", () => {
    const page = parse(html);
    const [lede] = page.byTag("p");
    expect(lede?.textContent).toBe(
      "To list a plugin, open a pull request that adds registry/plugins/<name>.json, as the registry's README explains.",
    );
    const links = page.byTag("a");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([README_ADDRESS]);
    expect(README_ADDRESS).toBe("https://github.com/facet-db/facetdb/blob/main/registry/README.md");
  });

  it("shows every text from an entry as text: no markup, attribute or script of its own", () => {
    const hostile = renderRegistryPage(indexOf([EVIL, GITHUB]), tokensCss);
    // One script element, one style element, and nothing from the entry opens a tag.
    expect(hostile.match(/<script/g)).toHaveLength(1);
    expect(hostile.match(/<style/g)).toHaveLength(1);
    expect(hostile.match(/<\/script/g)).toHaveLength(1);
    expect(hostile.match(/<\/style/g)).toHaveLength(1);
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toContain("<!--");
    // Every < in the page opens or closes one of the page's own tags.
    const tags = new Set([...hostile.matchAll(/<\/?([^\s>]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(
      [
        "!doctype",
        "a",
        "article",
        "body",
        "code",
        "div",
        "h1",
        "h2",
        "head",
        "html",
        "input",
        "label",
        "main",
        "meta",
        "p",
        "script",
        "span",
        "style",
        "title",
      ].sort(),
    );
    expect(hostile).toContain(
      "&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt; &quot;quoted&quot; &#39;single&#39; &amp; ",
    );

    const page = parse(hostile);
    const cell = cellOf(page, "evil");
    const description = cell.byTag("p").find((p) => p.getAttribute("class") === "description");
    expect(description?.children).toEqual([new FakeText(HOSTILE)]);
    // The search's attribute holds the text whole and adds no attribute of its own.
    expect([...cell.attributes.keys()]).toEqual(["aria-labelledby", "data-search"]);
    expect(cell.getAttribute("data-search")).toContain(HOSTILE.toLowerCase());
    // The script is the page's constant: no listing's text is in it.
    expect(page.byTag("script")[0]?.textContent).toBe(PAGE_SCRIPT);

    // What a visitor types is said back as text too.
    const { count, type } = run(hostile);
    type("<b>nothing</b>");
    expect(count.children).toEqual([new FakeText('No plugin matches "<b>nothing</b>".')]);
  });

  it("lists every plugin with the script off, and keeps the search box hidden", () => {
    const page = parse(html);
    const articles = page.byTag("article");
    expect(articles).toHaveLength(3);
    for (const article of articles) expect(article.shown).toBe(true);
    expect(page.byId("search")?.hidden).toBe(true);
    expect(page.byId("count")?.textContent).toBe("3 plugins");
    // Copy is the script's: without it there is no button that does nothing.
    expect(page.byTag("button")).toEqual([]);
  });

  it("finds by every word typed, in the name, the package, the description or the kinds, and says the count", () => {
    const page = run(html);
    expect(page.page.byId("search")?.hidden).toBe(false);
    expect(page.count.getAttribute("role")).toBe("status");
    expect(page.shownNames()).toEqual(["acme", "github", "slack"]);

    page.type("SLACK");
    expect(page.shownNames()).toEqual(["slack"]);
    expect(page.count.textContent).toBe("1 of 3 plugins");

    page.type("@facetdb/");
    expect(page.shownNames()).toEqual(["github", "slack"]);
    expect(page.count.textContent).toBe("2 of 3 plugins");

    page.type("channel");
    expect(page.shownNames()).toEqual(["acme", "slack"]);
    // The kinds in the words the cell shows find it too.
    page.type("question pack");
    expect(page.shownNames()).toEqual(["github"]);

    page.type("  send   acme ");
    expect(page.shownNames()).toEqual(["acme"]);

    page.type("send zendesk");
    expect(page.shownNames()).toEqual([]);
    expect(page.page.byId("gallery")?.hidden).toBe(true);
    expect(page.count.textContent).toBe('No plugin matches "send zendesk".');

    page.type("");
    expect(page.shownNames()).toEqual(["acme", "github", "slack"]);
    expect(page.page.byId("gallery")?.hidden).toBe(false);
    expect(page.count.textContent).toBe("3 plugins");
  });

  it("adds Copy beside each command, and says it copied, or selects the command where copying is refused", async () => {
    const allowed = run(html);
    const acme = cellOf(allowed.page, "acme");
    const [button] = acme.byTag("button");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy facetdb add acme");
    expect(button?.textContent).toBe("Copy");
    button?.fire("click");
    await Promise.resolve();
    await Promise.resolve();
    expect(allowed.copied).toEqual(["facetdb add acme"]);
    expect(button?.textContent).toBe("Copied");
    const said = acme.byTag("p").find((p) => p.getAttribute("role") === "status");
    expect(said?.textContent).toBe("Copied facetdb add acme");

    const refused = run(html, "refuses");
    const slack = cellOf(refused.page, "slack");
    slack.byTag("button")[0]?.fire("click");
    await new Promise((resolve) => setImmediate(resolve));
    expect(refused.selected()).toBe(slack.querySelector("[data-command]"));
    const note = slack.byTag("p").find((p) => p.getAttribute("role") === "status");
    expect(note?.getAttribute("class")).toBe("note");
    expect(note?.textContent).toBe(
      "This browser did not allow copying. The command is selected: press Ctrl+C or Cmd+C.",
    );
  });

  it("takes the keyboard alone: native controls in reading order, no tabindex", () => {
    const { page } = run(html);
    expect(html).not.toContain("tabindex");
    const controls = [...page.descendants()].filter((element) =>
      ["a", "input", "button", "select", "textarea"].includes(element.tag),
    );
    expect(controls.map((control) => control.tag)).toEqual([
      "a",
      "input",
      "button",
      "button",
      "button",
    ]);
    expect(page.byTag("label")[0]?.getAttribute("for")).toBe("search-field");
    expect(page.byTag("label")[0]?.textContent).toBe("Search");
  });

  it("says when the registry lists no plugin, with no search", () => {
    const page = parse(renderRegistryPage(indexOf([]), tokensCss));
    expect(page.byId("count")?.textContent).toBe("The registry lists no plugin yet.");
    expect(page.byId("search")).toBeNull();
    expect(page.byTag("article")).toEqual([]);
  });
});

describe("what the page loads and runs", () => {
  /** The page over a hostile entry, read: its style, its script and its policy's directives. */
  function loaded() {
    const html = renderRegistryPage(indexOf([EVIL, GITHUB, SLACK]), tokensCss);
    const page = parse(html);
    const policy =
      page
        .byTag("meta")
        .find((meta) => meta.getAttribute("http-equiv") === "Content-Security-Policy")
        ?.getAttribute("content") ?? "";
    const directives = new Map(
      policy.split(";").map((directive) => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values.join(" ")] as const;
      }),
    );
    return {
      html,
      page,
      style: page.byTag("style")[0]?.textContent ?? "",
      script: page.byTag("script")[0]?.textContent ?? "",
      directives,
    };
  }
  const sha256 = (text: string) =>
    `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  it("holds a policy that allows only its own style and script, by their hashes, and fonts from its own origin", () => {
    const { html, style, script, directives } = loaded();
    expect([...directives.keys()]).toEqual([
      "default-src",
      "style-src",
      "script-src",
      "font-src",
      "base-uri",
      "form-action",
    ]);
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("style-src")).toBe(sha256(style));
    expect(directives.get("script-src")).toBe(sha256(script));
    expect(directives.get("font-src")).toBe("'self'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'none'");
    // The policy is read before the style and the script it rules.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<style>"));
  });

  it("loads nothing from another origin: only its two fonts, from fonts/ beside it", () => {
    const { page, style } = loaded();
    const addresses = [...style.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(addresses).toEqual(PAGE_FONTS.map((font) => `"fonts/${font}"`));
    expect(style).not.toMatch(/@import/);
    for (const element of page.descendants()) {
      expect(element.attributes.has("src"), element.tag).toBe(false);
      expect(element.attributes.has("style"), element.tag).toBe(false);
      expect([...element.attributes.keys()].some((name) => name.startsWith("on"))).toBe(false);
      expect(["link", "img", "iframe", "object", "embed", "form", "base"]).not.toContain(
        element.tag,
      );
    }
    // The one address is a link a visitor follows, over https, to the public repository.
    const hrefs = [...page.descendants()].flatMap((element) => {
      const href = element.getAttribute("href");
      return href === null ? [] : [href];
    });
    expect(hrefs).toEqual([README_ADDRESS]);
    expect(page.byTag("meta").find((m) => m.getAttribute("name") === "referrer")).toBeDefined();
  });

  it("refuses tokens that would load another address or end the style element", () => {
    expect(() =>
      renderRegistryPage(indexOf([]), tokensCss.replace("../../fonts/", "https://fonts.example/")),
    ).toThrow(/not one of the fonts the registry build copies/);
    expect(() => renderRegistryPage(indexOf([]), `${tokensCss}\n</style><script>`)).toThrow(
      /<\/style/,
    );
    expect(() => renderRegistryPage(indexOf([]), `@import "x.css";\n${tokensCss}`)).toThrow(
      /imports another stylesheet/,
    );
  });

  it("gives the same bytes for the same plugins, whenever the index was generated", () => {
    const at = (generatedAt: string) =>
      readRegistryIndex(JSON.stringify({ format: 1, generatedAt, plugins: [GITHUB, SLACK] }));
    const first = renderRegistryPage(at("2026-11-13T09:00:00.000Z"), tokensCss);
    expect(renderRegistryPage(at("2027-01-01T00:00:00.000Z"), tokensCss)).toBe(first);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("the page's own rules", () => {
  /** Each declaration of the page's own rules: property and value, comments dropped. */
  const declarations = [
    ...PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g),
  ].map((m) => ({ property: m[1] as string, value: (m[2] as string).trim().replace(/\s+/g, " ") }));

  it("name no color, face or duration: only the tokens' variables", () => {
    expect(declarations.length).toBeGreaterThan(50);
    expect(PAGE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(PAGE_CSS).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
    expect(PAGE_CSS).not.toMatch(/\burl\(|@import|@font-face/);
    // Every duration is a motion token, so reduced motion stills the page.
    expect(PAGE_CSS).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
    const colorBearing =
      /^(?:color|background|background-color|border|border-[a-z-]+|outline|outline-color|text-decoration-color|caret-color|fill|stroke)$/;
    // What a color-bearing value may hold besides var(--…): sizes, styles, and gradient positions.
    const allowed =
      /^(?:\d+(?:\.\d+)?(?:px)?|0|solid|transparent|none|currentcolor|linear-gradient\(|\)|,|\/|left|right|top|bottom|no-repeat)$/i;
    for (const { property, value } of declarations) {
      if (property === "font-family") expect(value).toMatch(/^var\(--[a-z-]+\)$/);
      if (property === "font") expect(value).toBe("inherit");
      if (!colorBearing.test(property)) continue;
      const words = value
        .replace(/var\(--[a-z0-9-]+\)/g, " ")
        .replace(/([(),/])/g, " $1 ")
        .replace(/linear-gradient \(/g, "linear-gradient( ")
        .split(/\s+/)
        .filter(Boolean);
      for (const word of words) expect(word, `${property}: ${value}`).toMatch(allowed);
    }
  });

  it("read at 4.5:1 for every text color on the canvas, in light and dark, as the tokens give them", () => {
    const themeOf = (block: string): Map<string, string> =>
      new Map(
        [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [
          m[1] as string,
          m[2] as string,
        ]),
      );
    const dark = themeOf(/:root \{([\s\S]*?)\}/.exec(tokensCss)?.[1] ?? "");
    const light = themeOf(
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\}/.exec(
        tokensCss,
      )?.[1] ?? "",
    );
    const luminance = (hex: string): number => {
      const channel = (offset: number): number => {
        const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };
    // The page has one ground, the canvas: no other background is a surface text sits on.
    const backgrounds = declarations
      .filter(({ property }) => property === "background")
      .map(({ value }) => value);
    expect(backgrounds.filter((value) => !value.startsWith("linear-gradient"))).toEqual([
      "var(--canvas)",
      "transparent",
      "var(--text-3)",
      "transparent",
    ]);
    const textRoles = [
      ...new Set(
        declarations
          .filter(({ property }) => property === "color")
          .map(({ value }) => /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1] ?? value),
      ),
    ];
    expect(textRoles.sort()).toEqual(["facet-text", "text", "text-2"]);
    // The focus brackets and the tag's square are marks, held to 3:1.
    const marks = ["facet-text", "text-3"];
    for (const [name, theme] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      const canvas = theme.get("canvas") ?? "";
      expect(canvas, name).toMatch(/^#/);
      for (const role of textRoles) {
        expect(contrast(theme.get(role) ?? "", canvas), `${name}: ${role}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      for (const role of marks) {
        expect(contrast(theme.get(role) ?? "", canvas), `${name}: ${role}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });

  it("keep a phone's width: a 16px gutter and cells that shrink to it", () => {
    expect(PAGE_CSS).toContain("padding: 40px 16px 64px;");
    expect(PAGE_CSS).toContain("minmax(min(260px, 100%), 1fr)");
    const widths = declarations.filter(({ property }) => property === "min-width");
    for (const { value } of widths) expect(value).toBe("0");
    expect(PAGE_CSS).toContain("overflow-wrap: anywhere;");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the build writes the page beside the index", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });

  const NOW = new Date("2026-11-13T09:00:00.000Z");

  async function registryWith(
    entries: readonly Record<string, unknown>[],
    index?: string,
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "registry-page-"));
    folders.push(root);
    const folder = join(root, "registry");
    await mkdir(join(folder, "plugins"), { recursive: true });
    for (const entry of entries) {
      await writeFile(
        join(folder, "plugins", `${String(entry["name"])}.json`),
        JSON.stringify(entry),
      );
    }
    if (index !== undefined) await writeFile(join(folder, "index.json"), index);
    return folder;
  }

  /** A `fetch` that counts every package at the given figure and remembers what it was asked. */
  function npmAt(downloads: number): { fetch: Fetch; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      fetch: async (url) => {
        asked.push(url);
        return new Response(JSON.stringify({ downloads }));
      },
    };
  }

  const entryOf = ({ downloads: _downloads, ...entry }: Record<string, unknown>) => entry;

  it("writes index.json, index.html and the fonts, and a second build with no change leaves every one alone", async () => {
    const folder = await registryWith([entryOf(ACME), entryOf(GITHUB)]);
    const npm = npmAt(7);
    const first = await writeRegistryIndex({
      folder,
      ui: uiFolder,
      fetch: npm.fetch,
      offline: false,
      now: () => NOW,
    });
    expect(first.written).toEqual(["index.json", ...REGISTRY_PAGE_FILES]);
    expect((await readdir(join(folder, "fonts"))).sort()).toEqual(
      [...PAGE_FONTS, ...PAGE_FONT_LICENSES].sort(),
    );
    for (const font of [...PAGE_FONTS, ...PAGE_FONT_LICENSES]) {
      expect(
        (await readFile(join(folder, "fonts", font))).equals(
          await readFile(join(uiFolder, "fonts", font)),
        ),
      ).toBe(true);
    }
    const page = await readFile(join(folder, "index.html"), "utf8");
    expect(page).toBe(renderRegistryPage(first.index, tokensCss));

    const files = ["index.json", ...REGISTRY_PAGE_FILES];
    const before = await Promise.all(
      files.map(async (file) => ({
        bytes: await readFile(join(folder, file)),
        mtime: (await stat(join(folder, file))).mtimeMs,
      })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const offline of [false, true]) {
      const again = await writeRegistryIndex({
        folder,
        ui: uiFolder,
        fetch: npm.fetch,
        offline,
        now: () => new Date("2027-01-01T00:00:00.000Z"),
      });
      expect(again.written).toEqual([]);
      expect(closingLine(again, offline)).toBe(
        `registry/ is already up to date: 2 plugins, with ${offline ? "the committed" : "npm's"} download counts.`,
      );
    }
    const after = await Promise.all(
      files.map(async (file) => ({
        bytes: await readFile(join(folder, file)),
        mtime: (await stat(join(folder, file))).mtimeMs,
      })),
    );
    expect(after).toEqual(before);
  });

  it("offline, keeps each committed count and asks the fake fetch nothing; a package with none is listed at 0 and named", async () => {
    const committed = await registryWith([entryOf(ACME), entryOf(GITHUB)]);
    await writeRegistryIndex({
      folder: committed,
      ui: uiFolder,
      fetch: async (url) =>
        new Response(JSON.stringify({ downloads: url.endsWith("acme") ? 4210 : 31 })),
      offline: false,
      now: () => NOW,
    });
    const indexText = await readFile(join(committed, "index.json"), "utf8");

    // An entry changed and one added since: the index is rewritten, every committed count kept.
    const folder = await registryWith(
      [{ ...entryOf(ACME), description: "Changed." }, entryOf(GITHUB), entryOf(SLACK)],
      indexText,
    );
    const npm = npmAt(999);
    const result = await writeRegistryIndex({
      folder,
      ui: uiFolder,
      fetch: npm.fetch,
      offline: true,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    expect(npm.asked).toEqual([]);
    expect(result.index.plugins.map((plugin) => [plugin.name, plugin.downloads])).toEqual([
      ["acme", 4210],
      ["github", 31],
      ["slack", 0],
    ]);
    expect(result.uncounted).toEqual(["@facetdb/slack"]);
    expect(result.written).toEqual(["index.json", ...REGISTRY_PAGE_FILES]);
    expect(closingLine(result, true)).toBe(
      "Wrote registry/index.json, registry/index.html, registry/fonts/schibsted-grotesk-variable.woff2, registry/fonts/martian-mono-variable.woff2, registry/fonts/schibsted-grotesk-OFL.txt, registry/fonts/martian-mono-OFL.txt: 3 plugins, with the committed download counts. No committed count for @facetdb/slack, listed at 0 until the build with the network (registry:build) refreshes the counts.",
    );
    const written = readRegistryIndex(await readFile(join(folder, "index.json"), "utf8"));
    expect(written.plugins.map((plugin) => plugin.downloads)).toEqual([4210, 31, 0]);
  });

  it("offline, stops on a committed index it cannot read, and writes nothing", async () => {
    const folder = await registryWith([entryOf(ACME)], '{ "format": 1, "plugins": "lost" }');
    const npm = npmAt(5);
    await expect(
      writeRegistryIndex({ folder, ui: uiFolder, fetch: npm.fetch, offline: true, now: () => NOW }),
    ).rejects.toThrow(
      /The offline build cannot read the committed download counts[\s\S]*restore registry\/index\.json from git/,
    );
    expect(npm.asked).toEqual([]);
    expect((await readdir(folder)).sort()).toEqual(["index.json", "plugins"]);
  });

  it("with the network, says it read npm's counts", async () => {
    const folder = await registryWith([entryOf(SLACK)]);
    const result = await writeRegistryIndex({
      folder,
      ui: uiFolder,
      fetch: npmAt(3).fetch,
      offline: false,
      now: () => NOW,
    });
    expect(closingLine(result, false)).toMatch(
      /^Wrote registry\/index\.json, .*: 1 plugin, with npm's download counts\.$/,
    );
  });
});

describe("the committed registry page", () => {
  it("is what the renderer makes of the committed index.json", async () => {
    const index = readRegistryIndex(await readFile(join(registryFolder, "index.json"), "utf8"));
    const committed = await readFile(join(registryFolder, "index.html"), "utf8");
    expect(committed).toBe(renderRegistryPage(index, tokensCss));
  });

  it("carries the fonts of packages/ui, byte for byte", async () => {
    for (const font of [...PAGE_FONTS, ...PAGE_FONT_LICENSES]) {
      const committed = await readFile(join(registryFolder, "fonts", font));
      expect(committed.equals(await readFile(join(uiFolder, "fonts", font))), font).toBe(true);
    }
    expect((await readdir(join(registryFolder, "fonts"))).sort()).toEqual(
      [...PAGE_FONTS, ...PAGE_FONT_LICENSES].sort(),
    );
  });
});
