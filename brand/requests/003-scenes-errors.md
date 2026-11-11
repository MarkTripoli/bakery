# 003-scenes-errors — character scenes for error and status screens

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/003-scenes-errors/`. Files `003-scenes-errors-<k>.png`, k = 1..18 in
job order (3 per job).

## Model

`nano_banana_pro`, resolution **2k** (scenes display ≤ 800 px; save credits). Aspect **4:3**
for every job. Count 3 per job; vary composition between the three, keep the character
identical.

## References (attach to every job)

- R1 `brand/refs/mascot-j3.png`
  — THE approved mascot. Match it exactly.
- R2 `brand/refs/mark-j7.png`
  — face and toque detail.

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

## Jobs

### J1 · 404 not found (k 1–3)

The mascot follows a little trail of breadcrumbs that simply stops at the edge of the blob,
holding an oversized magnifying glass, head tilted, puzzled squint, a single crumb resting
on its toque. A tiny question-mark-free hint of confusion: one mitten scratching its toque.

### J2 · 500 server error (k 4–6)

A small round terracotta bakery oven puffs one big cartoon smoke cloud in soot grey; the
mascot holds a wooden peel with one charcoal-black overbaked loaf, toque slightly smudged
with soot, sheepish smile with one light-blue sweat drop. Funny "oops", not disaster.

### J3 · 403 forbidden (k 7–9)

The mascot stands as a polite little doorman in front of a rounded cream kitchen door, one
mitten raised in a friendly "stop", a velvet rope made of two rolling pins on short posts
with a terracotta rope between them. Kind, apologetic smile.

### J4 · offline / reconnecting (k 10–12)

The mascot holds an unplugged cocoa power plug with a curly cord trailing back to a short
stalled conveyor belt (same belt style as the logo: cocoa band, terracotta rollers), looking
around hopefully for the socket. For k 12 instead: the mascot turns a little hand crank on
the conveyor with small motion arcs, determined smile (reconnecting).

### J5 · maintenance (k 13–15)

The mascot lies on a little rolling creeper under the conveyor belt (logo style) tightening
a bolt with a big friendly wrench, legs sticking out, a small open toolbox and two bolts
beside it, a soft puff of flour dust. Content, busy.

### J6 · alternate 404 lost-in-the-pantry (k 16–18)

The mascot peeks out from behind a tall stack of three flour sacks (plain, no lettering)
holding a paper map upside down, one eyebrow raised, playful.

## Return

`result.json` as for 001.
