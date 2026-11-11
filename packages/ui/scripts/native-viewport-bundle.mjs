import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";

export const VIEWPORT_BUNDLE_VERSION = "native-viewport-bundle-v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, message) => {
  if (!ok) throw new Error(`Viewport bundle: ${message}`);
};
const isDigest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const keys = (v, expected) =>
  v && same(Object.keys(v).sort(), [...expected].sort());

/** Revision and declared context binding, shared by producer and admission. */
export function viewportBundleIdentity(candidate) {
  const fields = [
    "id",
    "catalogId",
    "requiredCaseId",
    "storyId",
    "sourceCommit",
    "sourceDiffDigest",
    "storybookBuildDigest",
    "componentSourceDigest",
    "tokenDigest",
    "tokenRevision",
    "sourceProfile",
    "sourceDigest",
    "rasterProfile",
    "browser",
    "browserVersion",
    "browserLaunchOptions",
    "playwrightVersion",
    "os",
    "viewport",
    "dpr",
    "pointer",
    "colorScheme",
    "storedPreference",
    "locale",
    "direction",
    "timezone",
    "reducedMotion",
    "zoom",
    "animationDisabled",
    "fontDigests",
  ];
  return Object.fromEntries(fields.map((key) => [key, candidate[key] ?? null]));
}

// Native Chromium PNGs are non-interlaced RGB/RGBA, 8 bits per channel.
// Decode, never rewrite, crop or synthesize evidence images.
export function decodeViewportPng(bytes) {
  check(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "not a PNG",
  );
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    check(offset + length + 12 <= bytes.length, "truncated PNG");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      check(
        length === 13 && data[8] === 8 && channels && data[10] === 0 &&
          data[11] === 0 && data[12] === 0,
        "unsupported PNG",
      );
    }
    if (type === "IDAT") chunks.push(data);
    offset += length + 12;
  }
  check(
    Number.isInteger(width) && width > 0 && height > 0 &&
      width * height < 50_000_000,
    "unsupported PNG dimensions",
  );
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: (stride + 1) * height,
  });
  check(raw.length === (stride + 1) * height, "truncated PNG rows");
  const pixels = Buffer.alloc(width * height * 4);
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    check(filter <= 4, "unsupported PNG filter");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        a = x >= channels ? rows[i - channels] : 0,
        b = y ? rows[i - stride] : 0,
        c = y && x >= channels ? rows[i - stride - channels] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predictor = [
        0,
        a,
        b,
        Math.floor((a + b) / 2),
        pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
      ][filter];
      rows[i] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * channels, to = (y * width + x) * 4;
      rows.copy(pixels, to, from, from + 3);
      pixels[to + 3] = channels === 4 ? rows[from + 3] : 255;
    }
  }
  return { width, height, pixels };
}

