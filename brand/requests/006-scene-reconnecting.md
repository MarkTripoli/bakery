# 006-scene-reconnecting — friendlier reconnecting scene

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/006-scene-reconnecting/`. Files `006-scene-reconnecting-<k>.png`,
k = 1..3.

Why: the 003 pick for "reconnecting" (`003-scenes-errors-12.png`) has furrowed, angry-looking
brows. Keep its idea and composition family, fix the face.

## Model

`nano_banana_pro`, resolution **2k**, aspect **4:3**, count 3; vary composition, keep the
character identical.

## References (attach to every job)

- R1 `brand/refs/mascot-j3.png`
  — THE approved mascot. Match it exactly.
- R2 `brand/refs/mark-j7.png`
  — face and toque detail.
- R3 `brand/raw/002-mascot-sheet/002-mascot-sheet-3.png`
  — action-pose sheet of the same mascot (pose reference; keep proportions).
- R4 `brand/raw/003-scenes-errors/003-scenes-errors-5.png`
  — approved scene style (blob, outline weight, prop rendering). Match its look.
- R5 `brand/raw/003-scenes-errors/003-scenes-errors-12.png`
  — composition reference ONLY (crank + belt); do NOT copy its frowning brows.

## Shared scene style block (append to every prompt)

> Fun, playful, warm spot illustration for a software app's status screen, starring the exact
> mascot from the reference: a plump golden bread-bun robot with a round bun head, large
> cream face plate, two tall pill-shaped cocoa eyes, tiny smile, blush cheeks, puffy
> three-puff cream chef's toque, stubby golden arms with mitten hands and short legs. Keep
> its proportions, outline weight and colours identical to the reference. Gentle humour,
> never scary, never sad. The scene sits on ONE soft rounded organic cream blob #FFF1D6
> behind the character and props, centred, filling about 75% of the canvas; everything
> outside the blob is solid flat pure white #FFFFFF, with no other background. Flat vector
> illustration: perfectly flat solid fills, no gradients, no shading, no highlights, no
> texture, no grain, no cast shadows, no 3D. One uniform dark cocoa outline weight on every
> shape. Palette: cocoa #3A1E0E, golden dough #F7A93B, cream #FFF1D6, terracotta #CF5A2E,
> blush #F2906C; props may also use sky #9CC3E6, sage #9DB58A, warm grey #CBBBA6, soot
> #5A4A40. Simple, few shapes, readable at 320 px wide. Absolutely no text, letters, numbers,
> digits, "404", "500", logos, signage or UI chrome anywhere — the app renders its own text.
> No watermark, no frame, no border.
> Exactly ONE mascot in the image, never duplicated. Friendly face only: no angry or
> frowning brows; mild surprise or a sheepish smile is the furthest it goes.

## Jobs

### J1 · reconnecting (k 1–3)

The mascot cheerfully turns a little hand crank on the side of a short conveyor belt (logo
style: cocoa band, terracotta rollers), small cocoa motion arcs around the crank, a tiny
curved arrow loop above the belt suggesting "coming back", and the mascot's face is happy
and encouraging: big pill eyes, small open smile, NO eyebrows at all. Optimistic,
"almost there".

## Return

`result.json` as for 001.
