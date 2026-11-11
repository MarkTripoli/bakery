# Bakery brand review gallery

Static review page for generated brand images. Zero dependencies, Node 22,
ImageMagick (`magick`) for cutouts. `/data.json` is rebuilt from disk on every
request, so new files show up without a restart.

Run from the repo root: `PORT=18446 node brand/gallery/server.mjs` (binds
127.0.0.1). Serves `brand/{raw,requests,exports,scenes}`, `assets/brand` (as
`/current` and `/assets-brand`). Optional picks: `brand/gallery/picks.json`,
`{ "<file name>": { "pick": true, "label": "...", "note": "..." } }`.

- `/cutout/<group>/<name>.png`: transparent cutout of a raw image (group =
  `brand/raw/<group>` or `current`). Border flood-fill of near-white, 1 px
  feathered edge, max 1600 px. Built lazily with `magick`, cached in
  `brand/cutouts/`, rebuilt when the raw is newer. Every tile and the lightbox
  use it; "Original" links the raw.
- `/surfaces.json`: surface colours parsed from
  `packages/ui/src/foundations/theme.css` (plus `brand.golden`). The top-bar
  toggle paints tiles with them; ink is picked by contrast.
  `?surface=dark.surface` pre-selects one, `?zoom=1` turns the pixel zoom on.
- Production exports: `assets/brand/{logo/*,favicon,social,sheets}` appear as
  groups (SVGs included).
- Logo system + usage matrix render from `assets/brand/logo/variants.json` when
  it exists (`VARIANTS_JSON=<path>` overrides, for testing).
- Legibility sheet: one block per surface, painted in the surface colour (no
  card behind), 16-64 px, lockups at 24/32 px, 4x pixel zoom (rasterised at 1x
  device pixels, nearest-neighbour).
