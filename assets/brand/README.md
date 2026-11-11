# Bakery brand assets

Logo colour-variant system. Every logo asset is transparent; only `tile-*` carry a background, by design. Three platform exports are full-bleed and opaque on purpose: `favicon/apple-touch-icon.png`, `favicon/icon-maskable-512.png` and the `social/og-1200x630*.png` cards.
Colours come from tokens, never typed by hand: surfaces and ink from
`packages/ui/src/foundations/theme.css`, brand colours and role tables from
`packages/ui/src/brand/tokens.ts`. Rebuild reads both.

## Variants

| id | use | outline | dough | plate | type | tile |
| --- | --- | --- | --- | --- | --- | --- |
| `color-light` | Default. Light surfaces and canvases, documents, web headers. | #3A1E0E | #F7A93B | #FFF1D6 | #3A1E0E | — |
| `color-dark` | Dark surfaces. Outer outline and wordmark turn warm cream; fills are toned down. | #FBEFDB | #E6992F | #F0E0C4 | #FBEFDB | — |
| `mono-dark` | Single ink for print, embossing and light accent fills. Foundation foreground ink. | #141A24 | — | — | #141A24 | — |
| `mono-light` | Single light ink on dark or saturated fills. Foundation dark-theme foreground. | #F2F4F8 | — | — | #F2F4F8 | — |
| `on-brand` | Brand orange fills. Dough drops out so the surface shows through. | #3A1E0E | — | #FFF1D6 | #3A1E0E | — |
| `tile-light` | App icon, favicon and home-screen tile for light contexts. Mark on a cream rounded tile. | #3A1E0E | #F7A93B | #FFF1D6 | — | #FFF1D6 |
| `tile-dark` | App icon and favicon tile for dark contexts. Mark on a dark-surface rounded tile. | #FBEFDB | #E6992F | #F0E0C4 | — | #12161E |

Roles: `outline` outer silhouette, `line` inner detail on light fills, `feature` eyes and smile,
`dough` head and body, `plate` face and toque, `belt`, `roller`, `blush`, `type` wordmark.
Mono = one ink, knock-outs real: rollers are holes in the belt, cheeks dropped, plate and dough
transparent. `ink` = foundation `color.foreground` light theme; light ink = dark theme.

### Dark treatment

Only the outer outline and the wordmark turn `creamOnDark` #FBEFDB. Lines inside
light fills stay cocoa so toque creases, eyes and smile still read. The belt band stays cocoa,
ringed by the light outline. Fills are pulled down so the mascot does not glow on dark:
golden L 0.485 → doughOnDark L 0.398; cream L 0.890 → plateOnDark L 0.758. Cream outline vs `dark.surface` stays far above 3:1.

## Usage matrix

Recommended variant per surface (first passing in preference order). Mark ratio = outline colour
vs surface, non-text, needs ≥ 3:1. Wordmark ratio = type colour vs surface, needs
≥ 4.5:1. Full matrix, every variant on every surface, in `logo/variants.json`.

| surface | token · hex | recommended | mark (≥ 3:1) | wordmark (≥ 4.5:1) | pass |
| --- | --- | --- | --- | --- | --- |
| `light.surface` | `--color-surface` #FFFFFF | `color-light` | 15.31 | 15.31 | pass |
| `light.canvas` | `--color-canvas` #F5F6F8 | `color-light` | 14.16 | 14.16 | pass |
| `light.surface-subtle` | `--color-surface-subtle` #EEF0F4 | `color-light` | 13.42 | 13.42 | pass |
| `light.primary` | `--color-primary` #141A24 | `color-dark` | 15.35 | 15.35 | pass |
| `light.selection` | `--color-selection` #0B63C6 | `mono-light` | 5.28 | 5.28 | pass |
| `dark.surface` | `--color-surface` #12161E | `color-dark` | 15.93 | 15.93 | pass |
| `dark.canvas` | `--color-canvas` #0B0E14 | `color-dark` | 16.99 | 16.99 | pass |
| `dark.surface-raised` | `--color-surface-raised` #212733 | `color-dark` | 13.17 | 13.17 | pass |
| `dark.primary` | `--color-primary` #F2F4F8 | `color-light` | 13.9 | 13.9 | pass |
| `dark.selection` | `--color-selection` #4A93E6 | `mono-dark` | 5.49 | 5.49 | pass |
| `brand.golden` | `brand.golden` #F7A93B | `on-brand` | 7.79 | 7.79 | pass |

Variants that fail on a surface (do not use there):

