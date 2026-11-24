import { createHash } from "node:crypto";
import type { PluginKind } from "@facetdb/core";
import { PUBLIC_REPOSITORY } from "../public-repository.ts";
import type { RegistryIndex, RegistryListing } from "./registry.ts";

/**
 * The registry's page ("a static site over it: search, a verified badge … and install counts"):
 * `registry/index.html`, written by the registry build beside `index.json`. A pure function of the
 * index and the text of `packages/ui/src/tokens/tokens.css`: the same index gives the same bytes,
 * and the page holds no time of its own.
 *
 * Every field of a listing comes from a pull request, so every one is escaped where it lands, and
 * none reaches the inline script: the script is a constant, its search reads the cells' attributes.
 * The page loads nothing but its two fonts, from its own `fonts/` folder, and its policy says so.
 */

/** The fonts the page loads, from `fonts/` beside it: the files the build copies from `packages/ui/fonts/`. */
export const PAGE_FONTS = [
  "schibsted-grotesk-variable.woff2",
  "martian-mono-variable.woff2",
] as const;

/** The licenses that travel with the fonts. */
export const PAGE_FONT_LICENSES = ["schibsted-grotesk-OFL.txt", "martian-mono-OFL.txt"] as const;

/** Where a plugin author reads how to list one: the registry's README in the public repository. */
export const README_ADDRESS = `https://github.com/${PUBLIC_REPOSITORY}/blob/main/registry/README.md`;

/** Text for HTML text and for a double-quoted attribute alike: the five characters that mean markup. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The kinds as the studio's gallery says them (`kindsWords`, apps/studio/src/features/plugins/
 * words.ts, repeated here since this package does not import the studio): "Source, action,
 * question pack", in the order source, action, channel, provider, pack.
 */
const KIND_WORDS: readonly (readonly [PluginKind, string])[] = [
  ["source", "source"],
  ["action", "action"],
  ["channel", "alert channel"],
  ["provider", "model provider"],
  ["pack", "question pack"],
];

export function kindsWords(kinds: readonly PluginKind[]): string {
  const line = KIND_WORDS.filter(([kind]) => kinds.includes(kind))
    .map(([, words]) => words)
    .join(", ");
  return line.slice(0, 1).toUpperCase() + line.slice(1);
}

const grouped = new Intl.NumberFormat("en-US");

/** A download count as the studio's gallery groups it (`countWords`): "4,210". */
export function countWords(count: number): string {
  return grouped.format(count);
}

/**
 * What a cell's search reads, lowercased: the studio's rule (`matches` in plugins-door.ts: the name,
 * the package, the description and the kinds), plus the kinds in the words the cell shows, so that
 * "alert" finds what reads "Alert channel". Every match of the studio's search is a match here.
 */
export function searchText(listing: RegistryListing): string {
  return [
    listing.name,
    listing.package,
    listing.description,
    ...listing.kinds,
    kindsWords(listing.kinds),
  ]
    .join(" ")
    .toLowerCase();
}

/** "1 plugin", "5 plugins". */
function pluginsWords(count: number): string {
  return count === 1 ? "1 plugin" : `${count} plugins`;
}

/**
 * The page's own rules. They read only the tokens' variables: no color, no face, no duration of
 * their own (registry-page.test.ts holds them to that). The focus is the brief's corner brackets,
 * drawn in `facet-text` as packages/ui's components.css draws them.
 */
