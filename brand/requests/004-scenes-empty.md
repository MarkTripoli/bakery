# 004-scenes-empty — character scenes for empty states

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/004-scenes-empty/`. Files `004-scenes-empty-<k>.png`, k = 1..12 in
job order (3 per job).

## Model

`nano_banana_pro`, resolution **2k**, aspect **4:3** for every job, count 3 per job; vary
composition between the three, keep the character identical.

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

### J1 · no tasks (k 1–3)

An empty conveyor belt (logo style: cocoa band, terracotta rollers) with nothing on it; the
mascot sits on the end of the belt with its legs dangling, sipping from a small terracotta
mug with a curl of steam, relaxed and content. Calm "all clear" feeling.

### J2 · no sessions (k 4–6)

The mascot sits at a tiny round café table set with two small cups; the second little chair
is empty and pulled out invitingly; the mascot gives a gentle welcoming wave toward the empty
chair. Friendly, inviting, not lonely.

### J3 · no workers (k 7–9)

A short row of three small wall hooks, each holding an empty little chef's toque; the mascot
stands beside them holding a blank clipboard (no writing), looking hopeful with a small
smile, as if waiting for teammates to clock in.

### J4 · no search results (k 10–12)

The mascot leans over a large empty terracotta mixing bowl, peering inside, a small puff of
flour on its face plate, one mitten holding a whisk. Curious, mildly surprised "o" mouth.

## Return

`result.json` as for 001.