export async function observeViewportV1(page, qualificationSelector) {
  const raw = await page.evaluate((selector) => {
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return {
        x: r.x + scrollX,
        y: r.y + scrollY,
        width: r.width,
        height: r.height,
      };
    };
    const observable = (e) => {
      if (
        !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        return false;
      }
      // Chromium can report SVG descendants of display:none as visible.
      // Exclude that unpainted subtree explicitly, but never infer no paint
      // from zero rectangle area: strokes, linecaps and overflowing text paint.
      for (let ancestor = e; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).display === "none") return false;
      }
      return true;
    };
    // Qualification still needs positive visible area for its hit-test grid.
    const visible = (e) =>
      observable(e) && e.getBoundingClientRect().width > 0 &&
      e.getBoundingClientRect().height > 0;
    const allElements = [...document.querySelectorAll("body, body *")];
    const elementIndices = new Map(allElements.map((e, i) => [e, i]));
    const elements = allElements.filter(observable);
    const geometryBox = (e) => {
      if (!(e instanceof SVGGraphicsElement) || !e.ownerSVGElement) {
        return { box: box(e) };
      }
      // Viewport bounds of SVG curves can lose different low bits after scroll.
      // Keep exact local geometry and its mapping to the owning SVG viewport;
      // that viewport is itself bound here, up to the outer document-space root.
      const ownerViewport = elementIndices.get(e.ownerSVGElement);
      const r = e.getBBox(), matrix = e.getCTM();
      const localBox = { x: r.x, y: r.y, width: r.width, height: r.height };
      const ctm = matrix && Object.fromEntries(
        ["a", "b", "c", "d", "e", "f"].map((k) => [k, matrix[k]]),
      );
      if (
        ownerViewport === undefined || !ctm ||
        !Object.values(localBox).every(Number.isFinite) ||
        !Object.values(ctm).every(Number.isFinite)
      ) throw new Error("Viewport bundle: unavailable/nonfinite SVG geometry");
      return { svg: { ownerViewport, localBox, ctm } };
    };
    const geometry = elements.map((e) => {
      const s = getComputedStyle(e);
      return {
        index: elementIndices.get(e),
        tag: e.tagName,
        ...geometryBox(e),
        position: s.position,
        zIndex: s.zIndex,
        style: [...s].map((k) => [k, s.getPropertyValue(k)]),
        scroll: { x: e.scrollLeft, y: e.scrollTop },
        scrollWidth: e.scrollWidth,
        scrollHeight: e.scrollHeight,
      };
    });
    const hazards = [];
    for (const [i, e] of elements.entries()) {
      const s = getComputedStyle(e), r = box(e);
      if (s.position === "fixed" || s.position === "sticky") {
        hazards.push({ kind: s.position, index: i, box: r });
      }
      if (
        e !== document.body &&
        (e.scrollHeight > e.clientHeight + 1 ||
          e.scrollWidth > e.clientWidth + 1) &&
        [s.overflowX, s.overflowY].some((v) =>
          v === "auto" || v === "scroll" || v === "hidden" || v === "clip"
        )
      ) hazards.push({ kind: "nested-overflow", index: i, box: r });
      if (
        s.position === "absolute" && s.zIndex !== "auto" && Number(s.zIndex) > 0
      ) {
        const intersects = elements.some((other) => {
          if (other === e || e.contains(other) || other.contains(e)) {
            return false;
          }
          const b = box(other);
          return r.x < b.x + b.width && b.x < r.x + r.width &&
            r.y < b.y + b.height && b.y < r.y + r.height;
        });
        if (intersects) {
          hazards.push({ kind: "positioned-overlay", index: i, box: r });
        }
      }
    }
    const qs = [...document.querySelectorAll(selector)];
    const q = qs[0];
    let qualification = null;
    if (qs.length === 1) {
      const r = box(q), s = getComputedStyle(q);
      const points = [];
      // Chromium rounds hit-test coordinates. Half-pixel samples on the last
      // row/column hit the next element (or outside the viewport), not this one.
      for (
        let y = Math.ceil(r.y - scrollY);
        y < r.y - scrollY + r.height;
        y += 1
      ) {
        for (
          let x = Math.ceil(r.x - scrollX);
          x < r.x - scrollX + r.width;
          x += 1
        ) {
          const top = document.elementFromPoint(x, y);
          if (!top || !(q === top || q.contains(top))) {
            points.push({ x, y });
            break;
          }
        }
      }
      qualification = {
        box: r,
        text: q.textContent,
        label: q.getAttribute("aria-label"),
        role: q.getAttribute("role"),
        hidden: !!q.closest('[hidden],[aria-hidden="true"],[inert]'),
        visible: visible(q) && s.opacity === "1",
        occluded: points.length > 0,
      };
    }
    return {
      html: document.documentElement.outerHTML,
      rootHtml: q?.parentElement?.outerHTML,
      geometry,
      hazards,
      qualification,
      scroll: { x: scrollX, y: scrollY },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      context: {
        viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints,
        media: Object.fromEntries(
          [
            "(pointer:coarse)",
            "(pointer:fine)",
            "(any-pointer:coarse)",
            "(any-pointer:fine)",
            "(hover:hover)",
            "(hover:none)",
            "(prefers-color-scheme:dark)",
            "(prefers-reduced-motion:reduce)",
          ].map((q) => [q, matchMedia(q).matches]),
        ),
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fonts: [...document.fonts].map((f) => [f.family, f.weight, f.status]),
        fontStatus: document.fonts.status,
      },
      animations: document.getAnimations().filter((a) =>
        a.playState === "running" || a.playState === "pending"
      ).length,
    };
  }, qualificationSelector);
  const { html, rootHtml, geometry, ...rest } = raw;
  return {
    ...rest,
    domDigest: hash(html),
    rootDomDigest: typeof rootHtml === "string" ? hash(rootHtml) : null,
    layoutDigest: digest(geometry),
  };
}
const settled = (page) =>
  page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
const stable = (o) => ({
  document: o.document,
  context: o.context,
  domDigest: o.domDigest,
  rootDomDigest: o.rootDomDigest,
  layoutDigest: o.layoutDigest,
  animations: o.animations,
  hazards: o.hazards,
});

