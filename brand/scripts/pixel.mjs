// Optical masters: 16 and 32 pixel-grid marks. Art is drawn as role letters, then
// written as integer-coordinate rects, so every edge lands on a pixel.
//
//   O outer outline   L inner line   F feature (eyes)   D dough   P plate
//   B belt band       R roller       K blush             . empty
import { roleColors, svgOpen } from "./lib.mjs";

// ---- tiny pixel painter: shapes sampled at pixel centres, no anti-aliasing ----
const blank = (n) => Array.from({ length: n }, () => Array(n).fill("."));
const disc = (cx, cy, r) => (x, y) =>
  (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
const box = (x0, y0, x1, y1) => (x, y) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1;
const union = (...fns) => (x, y) => fns.some((fn) => fn(x, y));
// rounded box with inclusive pixel bounds; r = corner radius in pixels
const rbox = (x0, y0, x1, y1, r) => {
  const inner = union(box(x0 + r, y0, x1 - r, y1), box(x0, y0 + r, x1, y1 - r));
  const c = (cx, cy) => disc(cx, cy, r);
  return union(
    inner,
    c(x0 + r, y0 + r),
    c(x1 + 1 - r, y0 + r),
    c(x0 + r, y1 + 1 - r),
    c(x1 + 1 - r, y1 + 1 - r),
  );
};

// Paint a silhouette with a `ring`-px edge of `edge` and an interior of `fill`.
function shape(g, inside, { edge = "X", fill, ring = 2 }) {
  const n = g.length;
  const m = Array.from(
    { length: n },
    (_, y) => Array.from({ length: n }, (_, x) => inside(x, y)),
  );
  const near = (x, y, d) => {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > d) continue;
        if (!(m[y + dy]?.[x + dx])) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      g[y][x] = near(x, y, ring) ? edge : fill;
    }
  }
}
const put = (g, ch, ...pts) => pts.forEach(([x, y]) => (g[y][x] = ch));
const fillBox = (g, ch, x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch;
};

// Ink "X" becomes O (outer outline) within 2 px of empty space, else L (inner line).
function settle(g, reach = 2) {
  const n = g.length;
  const dist = Array.from({ length: n }, () => Array(n).fill(99));
  const queue = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (g[y][x] === ".") {
        dist[y][x] = 0;
        queue.push([x, y]);
      }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (
        nx < 0 || ny < 0 || nx >= n || ny >= n || dist[ny][nx] <= dist[y][x] + 1
      ) continue;
      dist[ny][nx] = dist[y][x] + 1;
      queue.push([nx, ny]);
    }
  }
  return g.map((row, y) =>
    row.map((ch, x) => (ch === "X" ? (dist[y][x] <= reach ? "O" : "L") : ch))
      .join("")
  );
}

function art32() {
  const g = blank(32);
  // head: bun with narrow top under the hat band, full width by y16
  shape(g, union(rbox(5, 13, 26, 27, 6), box(10, 11, 21, 14)), { fill: "D" });
  shape(g, rbox(9, 16, 22, 24, 4), { edge: "P", fill: "P", ring: 1 });
  fillBox(g, "F", 11, 18, 12, 21);
  fillBox(g, "F", 19, 18, 20, 21);
  put(g, "F", [14, 21], [17, 21], [15, 22], [16, 22]);
  put(g, "K", [9, 22], [10, 22], [21, 22], [22, 22]);
  // toque
  shape(
    g,
    union(
      disc(10.8, 7.6, 3.9),
      disc(16, 5.4, 4.6),
      disc(21.2, 7.6, 3.9),
      box(9, 8, 22, 9),
    ),
    { fill: "P" },
  );
  // band
  shape(g, box(10, 9, 21, 12), { fill: "P", ring: 1 });
  fillBox(g, "X", 10, 9, 11, 12);
  fillBox(g, "X", 20, 9, 21, 12);
  // belt
  shape(g, rbox(3, 24, 28, 30, 3), { fill: "B" });
  for (const x0 of [6, 14, 22]) {
    fillBox(g, "R", x0, 26, x0 + 3, 28);
    put(g, "B", [x0, 26], [x0 + 3, 26], [x0, 28], [x0 + 3, 28]);
  }
  return settle(g);
}
export const ART32 = art32();

