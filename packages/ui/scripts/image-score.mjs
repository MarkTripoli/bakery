// Content-registration image scorer shared by the Paper parity gate
// (compare-paper.mjs) and the design reference renderer
// (render-paper-references.mjs). `scorePixels` is pure and closure-free so it
// can run unmodified inside `page.evaluate(scorePixels, args)` as well as
// directly in Node against synthetic RGBA arrays in tests.
//
// Algorithm: build a content mask per image (pixels that differ from the
// baseline's most frequent colour by more than 8 on any channel). Within the
// union of both content masks, split pixels into two disjoint classes:
//
//   - INK: at least one image is locally non-flat there (an edge, a glyph,
//     an icon boundary). Only core ink (48+ from the background in at least
//     one image) is scored, with +/-1px registration tolerance and a
//     perceptual (YIQ, pixelmatch 0.2) delta, so sub-pixel jitter and
//     rasteriser anti-aliasing differences cannot manufacture a mismatch.
//   - SURFACE: both images are locally flat there (a solid panel/background
//     colour). Surface pixels are compared at the exact same position with no
//     registration tolerance and no perceptual slack: a flat region is a
//     design token, and a token substitution (e.g. one off-white shade for
//     another) is a real defect even though it is visually subtle.
//
// The overall score is the minimum of the two class scores, so a wrong
// layout cannot pass by hiding structural glyph differences behind a large
// shared background (the old failure mode) NOR by hiding a flat-panel colour
// swap behind generous edge-matching tolerance.
export function scorePixels({ candidate, baseline, width, height, region }) {
  const area = region ?? { x: 0, y: 0, width, height };
  const index = (x, y) => (y * width + x) * 4;

  let backgroundKey = 0;
  let backgroundCount = -1;
  const colorCounts = new Map();
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const pixel = index(x, y);
      const key = (baseline[pixel] << 16) | (baseline[pixel + 1] << 8) |
        baseline[pixel + 2];
      const count = (colorCounts.get(key) ?? 0) + 1;
      colorCounts.set(key, count);
      if (count > backgroundCount) {
        backgroundCount = count;
        backgroundKey = key;
      }
    }
  }
  const background = [
    (backgroundKey >> 16) & 255,
    (backgroundKey >> 8) & 255,
    backgroundKey & 255,
  ];

  const maxChannelDelta = (dataA, pixelA, dataB, pixelB) =>
    Math.max(
      Math.abs(dataA[pixelA] - dataB[pixelB]),
      Math.abs(dataA[pixelA + 1] - dataB[pixelB + 1]),
      Math.abs(dataA[pixelA + 2] - dataB[pixelB + 2]),
    );

  const isContent = (data, pixel) =>
    Math.max(
      Math.abs(data[pixel] - background[0]),
      Math.abs(data[pixel + 1] - background[1]),
      Math.abs(data[pixel + 2] - background[2]),
    ) > 8;

  // A pixel is locally flat in an image when every in-bounds 8-neighbour
  // differs by no more than 8 on any channel from it: a solid colour patch,
  // not an edge or glyph stroke.
  const isFlat = (data, x, y) => {
    const pixel = index(x, y);
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (maxChannelDelta(data, pixel, data, index(nx, ny)) > 8) {
          return false;
        }
      }
    }
    return true;
  };

  // pixelmatch's YIQ perceptual delta. Ink is judged at pixelmatch threshold
  // 0.2 (expressed against 35215 = 255^2 * (0.5053 + 0.299 + 0.1957), the
  // maximum squared YIQ distance): glyph anti-aliasing differs by up to ~50
  // grey levels between two Linux Chromium rasterisers (fontconfig hinting,
  // gamma), and 0.1 flagged 12% of identical text as mismatched. 0.2 still
  // separates every pair of foreground tokens (ink vs muted vs link).
  const MISMATCH_THRESHOLD = 35215 * 0.04;
  // Only "core" ink pixels are scored: at least one image must differ from
  // the background by 48+ on some channel there. Faint anti-aliasing fringes
  // are excluded so rasteriser noise cannot move the score in either
  // direction; a glyph's body and a moved or missing glyph still count fully.
  const CORE_INK = 48;
  const isCore = (data, pixel) =>
    Math.max(
      Math.abs(data[pixel] - background[0]),
      Math.abs(data[pixel + 1] - background[1]),
      Math.abs(data[pixel + 2] - background[2]),
    ) >= CORE_INK;
  const yiqDelta = (sourceData, sourcePixel, targetData, targetPixel) => {
    const r = sourceData[sourcePixel] - targetData[targetPixel];
    const g = sourceData[sourcePixel + 1] - targetData[targetPixel + 1];
    const b = sourceData[sourcePixel + 2] - targetData[targetPixel + 2];
    const y = r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    const i = r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
    const q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
    return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  };
  const matchesWithin = (x, y, sourceData, targetData) => {
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < area.y || ny >= area.y + area.height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        if (nx < area.x || nx >= area.x + area.width) continue;
        if (
          yiqDelta(sourceData, index(x, y), targetData, index(nx, ny)) <=
            MISMATCH_THRESHOLD
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const diff = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = index(x, y);
      const luminance = 0.299 * baseline[pixel] + 0.587 * baseline[pixel + 1] +
        0.114 * baseline[pixel + 2];
      const shade = Math.round(255 - (255 - luminance) * 0.3);
      diff[pixel] = shade;
      diff[pixel + 1] = shade;
      diff[pixel + 2] = shade;
      diff[pixel + 3] = 255;
    }
  }

  let inkUnion = 0;
  let inkMismatched = 0;
  let surfaceUnion = 0;
  let surfaceMismatched = 0;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const pixel = index(x, y);
      const contentCandidate = isContent(candidate, pixel);
      const contentBaseline = isContent(baseline, pixel);
      if (!contentCandidate && !contentBaseline) continue;
      const ink = !isFlat(candidate, x, y) || !isFlat(baseline, x, y);
      if (ink) {
        if (!isCore(candidate, pixel) && !isCore(baseline, pixel)) continue;
        inkUnion += 1;
        let mismatch = false;
        if (contentCandidate && !matchesWithin(x, y, candidate, baseline)) {
          mismatch = true;
        }
        if (contentBaseline && !matchesWithin(x, y, baseline, candidate)) {
          mismatch = true;
        }
        if (mismatch) {
          inkMismatched += 1;
          diff[pixel] = 255;
          diff[pixel + 1] = 0;
          diff[pixel + 2] = 0;
          diff[pixel + 3] = 255;
        }
      } else {
        surfaceUnion += 1;
        if (maxChannelDelta(candidate, pixel, baseline, pixel) > 8) {
          surfaceMismatched += 1;
          diff[pixel] = 255;
          diff[pixel + 1] = 140;
          diff[pixel + 2] = 0;
          diff[pixel + 3] = 255;
        }
      }
    }
  }

  if (inkUnion === 0 && surfaceUnion === 0) {
    return { issue: "no content in comparison region" };
  }
  const inkScore = inkUnion === 0 ? 1 : 1 - inkMismatched / inkUnion;
  const surfaceScore = surfaceUnion === 0
    ? 1
    : 1 - surfaceMismatched / surfaceUnion;
  const regionArea = area.width * area.height;

  return {
    score: Math.min(inkScore, surfaceScore),
    inkScore,
    surfaceScore,
    inkCoverage: inkUnion / regionArea,
    surfaceCoverage: surfaceUnion / regionArea,
    mismatched: { ink: inkMismatched, surface: surfaceMismatched },
    diff,
  };
}

