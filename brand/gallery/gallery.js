const POLL_MS = 20000;
const LEGIBILITY_SIZES = [16, 24, 32, 48, 64];
const LOCKUP_HEIGHTS = [24, 32];
const ZOOM = 4;
const PICK_GROUP = /logo|mascot/;
const STORAGE = {
  bg: "brand-gallery-surface",
  filter: "brand-gallery-filter",
  zoom: "brand-gallery-zoom",
};
const DEFAULT_BG = "light.surface";
const BG_OPTIONS = [
  ["light.surface", "Light surface"],
  ["light.canvas", "Light canvas"],
  ["dark.surface", "Dark surface"],
  ["dark.canvas", "Dark canvas"],
  ["dark.surface-raised", "Dark raised"],
  ["light.selection", "Accent (light)"],
  ["brand.golden", "Brand orange"],
  ["checker", "Checker"],
];
const INKS = ["#2a160a", "#fff7e8"];
const CHECKER_HEX = "#ffffff";

const root = document.getElementById("root");
const lightbox = document.getElementById("lightbox");
const query = new URLSearchParams(location.search);

const state = {
  data: null,
  snapshot: "",
  bg: query.get("surface") || localStorage.getItem(STORAGE.bg) || DEFAULT_BG,
  filter: localStorage.getItem(STORAGE.filter) || "all",
  zoom: (query.get("zoom") ?? localStorage.getItem(STORAGE.zoom)) === "1",
  lightboxUrl: null,
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(
    ...children.flat().filter((child) => child != null && child !== false),
  );
  return el;
}

