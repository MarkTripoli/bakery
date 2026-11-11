# 005-scenes-moments — loading, success, welcome and sign-in hero

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/005-scenes-moments/`. Files `005-scenes-moments-<k>.png`, k = 1..12
in job order (3 per job).

## Model

`nano_banana_pro`, resolution **2k**. Aspect **4:3** for J1–J3, **3:2** for J4. Count 3 per
job; vary composition between the three, keep the character identical.

## References (attach to every job)

- R1 `brand/refs/mascot-j3.png`
  — THE approved mascot. Match it exactly.
- R2 `brand/refs/mark-j7.png`
  — face and toque detail.
- R3 `brand/raw/002-mascot-sheet/002-mascot-sheet-3.png`
  — action-pose sheet of the same mascot (pose reference; keep proportions).
- R4 `brand/raw/003-scenes-errors/003-scenes-errors-5.png`
  — approved scene style (blob, outline weight, prop rendering). Match its look.

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

### J1 · loading / working (k 1–3)

The mascot kneads a round ball of cream dough on a short conveyor belt (logo style), small
cocoa motion arcs beside its mittens, focused happy face with tongue-free tiny smile. A
compact, centred pose that would loop well as a gentle bob animation.

### J2 · success / celebration (k 4–6)

The mascot leaps with both arms up, tossing its toque into the air, small confetti of
sprinkles in palette colours around it, and one perfect golden loaf with a little sparkle on
the conveyor belt beside it. Joyful.

### J3 · first-run welcome (k 7–9)

The mascot holds out a wooden tray of three fresh golden rolls toward the viewer with a big
warm smile, slight bow, as if welcoming a new guest into the bakery.

### J4 · sign-in hero (3:2, k 10–12)

A slightly wider, calm scene: the mascot stands at the end of a short factory conveyor belt
(logo style) on which three golden loaves ride toward it, two gentle steam curls rising from
a small round terracotta oven in the background, the mascot waving at the viewer. More
environment than the other scenes but still flat, simple and quiet; keep the composition
weighted to the centre-left so UI can sit on the right. Still on the single cream blob over
pure white.

## Return

`result.json` as for 001.