// PNG dimensions from the IHDR chunk, which the format fixes at bytes 16-23.
// Lets callers reason about frame geometry without decoding pixels.
export function pngDimensions(bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (
    view.length < 24 ||
    view.toString("latin1", 1, 4) !== "PNG" ||
    view.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new Error("not a PNG");
  }
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

// Decodes both PNGs, crops each to its rectangle when one is given, scores
// them with `scorePixels` and PNG-encodes the diff - all inside the page in
// one evaluate. Only the two compressed PNGs go in and scalars plus the
// compressed diff come out; shipping decoded RGBA frames (5.5 MB at
// 1440x960) through the CDP JSON channel four times per case is what made
// the gate take 25 minutes on the CI runner. Decoding stays on a canvas in a
// real browser so every caller gets byte-identical pixels.
export async function comparePngs(page, {
  candidate,
  baseline,
  candidateCrop = null,
  baselineCrop = null,
  region = null,
  diff = false,
}) {
  const toDataUrl = (bytes) =>
    `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  return await page.evaluate(
    async (
      {
        candidateUrl,
        baselineUrl,
        candidateCrop,
        baselineCrop,
        region,
        diff,
        scorerSource,
      },
    ) => {
      const scorer = new Function(`return (${scorerSource});`)();
      const decode = async (url, crop) => {
        const bitmap = await createImageBitmap(
          await (await fetch(url)).blob(),
        );
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const area = crop ??
          { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
        return {
          width: area.width,
          height: area.height,
          data: context.getImageData(area.x, area.y, area.width, area.height)
            .data,
        };
      };
      const [candidateFrame, baselineFrame] = await Promise.all([
        decode(candidateUrl, candidateCrop),
        decode(baselineUrl, baselineCrop),
      ]);
      const scored = scorer({
        candidate: candidateFrame.data,
        baseline: baselineFrame.data,
        width: candidateFrame.width,
        height: candidateFrame.height,
        region,
      });
      const { diff: diffPixels, ...rest } = scored;
      const frame = {
        width: candidateFrame.width,
        height: candidateFrame.height,
      };
      if (rest.issue !== undefined || !diff) return { ...rest, frame };
      const canvas = document.createElement("canvas");
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.getContext("2d").putImageData(
        new ImageData(diffPixels, frame.width, frame.height),
        0,
        0,
      );
      return { ...rest, frame, diffDataURL: canvas.toDataURL("image/png") };
    },
    {
      candidateUrl: toDataUrl(candidate),
      baselineUrl: toDataUrl(baseline),
      candidateCrop,
      baselineCrop,
      region,
      diff,
      scorerSource: scorePixels.toString(),
    },
  );
}