// Hand-placed: hat bumps at the pixel level, 1x2 eyes, three 2x2 rollers.
export const ART16 = [
  "......OOOO......",
  "..OOO.OPPO.OOO..",
  ".OPPPOPPPPOPPPO.",
  ".OPPPPPPPPPPPPO.",
  ".OPPPPPPPPPPPPO.",
  "..LLLLLLLLLLLL..",
  "..ODDDDDDDDDDO..",
  ".ODDPPPPPPPPDDO.",
  ".ODDPFPPPPFPDDO.",
  ".ODDPFPPPPFPDDO.",
  ".ODDPPPFFPPPDDO.",
  ".ODDPPPPPPPPDDO.",
  ".OOOOOOOOOOOOOO.",
  "OBBRRBBRRBBRRBBO",
  "OBBRRBBRRBBRRBBO",
  ".OOOOOOOOOOOOOO.",
];

// 24 grid: mark inside a 32 tile (75%). Same drawing rules as the 32 master, 1 px lines.
function art24() {
  const g = blank(24);
  shape(g, union(rbox(3, 10, 20, 20, 5), box(7, 8, 16, 11)), {
    fill: "D",
    ring: 1,
  });
  shape(g, rbox(6, 12, 17, 18, 3), { edge: "P", fill: "P", ring: 1 });
  fillBox(g, "F", 8, 13, 8, 16);
  fillBox(g, "F", 15, 13, 15, 16);
  fillBox(g, "F", 11, 17, 12, 17);
  put(g, "K", [6, 16], [17, 16]);
  shape(
    g,
    union(
      disc(7.6, 6, 3.3),
      disc(12, 4.6, 3.9),
      disc(16.4, 6, 3.3),
      box(6, 6, 17, 8),
    ),
    { fill: "P", ring: 1 },
  );
  fillBox(g, "X", 7, 8, 16, 8);
  shape(g, rbox(2, 18, 21, 23, 2), { fill: "B", ring: 2 });
  for (const x0 of [5, 11, 17]) fillBox(g, "R", x0, 20, x0 + 1, 21);
  return settle(g, 1);
}
export const ART24 = art24();

// 12 grid: mark inside a 16 tile (75%).
export const ART12 = [
  "....OOOO....",
  ".OO.OPPO.OO.",
  "OPPOPPPPOPPO",
  "OPPPPPPPPPPO",
  ".LLLLLLLLLL.",
  ".ODDDDDDDDO.",
  "ODDPFPPFPDDO",
  "ODDPFPPFPDDO",
  "ODDPPPPPPDDO",
  ".OOOOOOOOOO.",
  "OBRRBRRBRRBO",
  ".OOOOOOOOOO.",
];

// letter -> role per grid pass
const LETTER_ROLE = {
  O: "outline",
  L: "line",
  F: "feature",
  D: "dough",
  P: "plate",
  B: "belt",
  R: "roller",
  K: "blush",
};

// Merge runs of one colour into rectangles, emit one path per colour.
export function gridPaths(art, colorOf) {
  const byColor = new Map();
  art.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = colorOf(row[x]);
      let end = x;
      while (end + 1 < row.length && colorOf(row[end + 1]) === color) end++;
      if (color) {
        if (!byColor.has(color)) byColor.set(color, []);
        byColor.get(color).push(
          `M${x} ${y}h${end - x + 1}v1h${-(end - x + 1)}z`,
        );
      }
      x = end + 1;
    }
  });
  return byColor;
}

// `tileSize` puts the art (centred) on a rounded tile of that size, radius 22.5% snapped to px.
export function gridSvg(art, variantId, { tileSize = 0 } = {}) {
  const colors = roleColors(variantId);
  const pick = (letter) => {
    const role = LETTER_ROLE[letter];
    if (!role) return null;
    const c = colors[role];
    return c && c !== "knockout" ? c : null;
  };
  const paths = gridPaths(art, pick);
  const size = tileSize || art.length;
  const offset = (size - art.length) / 2;
  let body = "";
  if (tileSize) {
    const r = Math.round(size * 0.225);
    body +=
      `<rect width="${size}" height="${size}" rx="${r}" fill="${colors.tile}"/>`;
  }
  for (const [color, ds] of paths) {
    const d = ds.join("");
    body += offset
      ? `<path fill="${color}" transform="translate(${offset} ${offset})" d="${d}"/>`
      : `<path fill="${color}" d="${d}"/>`;
  }
  return `${svgOpen(`0 0 ${size} ${size}`)}${body}</svg>`;
}
