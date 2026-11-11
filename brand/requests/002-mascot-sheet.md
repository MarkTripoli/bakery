# 002-mascot-sheet — refined mascot model sheet (pose reference for scenes)

Owner: brand (Claude Opus 5.5). Worker: omp-higgsfield.
Output dir: `brand/raw/002-mascot-sheet/`. Files `002-mascot-sheet-<k>.png`, k = 1..3.

## Model

`nano_banana_pro`, resolution 4k (same as 001). Same model for all jobs.

## References (attach to every job)

- R1 `brand/refs/mascot-j3.png`
  — THE approved mascot. Match it exactly: proportions, outline weight, palette, face.
- R2 `brand/refs/mark-j7.png`
  — approved face detail (pill eyes, smile, blush) and toque.

## Shared style block (append to every prompt)

> Character model sheet of the exact mascot in the reference image: a plump golden
> bread-bun robot with a round bun head, a large cream face plate, two tall pill-shaped
> cocoa eyes, a tiny curved smile, soft blush cheeks, a puffy cream chef's toque with three
> rounded puffs and a band, short stubby golden arms with round mitten hands and short legs
> with rounded feet. Identical proportions, colours and outline weight in every pose. Flat
> vector illustration: perfectly flat solid fills, no gradients, no shading, no highlights,
> no texture, no grain, no shadows, no 3D. One uniform dark cocoa outline weight. Strict
> palette: cocoa #3A1E0E, golden dough #F7A93B, cream #FFF1D6, terracotta #CF5A2E, blush
> #F2906C. Poses evenly spaced in a single clean row or grid on a solid flat pure white
> #FFFFFF background, generous space between poses, nothing overlapping. No text, no labels,
> no numbers, no grid lines, no frames, no watermark.

## Jobs

### J1 · turnaround (aspect 16:9, count 1)

Five poses left to right, standing neutral with arms relaxed, no conveyor: front, three-quarter
left, side profile left, back, three-quarter right. + shared style block.

### J2 · expression sheet (aspect 16:9, count 1)

Six head-and-toque close-ups in a 3×2 grid, same face plate and pill eyes, only eyes, brows
(tiny cocoa dashes allowed) and mouth change: happy (default), delighted with closed happy
arc eyes, surprised with small round "o" mouth, puzzled with one eye squinting and a tilted
toque, sheepish with a single small light-blue sweat drop, sleepy with closed line eyes.
+ shared style block.

### J3 · action poses (aspect 16:9, count 1)

Six full-body action poses in a 3×2 grid, no conveyor, no props unless named: waving
(matching the reference), cheering with both arms up, running mid-stride, sitting on the
ground with legs out, pointing to the side, holding a small round dough ball with both
mittens. + shared style block.

## Return

`result.json` as for 001 (model, final prompt per job, refs attached, ids/urls, size, times,
warnings).