function observedIssues(o, initial) {
  check(isDigest(o.rootDomDigest), "missing root DOM observation");
  check(same(stable(o), stable(initial)), "context/DOM/layout changed");
  // Sticky is admissible only while canonical document geometry (including
  // every sticky box above) stays identical. Active sticking fails that check;
  // exact overlap pixels are still required for every captured frame.
  check(
    o.hazards.every((h) => h.kind === "sticky") && o.animations === 0,
    "unsupported occlusion/animation",
  );
  check(o.document.width === o.context.viewport.width, "horizontal overflow");
  check(o.context.fontStatus === "loaded", "fonts not settled");
}

/** Capture only ordinary viewports; no page, style or viewport adaptation. */
export async function captureViewportBundle(
  page,
  {
    root,
    directory,
    identity,
    nonce = randomUUID(),
    qualificationSelector = ".ui-worker-detail__boundary",
  },
) {
  const key = `viewportBundle${randomUUID()}`;
  await page.evaluate((key) => {
    const elements = [...document.querySelectorAll("*")];
    const attributes = elements.map(
      (e) => [e, [...e.attributes].map((a) => [a.name, a.value])],
    );
    const children = elements.map((e) => [e, [...e.childNodes]]);
    const text = elements.flatMap((e) =>
      [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => [n, n.data])
    );
    const mutations = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records)
    );
    observer.observe(document, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    globalThis[key] = {
      observer,
      mutations,
      attributes,
      children,
      text,
      scroll: { x: scrollX, y: scrollY },
    };
  }, key);
  const manifest = {
    version: VIEWPORT_BUNDLE_VERSION,
    scope: "full-ui-bundle",
    adapter: "none",
    identity,
    nonce,
    frames: [],
  };
  let error;
  try {
    manifest.initial = await observeViewportV1(page, qualificationSelector);
    observedIssues(manifest.initial, manifest.initial);
    manifest.snapshotGeneration = digest({
      nonce: manifest.nonce,
      initial: manifest.initial,
    });
    const { width, height } = manifest.initial.context.viewport;
    const bottom = manifest.initial.document.height;
    check(
      Number.isInteger(width) && Number.isInteger(height) && height > 1 &&
        bottom >= height,
      "unsupported document dimensions",
    );
    await mkdir(directory, { recursive: true });
    for (
      let y = 0;;
      y = Math.min(y + Math.max(1, Math.floor(height / 2)), bottom - height)
    ) {
      check(manifest.frames.length < 512, "too many viewports");
      const requestedScroll = { x: 0, y };
      await page.evaluate((s) => scrollTo(s.x, s.y), requestedScroll);
      await settled(page);
      const before = await observeViewportV1(page, qualificationSelector);
      observedIssues(before, manifest.initial);
      check(same(before.scroll, requestedScroll), "unobserved scroll");
      const bytes = await page.screenshot();
      const after = await observeViewportV1(page, qualificationSelector);
      observedIssues(after, manifest.initial);
      check(same(before, after), "screenshot changed observation");
      const dimensions = decodeViewportPng(bytes);
      const index = manifest.frames.length;
      const path = join(
        directory,
        `viewport-${String(index).padStart(3, "0")}.png`,
      );
      await writeFile(path, bytes);
      manifest.frames.push({
        index,
        scope: "partial-viewport",
        path: relative(root, path),
        sha256: hash(bytes),
        width: dimensions.width,
        height: dimensions.height,
        requestedScroll,
        before,
        after,
        rect: { x: before.scroll.x, y: before.scroll.y, width, height },
        overlap: index
          ? manifest.frames[index - 1].rect.y + height - before.scroll.y
          : 0,
      });
      if (y + height === bottom) break;
    }
  } catch (e) {
    error = e;
  } finally {
    const mutationCount = await page.evaluate((key) => {
      const s = globalThis[key];
      s.mutations.push(...s.observer.takeRecords());
      return s.mutations.length;
    }, key);
    // Roll back actual scroll-triggered DOM/style mutations on failure, not just scroll.
    await page.evaluate(({ key, restore }) => {
      const s = globalThis[key];
      if (restore) {
        s.observer.disconnect();
        for (const [e, nodes] of s.children) e.replaceChildren(...nodes);
        for (const [e, attrs] of s.attributes) {
          for (const a of [...e.attributes]) e.removeAttribute(a.name);
          for (const [k, v] of attrs) e.setAttribute(k, v);
        }
        for (const [n, data] of s.text) n.data = data;
      }
      scrollTo(s.scroll.x, s.scroll.y);
    }, { key, restore: !!error || mutationCount > 0 });
    await settled(page);
    manifest.restored = await observeViewportV1(page, qualificationSelector);
    manifest.mutationCount = await page.evaluate((key) => {
      const s = globalThis[key];
      s.mutations.push(...s.observer.takeRecords());
      s.observer.disconnect();
      delete globalThis[key];
      return s.mutations.length;
    }, key);
    if (mutationCount || manifest.mutationCount) {
      error ??= new Error("Viewport bundle: scroll-triggered DOM mutation");
    }
    if (manifest.initial && !same(manifest.initial, manifest.restored)) {
      error ??= new Error(
        "Viewport bundle: original snapshot/scroll not restored",
      );
    }
  }
  if (error) throw error;
  const manifestPath = join(directory, "manifest.json");
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(manifestPath, bytes);
  const reference = {
    scope: "full-ui-bundle",
    adapter: "none",
    manifestPath: relative(root, manifestPath),
    manifestSha256: hash(bytes),
  };
  const issues = await viewportBundleIssues(root, reference, identity);
  check(!issues.length, issues.join("; "));
  return { reference, manifest };
}

