# 001-logo-refine — refined Bakery logo, round 1

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/001-logo-refine/`. Files `001-logo-refine-<k>.png`, k = 1..9 in the
order of the jobs below. Lossless PNG, largest size the model allows.

## Model

Use a Higgsfield image model that (a) accepts reference images (image-to-image / edit /
"reference" mode) and (b) renders clean flat vector-style art and legible text. Preference
order if available: Nano Banana Pro → GPT Image (newest) → Seedream (newest) → Flux Kontext
(newest). Use the same model for all 9 jobs. In `result.json` also list every image model the
Higgsfield MCP exposed (name + id + max size + whether it takes references) so later
requests can name one exactly.

## References (attach to every job)

- R1 `assets/brand/bakery-logo-v2.png`
  (current lockup: mascot on conveyor + "bakery" wordmark)
- R2 `assets/brand/bakery-favicon-master.png`
  (current square mark)

Reference strength: high for character identity (keep it the same mascot), low for rendering
style (we want cleaner, flatter art than the references).

## Shared style block (append to every prompt)

> Same mascot as the reference: a plump golden bread-bun robot with a large cream face
> plate, two tall oval cocoa eyes, a tiny curved smile, soft blush cheeks, and a puffy cream
> chef's toque with three rounded puffs, standing on a small friendly factory conveyor belt.
> Evolve it, do not replace it. Professional flat vector brand mark: perfectly flat solid
> fills, no gradients, no shading, no highlights, no texture, no grain, no drop shadow, no
> 3D. One uniform, confident dark cocoa outline weight everywhere, smooth geometric curves,
> rounded joins, very few shapes, generous negative space. Strict palette only: cocoa
> #3A1E0E (outlines, wordmark, belt), golden dough #F7A93B, cream #FFF1D6 (face, toque),
> terracotta #CF5A2E (belt trim and rollers), blush #F2906C (cheeks only). Solid flat pure
> white #FFFFFF background filling the whole canvas, no checkerboard, no transparency
> pattern, no backdrop shapes, no badge, no frame, no mockup, no watermark, no signature,
> no extra text.

## Negative prompt (every job, if the model supports one)

gradient, shading, highlight, gloss, texture, noise, grain, 3d, render, shadow, drop
shadow, checkerboard, transparency grid, photo, mockup, paper, badge, circle frame,
sticker border, multiple logos, logo sheet, extra characters, extra text, slogan, tagline,
watermark, signature, blurry, sketchy lines, uneven outline, hands with fingers, tank
treads

## Jobs

### J1–J2 · faithful clean lockup (aspect 16:9, count 2)

Horizontal logo lockup, mascot on the left, the exact lowercase word "bakery" on the right.
Keep the reference composition: the mascot raises a small golden bread loaf in one mitten
hand and holds a tiny cocoa tablet showing a simple "</>" in the other, standing on a short
conveyor belt with three round terracotta rollers and two stubby feet. Redraw it as a clean
designer-finished flat vector: same pose and props, but simpler geometry, one outline
weight, flat colour. Wordmark: heavy, rounded, friendly geometric lowercase "bakery" in solid
cocoa, evenly weighted strokes, tight balanced kerning, its baseline aligned with the
conveyor top, cap/x-height optically centred on the mascot's face. Exactly the six letters
b-a-k-e-r-y, spelled correctly. + shared style block.

### J3–J4 · simplified lockup, no hand props (aspect 16:9, count 2)

Same lockup layout and wordmark rules as J1–J2, but simplify the mascot for small-size
legibility: bigger head relative to body (head about 55% of mascot height), no bread loaf,
no tablet, no buttons; one stubby arm raised in a cheerful wave, the other relaxed. Conveyor
belt shortened to just under the feet with three rollers. Bold, chunky silhouette that stays
readable when the whole lockup is 24px tall. Exactly "bakery", lowercase, spelled
correctly. + shared style block.

### J5–J7 · square app mark (aspect 1:1, count 3)

Square app icon mark, NO text, NO letters, NO code symbols. Only the mascot's head
(golden bun dome + big cream face plate + two oval eyes + tiny smile + blush) wearing the
puffy three-puff cream toque, sitting directly on a short capsule conveyor belt with exactly
three large terracotta rollers. No arms, no body detail, no props. Centred, filling about
80% of the canvas with even margins. Extra-thick outline (about 6% of the icon width) and
oversized eyes so it still reads at 16×16 and 32×32 pixels. Each of the three images should
try a slightly different proportion: J5 toque large and tall, J6 toque compact and wide,
J7 head wider and lower, belt slimmer. + shared style block.

### J8–J9 · wordmark only (aspect 3:1 or nearest wide ratio, count 2)

Wordmark only, NO mascot, NO icon: the exact lowercase word "bakery" as a bespoke heavy,
rounded, friendly geometric logotype in solid cocoa #3A1E0E on pure white. Evolve the
reference wordmark: same chunky soft personality, but cleaner and more even — consistent
stroke weight, perfectly round bowls on b/a/e, a crisp k, a short tidy y descender, optically
even letter spacing, all terminals rounded. J9 may add a tiny playful detail: the counter of
the "a" or "e" shaped subtly like a bread-roll score mark, only if it stays clean and legible.
Exactly six letters b-a-k-e-r-y, spelled correctly, nothing else. + shared style block
(ignore the mascot sentence for these two).

## Return

`result.json`: request id, model name/id, full final prompt + negative prompt per job,
reference files actually attached, seed / generation id / Higgsfield asset URL per image,
size, timestamps, failures or warnings, and the model list described above.