export const PAGE_CSS = `
.search[hidden],
.gallery[hidden],
.gallery > article[hidden] {
  display: none;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--canvas);
  color: var(--text);
  font-family: var(--font-text);
  font-size: 14px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 1120px;
  margin: 0 auto;
  padding: 40px 16px 64px;
}
@media (min-width: 720px) {
  main {
    padding: 56px 32px 80px;
  }
}
h1,
h2,
p {
  margin: 0;
}
h1 {
  font-size: 28px;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
h2 {
  font-size: 16px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
a {
  color: var(--facet-text);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
code,
.figure {
  font-family: var(--font-measured);
  font-stretch: var(--font-measured-inline);
  font-size: 12.5px;
}
.lede {
  display: grid;
  gap: 4px;
  max-width: 68ch;
  margin: 8px 0 24px;
  color: var(--text-2);
}
.lede code {
  overflow-wrap: anywhere;
}
.search {
  display: grid;
  gap: 6px;
  max-width: 420px;
  margin-bottom: 12px;
}
.search .field {
  display: block;
}
.search label {
  font-size: 13px;
  color: var(--text-2);
}
.search input {
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font: inherit;
}
.search input:hover {
  border-color: var(--text-3);
}
.count {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-2);
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
  border-top: 1px solid var(--hairline);
  border-left: 1px solid var(--hairline);
}
.gallery > article {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  padding: 18px 20px 20px;
  border-right: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.small {
  font-size: 12.5px;
  color: var(--text-2);
}
.description {
  overflow-wrap: anywhere;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--hairline);
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
}
.tag::before {
  content: "";
  width: 6px;
  height: 6px;
  flex: none;
  background: var(--text-3);
}
.cmd {
  display: flex;
  align-items: stretch;
  min-width: 0;
  margin-top: 6px;
}
.cmd code {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--hairline);
  overflow-wrap: anywhere;
}
.cmd code:not(:last-child) {
  border-right: 0;
}
button {
  height: 30px;
  padding: 0 16px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color var(--motion-state);
}
button:hover {
  border-color: var(--text-3);
}
.note {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
a,
button,
.search .field {
  position: relative;
}
a::after,
button::after,
.search .field::after {
  content: "";
  position: absolute;
  inset: -5px;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--motion-state);
  background:
    linear-gradient(var(--facet-text), var(--facet-text)) left top / 10px 2px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) left top / 2px 10px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) right top / 10px 2px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) right top / 2px 10px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) left bottom / 10px 2px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) left bottom / 2px 10px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) right bottom / 10px 2px no-repeat,
    linear-gradient(var(--facet-text), var(--facet-text)) right bottom / 2px 10px no-repeat;
}
a:focus-visible,
button:focus-visible,
.search input:focus-visible {
  outline: 2px solid transparent;
}
a:focus-visible::after,
button:focus-visible::after,
.search .field:focus-within::after {
  opacity: 1;
}
`;

/**
 * The page's one script, a constant: no listing's text is in it. It shows the search box, filters
 * the cells by every word typed (each cell's `data-search`, see `searchText`), says the count in
 * the status line a screen reader announces, and adds Copy beside each command. Without it the
 * page lists every plugin and the search box stays hidden.
 */
export const PAGE_SCRIPT = `
(() => {
  const box = document.getElementById("search");
  const field = document.getElementById("search-field");
  const count = document.getElementById("count");
  const gallery = document.getElementById("gallery");
  if (box === null || field === null || count === null || gallery === null) return;
  const cells = Array.from(gallery.querySelectorAll("[data-search]"));
  const plugins = (n) => (n === 1 ? "1 plugin" : \`\${n} plugins\`);
  const show = () => {
    const typed = field.value.trim();
    const words = typed.toLowerCase().split(/\\s+/).filter(Boolean);
    let shown = 0;
    for (const cell of cells) {
      const text = cell.getAttribute("data-search") || "";
      const hit = words.every((word) => text.includes(word));
      cell.hidden = !hit;
      if (hit) shown += 1;
    }
    gallery.hidden = shown === 0;
    count.textContent =
      words.length === 0
        ? plugins(cells.length)
        : shown === 0
          ? \`No plugin matches "\${typed}".\`
          : \`\${shown} of \${plugins(cells.length)}\`;
  };
  field.addEventListener("input", show);
  box.hidden = false;
  for (const cell of cells) {
    const code = cell.querySelector("[data-command]");
    if (code === null || code.parentElement === null) continue;
    const command = code.textContent || "";
    const button = document.createElement("button");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", \`Copy \${command}\`);
    button.textContent = "Copy";
    const said = document.createElement("p");
    said.setAttribute("role", "status");
    said.setAttribute("class", "sr-only");
    const copied = () => {
      button.textContent = "Copied";
      button.setAttribute("aria-label", \`Copied \${command}\`);
      said.setAttribute("class", "sr-only");
      said.textContent = \`Copied \${command}\`;
    };
    const refused = () => {
      const selection = window.getSelection();
      if (selection !== null) selection.selectAllChildren(code);
      said.setAttribute("class", "note");
      said.textContent =
        "This browser did not allow copying. The command is selected: press Ctrl+C or Cmd+C.";
    };
    button.addEventListener("click", () => {
      try {
        navigator.clipboard.writeText(command).then(copied, refused);
      } catch {
        refused();
      }
    });
    code.parentElement.append(button);
    code.parentElement.parentElement?.append(said);
  }
})();
`;