/** Recompute every file, rectangle, overlap and binding; never trust coverage flags. */
async function viewportBundleV1Issues(root, reference, identity) {
  try {
    check(
      keys(reference, ["scope", "adapter", "manifestPath", "manifestSha256"]) &&
        reference.scope === "full-ui-bundle" && reference.adapter === "none" &&
        isDigest(reference.manifestSha256),
      "invalid bundle reference",
    );
    const read = async (path) => {
      check(
        typeof path === "string" && !path.split(/[\\/]/).includes("..") &&
          resolve(root, path).startsWith(resolve(root) + "/"),
        "unsafe evidence path",
      );
      return await readFile(join(root, path));
    };
    check(
      reference.manifestPath.endsWith(".full-ui/manifest.json"),
      "unsupported bundle path",
    );
    const bytes = await read(reference.manifestPath);
    check(hash(bytes) === reference.manifestSha256, "stale manifest digest");
    const m = JSON.parse(bytes);
    check(
      keys(m, [
        "version",
        "scope",
        "adapter",
        "identity",
        "nonce",
        "frames",
        "initial",
        "snapshotGeneration",
        "restored",
        "mutationCount",
      ]) && m.version === VIEWPORT_BUNDLE_VERSION &&
        m.scope === reference.scope && m.adapter === "none",
      "unsupported bundle schema",
    );
    check(identity && same(m.identity, identity), "stale bundle identity");
    check(
      typeof m.nonce === "string" && m.nonce.length > 0 &&
        m.snapshotGeneration === digest({ nonce: m.nonce, initial: m.initial }),
      "stale generation",
    );
    check(
      m.mutationCount === 0 && same(m.initial, m.restored),
      "mutation/restoration failed",
    );
    const { width, height } = m.initial.context.viewport,
      dpr = m.initial.context.dpr;
    check(
      Number.isInteger(dpr) && dpr >= 1 && dpr <= 4 &&
        Number.isInteger(width) && Number.isInteger(height) && width > 0 &&
        height > 1,
      "unsupported viewport/DPR",
    );
    check(
      same(identity.viewport, m.initial.context.viewport) &&
        identity.dpr === dpr &&
        m.initial.context.media["(pointer:coarse)"] ===
          (identity.pointer === "coarse") &&
        m.initial.context.media["(pointer:fine)"] ===
          (identity.pointer === "fine") &&
        m.initial.context.maxTouchPoints ===
          (identity.pointer === "coarse" ? 1 : 0),
      "declared context mismatch",
    );
    const context = m.initial.context;
    check(
      (identity.locale == null || identity.locale === context.locale) &&
        (identity.timezone == null || identity.timezone === context.timezone) &&
        (identity.reducedMotion == null ||
          ["reduce", "no-preference"].includes(identity.reducedMotion) &&
            context.media["(prefers-reduced-motion:reduce)"] ===
              (identity.reducedMotion === "reduce")) &&
        (identity.colorScheme == null ||
          ["light", "dark"].includes(identity.colorScheme) &&
            context.media["(prefers-color-scheme:dark)"] ===
              (identity.colorScheme === "dark")),
      "declared context mismatch",
    );
    observedIssues(m.initial, m.initial);
    check(
      Array.isArray(m.frames) && m.frames.length > 0 && m.frames.length <= 512,
      "missing frames",
    );
    let bottom = 0, previous;
    for (const [i, f] of m.frames.entries()) {
      check(
        f.index === i && f.scope === "partial-viewport" &&
          f.path ===
            join(
              dirname(reference.manifestPath),
              `viewport-${String(i).padStart(3, "0")}.png`,
            ),
        "duplicate/out-of-order frame",
      );
      observedIssues(f.before, m.initial);
      observedIssues(f.after, m.initial);
      check(
        same(f.before, f.after) && same(f.requestedScroll, f.before.scroll),
        "changed/unobserved frame",
      );
      check(
        isDigest(f.before.domDigest) && isDigest(f.before.layoutDigest),
        "missing DOM/layout observation",
      );
      const r = f.rect;
      check(
        r.x === 0 && r.y === f.before.scroll.y && f.before.scroll.x === 0 &&
          r.width === width && r.height === height && Number.isInteger(r.y) &&
          r.y >= 0 && (i ? r.y > previous.rect.y && r.y < bottom : r.y === 0) &&
          r.y + height <= m.initial.document.height,
        "missing band/truncated/invalid rectangle",
      );
      check(f.overlap === (i ? bottom - r.y : 0), "incorrect overlap metadata");
      check(
        f.width === width * dpr && f.height === height * dpr,
        "wrong native dimensions",
      );
      const png = await read(f.path);
      check(hash(png) === f.sha256, "stale frame digest");
      const decoded = decodeViewportPng(png);
      check(
        decoded.width === f.width && decoded.height === f.height,
        "PNG dimensions mismatch",
      );
      if (previous) {
        const rows = f.overlap * dpr, stride = f.width * 4;
        check(
          previous.decoded.pixels.subarray((f.height - rows) * stride).equals(
            decoded.pixels.subarray(0, rows * stride),
          ),
          "overlap pixels differ",
        );
      } else {
        const q = f.before.qualification;
        check(
          q && q.text && q.role && !q.hidden && q.visible && !q.occluded &&
            q.box.x >= 0 && q.box.y >= 0 && q.box.width > 0 &&
            q.box.height > 0 && q.box.x + q.box.width <= width &&
            q.box.y + q.box.height <= height,
          "qualification missing/obscured/incomplete",
        );
      }
      bottom = r.y + height;
      previous = { rect: r, decoded };
    }
    check(
      bottom === m.initial.document.height,
      "partial coverage: lower edge missing",
    );
    return [];
  } catch (e) {
    return [e.message];
  }
}

