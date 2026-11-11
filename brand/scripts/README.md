# brand/scripts

Rebuilds every logo, icon, sheet and manifest under `assets/brand/`. One
command:

```sh
node brand/scripts/build.mjs
```

Needs Node ≥ 22.18 (loads `packages/ui/src/brand/tokens.ts` with type
stripping). Tools live outside the repo in `$BRAND_TOOLS` (default
`~/.local/state/bakery/agent-tmp/brand-tools`): `node/node_modules` with `svgo`,
`@resvg/resvg-js`, `sharp`, `potrace`; scratch masks go to `$BRAND_TOOLS/work`.
`magick` must be on PATH (favicon.ico).

Byte-identical rebuilds were verified with these exact versions; other versions
may change encoded bytes:

| tool              | version           |
| ----------------- | ----------------- |
| Node              | 22.22.0           |
| `svgo`            | 4.1.0             |
| `@resvg/resvg-js` | 2.6.2             |
| `sharp`           | 0.35.5            |
| `potrace`         | 2.1.8             |
| ImageMagick       | 7.1.2-30 Q16-HDRI |

| file          | does                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `lib.mjs`     | paths, tokens + `theme.css` readers, WCAG contrast, svgo, render       |
| `pixel.mjs`   | 12/16/24/32 pixel-grid masters, drawn as role letters                  |
| `mark.mjs`    | 512 mark per variant (primitives), mono by tracing cocoa pixels, tiles |
| `trace.mjs`   | masks and potrace of the J3 master: wordmark + character layers        |
| `lockup.mjs`  | lockup and wordmark SVGs per variant                                   |
| `exports.mjs` | PNGs, favicon set, manifest, social cards                              |
| `matrix.mjs`  | contrast matrix, `logo/variants.json`                                  |
| `sheets.mjs`  | `legibility.png`, `variants.png`, `clear-space.png`                    |
| `readme.mjs`  | writes `assets/brand/README.md`                                        |

Single source of truth: colours and role tables from
`packages/ui/src/brand/tokens.ts`; surfaces and ink from
`packages/ui/src/foundations/theme.css`. No hex lives in these scripts.

Checks: `deno fmt --check brand/scripts`, `deno lint brand/scripts`.