/** A CSP hash source of an inline element's text, as the browser computes it over the UTF-8 bytes. */
export function hashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** Where tokens.css loads a face from, relative to itself: `url("../../fonts/<file>")`. */
const FONT_URL = /url\(\s*(["']?)([^"')\s]*)\1\s*\)/g;

/**
 * tokens.css with its fonts loaded from the page's `fonts/`. The text is read from a file this
 * repository owns, yet it is checked here as the page's input: a `url()` that is not one of the
 * fonts the build copies, or text that would end the style element, is refused rather than shipped.
 */
function pageTokens(tokensCss: string): string {
  if (/<\/style/i.test(tokensCss)) {
    throw new Error("tokens.css holds </style, which would end the page's style element");
  }
  if (/@import/i.test(tokensCss)) {
    throw new Error("tokens.css imports another stylesheet, which the page would load");
  }
  return tokensCss.replace(FONT_URL, (_whole, _quote: string, address: string) => {
    const file = address.startsWith("../../fonts/") ? address.slice("../../fonts/".length) : "";
    if (!(PAGE_FONTS as readonly string[]).includes(file)) {
      throw new Error(
        `tokens.css loads ${address}, which is not one of the fonts the registry build copies (${PAGE_FONTS.join(", ")})`,
      );
    }
    return `url("fonts/${file}")`;
  });
}

function cell(listing: RegistryListing): string {
  const id = `plugin-${listing.name}`;
  const downloads = `<span class="figure">${escapeHtml(countWords(listing.downloads))}</span> ${listing.downloads === 1 ? "download" : "downloads"} last month`;
  return [
    `<article aria-labelledby="${escapeHtml(id)}" data-search="${escapeHtml(searchText(listing))}">`,
    `<div class="head"><h2 id="${escapeHtml(id)}">${escapeHtml(listing.name)}</h2>${listing.verified ? '<span class="tag">Verified</span>' : ""}</div>`,
    `<p class="small">${escapeHtml(kindsWords(listing.kinds))}</p>`,
    `<p class="description">${escapeHtml(listing.description)}</p>`,
    `<p class="small">${downloads}</p>`,
    `<div class="cmd"><code data-command>${escapeHtml(`facetdb add ${listing.name}`)}</code></div>`,
    "</article>",
  ].join("\n");
}

/** The page's HTML for an index and the text of tokens.css. */
export function renderRegistryPage(index: RegistryIndex, tokensCss: string): string {
  const style = `\n${pageTokens(tokensCss)}${PAGE_CSS}`;
  const script = PAGE_SCRIPT;
  const policy = [
    "default-src 'none'",
    `style-src ${hashSource(style)}`,
    `script-src ${hashSource(script)}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const total = index.plugins.length;
  const listed =
    total === 0
      ? '<p class="count" id="count" role="status">The registry lists no plugin yet.</p>'
      : [
          `<div class="search" id="search" hidden>`,
          `<label for="search-field">Search</label>`,
          `<span class="field"><input id="search-field" type="search" autocomplete="off" spellcheck="false" maxlength="100"></span>`,
          "</div>",
          `<p class="count" id="count" role="status">${pluginsWords(total)}</p>`,
          `<div class="gallery" id="gallery">`,
          ...index.plugins.map(cell),
          "</div>",
        ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>FacetDB plugins</title>",
    `<style>${style}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>FacetDB plugins</h1>",
    '<div class="lede">',
    `<p>To list a plugin, open a pull request that adds <code>registry/plugins/&lt;name&gt;.json</code>, as <a href="${escapeHtml(README_ADDRESS)}">the registry's README</a> explains.</p>`,
    "<p>A plugin runs inside your worker with its access. Verified ones were reviewed by the FacetDB team.</p>",
    "</div>",
    listed,
    "</main>",
    `<script>${script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
