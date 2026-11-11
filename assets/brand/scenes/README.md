# Character scenes

One picked illustration per screen, exported for light and dark surfaces. Transparent outside
the blob; the blob is the spot-illustration ground. Manifest: [`scenes.json`](scenes.json).
Overview: [`contact-sheet.png`](contact-sheet.png) (light on `--color-surface` light, dark on
`--color-surface` dark).

## Files, per `<screen>/`

| file                                 | size     | use                                 |
| ------------------------------------ | -------- | ----------------------------------- |
| `<screen>-light.webp` / `-dark.webp` | 1200 px  | default (1600 px for `sign-in-hero`) |
| `<screen>-light-600.webp` / `-dark-600.webp` | 600 px | small slots, retina-1x          |
| `<screen>-light.png` / `-dark.png`   | 1200 px  | fallback; alpha, 48-colour palette   |

No SVG: see below. Pick light or dark by theme; never bake a white box.

## Pipeline

`node brand/scripts/scenes.mjs [screen-id ...]` (reads `brand/raw/`, tokens from
`packages/ui/src/brand/tokens.ts`, surfaces from `packages/ui/src/foundations/theme.css`;
helpers from `brand/scripts/lib.mjs`). Needs the brand-tools dir (`BRAND_TOOLS`).

1. **Cutout.** Flood fill from the border over near-white (min channel ≥ 243) = outside. Flood
   again over near-white + cream = ground (outside + blob). Blob edge ramps to transparent over
   ≤ 32 px; white features inside the blob (steam, flour) stay opaque. Blob colour in light =
   source cream.
2. **Outline.** Cocoa = median of the darkest pixels. Per-pixel cocoa coverage from projection
   against a local non-cocoa average (box blur), so anti-aliasing survives. Outline fringe next
   to the outside is unmixed to cocoa at alpha = coverage (no white halo).
3. **Dark.** Blob → `#3F3934` = dark `--color-surface-raised` (#212733) mixed 14 % toward brand
   golden (#F7A93B). Outer outline band — outline pixels within one outline width (+ AA) of the
   ground, measured per image (20th-percentile core run, 13–29 px at raw size) — recoloured
   proportionally to `creamOnDark` (#FBEFDB). Inner lines stay cocoa. Fills (orange, cream
   plate) are unchanged.
4. **Trim** to alpha > 12 plus 2 % padding, Lanczos resize, WebP q85 (alpha q100), PNG
   palette 48 colours, no dither. Source grain would double the PNG size; checked at 1200 px,
   no banding.

## SVG: rejected

`SCENES_SVG=1 node brand/scripts/scenes.mjs` traces the light PNG with vtracer (stacked,
14-colour palette snap, SVGO, `brand/scripts/scenes_trace.py`). All 15 came out 18–67 KB, under
the 90 KB cap, but fail the render check at 600 px: wobbly line weight, blotchy face plate and
cheeks, dropped details (eyebrow, small legs, bolts), and a full-canvas background rect instead
of transparent. Raster only.

## Known limits

- Cream pockets fully enclosed by outline (same colour as the face plate / toque) cannot be told
  from character fill, so they stay cream in dark.
- Raw blobs of `not-found-pantry`, `offline`, `reconnecting` fade ragged on one side; the ramp
  cuts the faint haze, a slightly rough edge remains.
- Cream outer outline makes the toque top edge blend into the cream toque fill in dark.