- `color-dark` on `light.surface`: mark 1.14:1, wordmark 1.14:1
- `mono-light` on `light.surface`: mark 1.1:1, wordmark 1.1:1
- `color-dark` on `light.canvas`: mark 1.05:1, wordmark 1.05:1
- `mono-light` on `light.canvas`: mark 1.02:1, wordmark 1.02:1
- `color-dark` on `light.surface-subtle`: mark 1:1, wordmark 1:1
- `mono-light` on `light.surface-subtle`: mark 1.04:1, wordmark 1.04:1
- `color-light` on `light.primary`: mark 1.14:1, wordmark 1.14:1
- `mono-dark` on `light.primary`: mark 1:1, wordmark 1:1
- `on-brand` on `light.primary`: mark 1.14:1, wordmark 1.14:1
- `color-light` on `light.selection`: mark 2.63:1, wordmark 2.63:1
- `mono-dark` on `light.selection`: mark 3:1, wordmark 3:1 (wordmark passes large-text 3:1 only)
- `on-brand` on `light.selection`: mark 2.63:1, wordmark 2.63:1
- `color-light` on `dark.surface`: mark 1.18:1, wordmark 1.18:1
- `mono-dark` on `dark.surface`: mark 1.04:1, wordmark 1.04:1
- `on-brand` on `dark.surface`: mark 1.18:1, wordmark 1.18:1
- `color-light` on `dark.canvas`: mark 1.26:1, wordmark 1.26:1
- `mono-dark` on `dark.canvas`: mark 1.11:1, wordmark 1.11:1
- `on-brand` on `dark.canvas`: mark 1.26:1, wordmark 1.26:1
- `color-light` on `dark.surface-raised`: mark 1.02:1, wordmark 1.02:1
- `mono-dark` on `dark.surface-raised`: mark 1.17:1, wordmark 1.17:1
- `on-brand` on `dark.surface-raised`: mark 1.02:1, wordmark 1.02:1
- `color-dark` on `dark.primary`: mark 1.03:1, wordmark 1.03:1
- `mono-light` on `dark.primary`: mark 1:1, wordmark 1:1
- `color-dark` on `dark.selection`: mark 2.8:1, wordmark 2.8:1
- `mono-light` on `dark.selection`: mark 2.89:1, wordmark 2.89:1
- `color-dark` on `brand.golden`: mark 1.73:1, wordmark 1.73:1
- `mono-light` on `brand.golden`: mark 1.78:1, wordmark 1.78:1

Tiles carry their own ground. Check tile fill vs the surface it sits on, and outline vs tile fill.

| tile | on surface | tile vs surface | outline vs tile | pass (≥ 3:1) |
| --- | --- | --- | --- | --- |
| `tile-light` | `light.canvas` | 1.03 | 13.71 | FAIL |
| `tile-dark` | `light.canvas` | 16.75 | 15.93 | pass |
| `tile-light` | `dark.canvas` | 17.3 | 13.71 | pass |
| `tile-dark` | `dark.canvas` | 1.07 | 15.93 | FAIL |

## Minimum sizes (CSS px)

| art | min | rule |
| --- | --- | --- |
| mark | 16 | under 20 px use `mark-16-*`; 30-34 px use `mark-32-*`; every other size uses the 512 art (`sizeRules` in variants.json, first match wins) |
| lockup | 24 tall | below that, drop to mark only |
| wordmark | 16 tall | below that, drop to mark only |

Never scale the 16/32 masters off their size band; they are pixel-grid art.

## Clear space

`x = 0.25 × mark height`. Keep ≥ 1x clear on every side of mark, lockup and wordmark. Lockup uses
the character height as mark height. Diagram: `sheets/clear-space.png`.

## Files

```
assets/brand/
  logo/
    variants.json                 machine contract: palette, surfaces, files, matrix
    mark/mark-<variant>.svg       512 art, 7 variants
    mark/mark-32-<variant>.svg    optical 32 master (tiles: 24 art on a 32 tile)
    mark/mark-16-<variant>.svg    optical 16 master (tiles: 12 art on a 16 tile)
    lockup/lockup-<variant>.svg   color-light, color-dark, mono-dark, mono-light, on-brand
    wordmark/wordmark-<variant>.svg  color-light, color-dark, mono-dark, mono-light (on-brand = color-light)
    png/mark-<variant>-<size>.png
        color-light, color-dark, tile-light, tile-dark: 16 32 48 64 128 180 192 256 512 1024
        others: 64 256 1024
    png/lockup-<variant>-h<64|128|256|512>.png
    png/wordmark-<variant>-h<64|128|256>.png
  favicon/  favicon.svg (prefers-color-scheme) favicon.ico (16 32 48) apple-touch-icon.png (180)
            icon-192.png icon-512.png icon-maskable-512.png icon-dark-192.png icon-dark-512.png
            site.webmanifest
  social/   og-1200x630.png og-1200x630-dark.png
  sheets/   legibility.png variants.png clear-space.png
```

Sheets: `sheets/legibility.png` (every surface, actual 16/24/32 px and 6× nearest, old favicons
as "before"), `sheets/variants.png` (each variant on its recommended surfaces, with ratios).

## Rebuild

```sh
node brand/scripts/build.mjs
```

Needs `BRAND_TOOLS` (default `~/.local/state/bakery/agent-tmp/brand-tools`). See
`brand/scripts/README.md`. Wordmark and character trace from
`brand/raw/001-logo-refine/001-logo-refine-3.png`; mark is rebuilt from primitives.

## Provenance

Source images, prompts and licences: `assets/brand/credits.json`.
