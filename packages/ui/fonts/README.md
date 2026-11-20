# The faces of FacetDB's UI, self-hosted

The UI has two faces, both under the SIL Open Font License 1.1, and self-hosts them (no
third-party font requests). `src/tokens/tokens.css` declares
them with `@font-face` and loads exactly these files, relative to itself (`../../fonts/`):

| File | Face | Axes the `@font-face` declares |
| --- | --- | --- |
| `schibsted-grotesk-variable.woff2` | Schibsted Grotesk, upright, variable | weight 400 to 900 |
| `martian-mono-variable.woff2` | Martian Mono, variable | weight 100 to 800, width 75% to 112.5% |
| `schibsted-grotesk-OFL.txt` | The license and copyright of Schibsted Grotesk, as shipped with it | |
| `martian-mono-OFL.txt` | The license and copyright of Martian Mono, as shipped with it | |

## Where they come from

- Schibsted Grotesk: `ofl/schibstedgrotesk/SchibstedGrotesk[wght].ttf` and
  `ofl/schibstedgrotesk/OFL.txt` in the Google Fonts repository (github.com/google/fonts); the
  upstream project is github.com/schibsted/schibsted-grotesk.
- Martian Mono: `ofl/martianmono/MartianMono[wdth,wght].ttf` and `ofl/martianmono/OFL.txt` in the
  same repository; the upstream project is github.com/evilmartians/mono.

Each `.ttf` becomes its `.woff2` unchanged but for the container (`woff2_compress` from
github.com/google/woff2), renamed as in the table; each `OFL.txt` is copied as is under the name
above. The upright Schibsted Grotesk only: the product sets no italic.

## Status

The four files are in this directory (from the Google Fonts
repository). `src/tokens/tokens.test.ts` checks each `@font-face` points at a WOFF2
file here of real size with its OFL copy beside it, so a missing file fails the tests instead of
falling back to the next face in the stack without a word.