const formatBytes = (
  bytes,
) => (bytes < 1024
  ? `${bytes} B`
  : bytes < 1048576
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`);
const formatDims = (
  image,
) => (image.width ? `${image.width}×${image.height}` : null);
const isPick = (image) => Boolean(state.data.picks[image.name]?.pick);
const shownUrl = (image) => image.cutoutUrl ?? image.url;
const downloadUrl = (image) => `${shownUrl(image)}?download=1`;
const brandUrl = (file) => file.replace(/^assets\/brand\//, "/assets-brand/");

function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).slice(0, 3).map((pair) =>
    parseInt(pair, 16) / 255
  );
  const [r, g, b] = channels.map((
    c,
  ) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const inkFor = (hex) =>
  INKS.reduce((
    best,
    ink,
  ) => (contrast(hex, ink) > contrast(hex, best) ? ink : best));
const surfaceStyle = (hex) => `background:${hex};color:${inkFor(hex)}`;

function surfaceFor(key) {
  return state.data.surfaces[key] ?? state.data.logo?.surfaces?.[key] ?? null;
}

function bgOptions() {
  return BG_OPTIONS.filter(([key]) =>
    key === "checker" || state.data?.surfaces[key]
  );
}

function visibleImages(group) {
  const images = group.images.filter((image) => image.kind === "image");
  return state.filter === "picks" ? images.filter(isPick) : images;
}

function lightboxItems() {
  return state.data.groups.flatMap((group) =>
    visibleImages(group).map((image) => ({ group, image }))
  );
}

function tile(image) {
  const pick = state.data.picks[image.name];
  const picked = isPick(image);
  const thumb = image.kind === "image"
    ? h("img", { src: shownUrl(image), alt: image.name, loading: "lazy" })
    : h(
      "span",
      { class: "file-icon" },
      image.name.split(".").pop().toUpperCase(),
    );
  const details = [
    formatBytes(image.bytes),
    formatDims(image),
    image.seed != null && `seed ${image.seed}`,
  ].filter(Boolean);
  return h(
    "article",
    { class: `tile${picked ? " pick" : ""}` },
    h("button", {
      type: "button",
      class: "thumb",
      "aria-label": `View ${image.name}`,
      onclick: () => image.kind === "image" && openLightbox(image.url),
    }, thumb),
    picked && h("span", { class: "badge" }, "Pick"),
    h(
      "div",
      { class: "meta" },
      h("span", { class: "name" }, pick?.label || image.name),
      pick?.label && h("span", { class: "muted" }, image.name),
      h("span", { class: "muted" }, details.join(" · ")),
      picked && pick.note && h("span", { class: "pick-note" }, pick.note),
      h(
        "span",
        { class: "links" },
        h(
          "a",
          { href: downloadUrl(image) },
          image.cutoutUrl ? "Download cutout" : "Download",
        ),
        h(
          "a",
          { href: image.url, target: "_blank", rel: "noopener" },
          image.cutoutUrl ? "Original" : "Open",
        ),
      ),
    ),
  );
}

function groupSection(group) {
  const images = state.filter === "picks" ? visibleImages(group) : group.images;
  if (state.filter === "picks" && images.length === 0) return null;
  return h(
    "section",
    { class: "group", id: group.id },
    h(
      "div",
      { class: "group-head" },
      h("h2", {}, group.title),
      h("span", { class: `pill pill-${group.status}` }, group.status),
      group.requestUrl &&
        h(
          "a",
          { href: group.requestUrl, target: "_blank", rel: "noopener" },
          "Request",
        ),
      group.model && h("span", { class: "muted" }, group.model),
    ),
    images.length
      ? h("div", { class: "grid" }, images.map(tile))
      : h("p", { class: "empty" }, "No images yet."),
  );
}

function logoArt(src, height, alt) {
  return h("img", {
    class: "art",
    src: brandUrl(src),
    alt,
    height,
    style: `height:${height}px`,
  });
}

function ratioLabel(name, ratio, ok) {
  return `${name} ${Number(ratio).toFixed(1)}:1 ${ok ? "✓" : "✗"}`;
}

function entryRatios(entry) {
  return Object.keys(entry.contrast ?? {}).map((name) =>
    ratioLabel(name, entry.contrast[name], entry.pass?.[name])
  );
}

function logoCard(variant, entry) {
  const surface = surfaceFor(entry.surface);
  if (!surface) return null;
  const { files } = variant;
  return h(
    "article",
    { class: "logo-card", style: surfaceStyle(surface.hex) },
    h(
      "header",
      {},
      h("strong", {}, surface.label),
      h("span", { class: "token" }, `${surface.token} ${surface.hex}`),
      entry.recommended &&
        h("span", {
          class: "rec",
          style: `background:${inkFor(surface.hex)};color:${surface.hex}`,
        }, "Recommended"),
    ),
    h(
      "div",
      { class: "art-row" },
      files.mark && logoArt(files.mark, 64, "mark"),
      files.mark32 && logoArt(files.mark32, 32, "mark 32"),
      files.mark16 && logoArt(files.mark16, 16, "mark 16"),
    ),
    files.lockup &&
      h("div", { class: "art-row" }, logoArt(files.lockup, 44, "lockup")),
    files.wordmark &&
      h("div", { class: "art-row" }, logoArt(files.wordmark, 28, "wordmark")),
    h(
      "p",
      { class: "ratios" },
      entryRatios(entry).join(" · ") || "not evaluated",
    ),
  );
}

function variantRow(id, variant, matrix) {
  const entries = matrix.filter((entry) => entry.variant === id);
  return h(
    "div",
    { class: "variant" },
    h("h3", {}, variant.label || id),
    h("p", { class: "muted" }, variant.use),
    entries.length
      ? h(
        "div",
        { class: "logo-cards" },
        entries.map((entry) => logoCard(variant, entry)),
      )
      : h("p", { class: "empty" }, "Not evaluated on any surface."),
  );
}

function usageTable(logo) {
  const rows = logo.matrix.filter((entry) =>
    entry.recommended && surfaceFor(entry.surface)
  );
  const { minSize = {}, clearSpace = {} } = logo;
  const sizes =
    `mark ${minSize.mark} px · lockup ${minSize.lockupHeight} px tall · wordmark ${minSize.wordmarkHeight} px tall`;
  const space = [
    clearSpace.definition,
    clearSpace.minimum && `min ${clearSpace.minimum}`,
  ].filter(Boolean).join("; ");
  return h(
    "table",
    { class: "usage" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        [
          "Surface",
          "Recommended",
          "Contrast",
          "Pass",
          "Min sizes",
          "Clear space",
        ].map((title) => h("th", {}, title)),
      ),
    ),
    h(
      "tbody",
      {},
      rows.map((entry) => {
        const surface = surfaceFor(entry.surface);
        const pass = Object.entries(entry.pass ?? {}).map(([name, ok]) =>
          `${name} ${ok ? "✓" : "✗"}`
        ).join(" · ");
        return h(
          "tr",
          {},
          h(
            "td",
            {},
            h("span", { class: "swatch", style: `background:${surface.hex}` }),
            h("strong", {}, surface.label),
            h("span", { class: "muted" }, ` ${surface.token} ${surface.hex}`),
          ),
          h("td", {}, logo.variants[entry.variant]?.label || entry.variant),
          h(
            "td",
            {},
            entryRatios(entry).map((text) => text.replace(/ [✓✗]$/, "")).join(
              " · ",
            ),
          ),
          h("td", {}, pass),
          h("td", {}, sizes),
          h("td", {}, space),
        );
      }),
    ),
  );
}

function logoSystem() {
  const logo = state.data.logo;
  if (!logo?.variants) return null;
  const matrix = logo.matrix ?? [];
  return h(
    "section",
    { class: "group", id: "logo-system" },
    h(
      "div",
      { class: "group-head" },
      h("h2", {}, "Logo system"),
    ),
    Object.entries(logo.variants).map(([id, variant]) =>
      variantRow(id, variant, matrix)
    ),
    h("h3", { class: "usage-title" }, "Usage matrix"),
    h("div", { class: "table-wrap" }, usageTable({ ...logo, matrix })),
  );
}

function downscale(img, width, height) {
  let source = img;
  let w = img.naturalWidth || width;
  let ht = img.naturalHeight || height;
  while (w / 2 > width && ht / 2 > height) {
    w = Math.round(w / 2);
    ht = Math.round(ht / 2);
    const step = h("canvas", { width: w, height: ht });
    const ctx = step.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, ht);
    source = step;
  }
  const out = h("canvas", { width, height });
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return out;
}

// Zoom mode: rasterise at the real CSS size (1x device pixels), then magnify with nearest-neighbour.
function pixelCanvas(src, px, alt) {
  const canvas = h("canvas", {
    class: "pixels",
    role: "img",
    "aria-label": alt,
    height: px,
    style: `height:${px * ZOOM}px`,
  });
  const img = new Image();
  img.onload = () => {
    const ratio = img.naturalWidth && img.naturalHeight
      ? img.naturalWidth / img.naturalHeight
      : 1;
    const width = Math.max(1, Math.round(px * ratio));
    canvas.width = width;
    canvas.getContext("2d").drawImage(downscale(img, width, px), 0, 0);
    canvas.style.width = `${width * ZOOM}px`;
  };
  img.src = src;
  return canvas;
}

function sized(src, px, alt) {
  return state.zoom
    ? pixelCanvas(src, px, alt)
    : h("img", { src, alt, style: `height:${px}px` });
}

const sizedFigure = (src, px, alt) =>
  h(
    "figure",
    { class: "size" },
    sized(src, px, alt),
    h("figcaption", {}, `${px}px`),
  );

function markFile(files, px) {
  const rules = state.data.logo?.sizeRules ?? [];
  const rule = rules.find((r) =>
    px >= (r.minPx ?? 0) && px <= (r.maxPx ?? Infinity)
  );
  return files[rule?.file] ?? files.mark;
}

function recommendedFor(surfaceKey) {
  const logo = state.data.logo;
  const entry = logo?.matrix?.find((item) =>
    item.surface === surfaceKey && item.recommended
  );
  const variant = entry && logo.variants?.[entry.variant];
  return variant?.files ? { id: entry.variant, variant } : null;
}

function productionRow({ id, variant }) {
  const { files } = variant;
  const marks = files.mark
    ? LEGIBILITY_SIZES.map((px) =>
      sizedFigure(brandUrl(markFile(files, px)), px, `${id} mark ${px}px`)
    )
    : [];
  const lockups = files.lockup
    ? LOCKUP_HEIGHTS.map((px) =>
      sizedFigure(brandUrl(files.lockup), px, `${id} lockup ${px}px`)
    )
    : [];
  return h(
    "div",
    { class: "sheet-row" },
    h("h4", {}, `Recommended · ${variant.label || id}`),
    h("div", { class: "strip" }, marks, lockups),
  );
}

function pickRow(image) {
  const label = state.data.picks[image.name]?.label || image.name;
  return h(
    "div",
    { class: "sheet-row" },
    h("h4", {}, label),
    h(
      "div",
      { class: "strip" },
      LEGIBILITY_SIZES.map((px) =>
        sizedFigure(image.cutoutUrl, px, `${image.name} at ${px}px`)
      ),
    ),
  );
}

function legibilityPicks() {
  const seen = new Set();
  return state.data.groups
    .filter((group) => PICK_GROUP.test(group.id))
    .flatMap((group) =>
      group.images.filter((image) => image.cutoutUrl && isPick(image))
    )
    .filter((image) => !seen.has(image.url) && seen.add(image.url));
}

function surfaceBlock(key, surface, picks) {
  const recommended = recommendedFor(key);
  return h(
    "div",
    { class: "sheet-surface", style: surfaceStyle(surface.hex) },
    h(
      "h3",
      {},
      surface.label,
      h("span", { class: "token" }, `${surface.token} ${surface.hex}`),
    ),
    recommended && productionRow(recommended),
    picks.map(pickRow),
  );
}

function legibilitySheet() {
  const picks = legibilityPicks();
  return h(
    "section",
    { class: "group", id: "legibility" },
    h(
      "div",
      { class: "group-head" },
      h("h2", {}, "Legibility sheet"),
      h("button", {
        type: "button",
        class: "zoom-toggle",
        "aria-pressed": String(state.zoom),
        onclick: () => setPreference("zoom", !state.zoom),
      }, `${ZOOM}× pixel zoom`),
      h(
        "span",
        { class: "muted" },
        "Every surface from the design tokens. Zoom rasterises at 1× device pixels, then magnifies with nearest-neighbour.",
      ),
    ),
    h(
      "div",
      { class: "sheet" },
      Object.entries(state.data.surfaces).map(([key, surface]) =>
        surfaceBlock(key, surface, picks)
      ),
    ),
  );
}

function render() {
  const scroll = globalThis.scrollY;
  buildBgToggle();
  syncControls();
  root.replaceChildren(
    ...[...state.data.groups.map(groupSection), logoSystem(), legibilitySheet()]
      .filter(Boolean),
  );
  globalThis.scrollTo(0, scroll);
  if (state.lightboxUrl) showLightbox();
}

function lightboxInfo({ group, image }) {
  const pick = state.data.picks[image.name];
  const facts = [
    group.title,
    formatDims(image),
    formatBytes(image.bytes),
    image.seed != null && `seed ${image.seed}`,
    image.id != null && `id ${image.id}`,
  ];
  return [
    h("div", { class: "name" }, pick?.label || image.name),
    h("div", {}, facts.filter(Boolean).join(" · ")),
    pick?.note && h("div", {}, pick.note),
    image.prompt &&
    h("details", {}, h("summary", {}, "Prompt"), h("pre", {}, image.prompt)),
    h(
      "div",
      { class: "links" },
      h(
        "a",
        { href: downloadUrl(image) },
        image.cutoutUrl ? "Download cutout" : "Download",
      ),
      image.cutoutUrl &&
        h(
          "a",
          { href: image.url, target: "_blank", rel: "noopener" },
          "Original",
        ),
    ),
  ];
}

function showLightbox() {
  const items = lightboxItems();
  const current = items.find((item) => item.image.url === state.lightboxUrl);
  if (!current) return closeLightbox();
  const img = document.getElementById("lb-img");
  if (img.getAttribute("src") !== shownUrl(current.image)) {
    img.src = shownUrl(current.image);
  }
  img.alt = current.image.name;
  const info = document.getElementById("lb-info");
  const wasOpen = info.querySelector("details")?.open;
  info.replaceChildren(...lightboxInfo(current).filter(Boolean));
  if (wasOpen) info.querySelector("details").open = true;
  lightbox.hidden = false;
}

function openLightbox(url) {
  state.lightboxUrl = url;
  showLightbox();
}

function closeLightbox() {
  state.lightboxUrl = null;
  lightbox.hidden = true;
}

function stepLightbox(delta) {
  const items = lightboxItems();
  const index = items.findIndex((item) => item.image.url === state.lightboxUrl);
  if (index < 0) return;
  openLightbox(items[(index + delta + items.length) % items.length].image.url);
}

function applyBg() {
  const checker = state.bg === "checker";
  const hex = checker
    ? CHECKER_HEX
    : surfaceFor(state.bg)?.hex ?? surfaceFor(DEFAULT_BG)?.hex ?? "#ffffff";
  const style = document.body.style;
  style.setProperty("--tile-bg", hex);
  style.setProperty("--tile-ink", inkFor(hex));
  if (checker) {
    style.setProperty(
      "--checker",
      "conic-gradient(#e6dccb 25%, #fff 0 50%, #e6dccb 0 75%, #fff 0)",
    );
  } else style.removeProperty("--checker");
}

function buildBgToggle() {
  const options = bgOptions();
  if (!options.some(([key]) => key === state.bg)) state.bg = DEFAULT_BG;
  document.getElementById("bg-toggle").replaceChildren(
    ...options.map(([key, label]) =>
      h("button", {
        type: "button",
        "data-bg": key,
        onclick: () => setPreference("bg", key),
      }, label)
    ),
  );
}

function syncControls() {
  document.body.dataset.bg = state.bg;
  if (state.data) applyBg();
  for (const button of document.querySelectorAll("#bg-toggle button")) {
    button.setAttribute("aria-pressed", String(button.dataset.bg === state.bg));
  }
  for (const button of document.querySelectorAll("#filter-toggle button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.filter === state.filter),
    );
  }
}

function setPreference(key, value) {
  state[key] = value;
  localStorage.setItem(
    STORAGE[key],
    key === "zoom" ? (value ? "1" : "0") : value,
  );
  if (state.data) render();
  else syncControls();
}

async function refresh() {
  try {
    const response = await fetch("/data.json", { cache: "no-store" });
    const text = await response.text();
    document.getElementById("updated").textContent = `Updated ${
      new Date().toLocaleTimeString()
    }`;
    if (text === state.snapshot) return;
    state.snapshot = text;
    state.data = JSON.parse(text);
    render();
  } catch {
    document.getElementById("updated").textContent = "Offline, retrying…";
  }
}

for (const button of document.querySelectorAll("#filter-toggle button")) {
  button.addEventListener(
    "click",
    () => setPreference("filter", button.dataset.filter),
  );
}
document.getElementById("lb-close").addEventListener("click", closeLightbox);
document.getElementById("lb-prev").addEventListener(
  "click",
  () => stepLightbox(-1),
);
document.getElementById("lb-next").addEventListener(
  "click",
  () => stepLightbox(1),
);
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) closeLightbox();
});
document.addEventListener("keydown", (event) => {
  if (lightbox.hidden) return;
  if (event.key === "Escape") closeLightbox();
  else if (event.key === "ArrowLeft") stepLightbox(-1);
  else if (event.key === "ArrowRight") stepLightbox(1);
});

syncControls();
refresh();
setInterval(refresh, POLL_MS);