/** Admit full-UI-only detail output independently of any Paper parity binding. */
export async function viewportBundleRecordIssues(root, candidate) {
  const detail = candidate?.catalogId === "template.workerReadOnlyDetail" ||
    candidate?.storyId === "bakery-templates-workerreadonlydetail--contract";
  if (
    !detail && candidate?.outputScope !== "full-ui-bundle" &&
    !candidate?.fullUIBundle
  ) return [];
  if (
    candidate.outputScope !== "full-ui-bundle" ||
    candidate.outputAdapter !== "none" ||
    !candidate.fullUIBundle ||
    candidate.outputPath !== candidate.fullUIBundle.manifestPath ||
    candidate.outputSha256 !== candidate.fullUIBundle.manifestSha256
  ) {
    return ["invalid full-ui-bundle output binding"];
  }
  return await viewportBundleIssues(
    root,
    candidate.fullUIBundle,
    viewportBundleIdentity(candidate),
  );
}

/** Strict discriminator dispatch; never reinterpret historical v1 fields. */
export async function viewportBundleIssues(root, reference, identity) {
  try {
    check(
      keys(reference, ["scope", "adapter", "manifestPath", "manifestSha256"]) &&
        reference.scope === "full-ui-bundle" && reference.adapter === "none" &&
        isDigest(reference.manifestSha256),
      "invalid bundle reference",
    );
    check(
      typeof reference?.manifestPath === "string" &&
        !reference.manifestPath.split(/[\\/]/).includes("..") &&
        resolve(root, reference.manifestPath).startsWith(resolve(root) + "/"),
      "unsafe evidence path",
    );
    const bytes = await readFile(join(root, reference.manifestPath));
    check(hash(bytes) === reference.manifestSha256, "stale manifest digest");
    const m = JSON.parse(bytes);
    if (
      m.version === VIEWPORT_BUNDLE_VERSION && !("qualificationContract" in m)
    ) {
      return viewportBundleV1Issues(root, reference, identity);
    }
    if (
      m.version === "native-viewport-bundle-v2" &&
      m.qualificationContract === "qualification-visible-union-v1"
    ) {
      const { viewportBundleV2Issues } = await import(
        "./native-viewport-bundle-v2.mjs"
      );
      return viewportBundleV2Issues(root, reference, identity);
    }
    return ["Viewport bundle: unsupported bundle/qualification version"];
  } catch (e) {
    return [e.message];
  }
}
