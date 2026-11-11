import { createHash } from "node:crypto";

const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, message) => {
  if (!ok) throw new Error(`Qualification: ${message}`);
};
const keys = (v, expected) =>
  v && same(Object.keys(v).sort(), [...expected].sort());
const rectangle = (r) =>
  r && Object.keys(r).sort().join() === "height,width,x,y" &&
  Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0;
export function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}
export function sampleBounds(r, scroll) {
  if (!r) return { left: 0, top: 0, right: 0, bottom: 0, count: 0 };
  const left = Math.ceil(r.x - scroll.x), top = Math.ceil(r.y - scroll.y);
  const right = Math.ceil(r.x + r.width - scroll.x);
  const bottom = Math.ceil(r.y + r.height - scroll.y);
  return { left, top, right, bottom, count: (right - left) * (bottom - top) };
}
/** Exact slab union, not area addition or a tolerance. */
export function exactCoverage(target, rectangles) {
  if (!rectangle(target) || !rectangles.every(rectangle)) return false;
  const clipped = rectangles.map((r) => intersection(target, r)).filter(
    Boolean,
  );
  const edges = [
    ...new Set([
      target.x,
      target.x + target.width,
      ...clipped.flatMap((r) => [r.x, r.x + r.width]),
    ]),
  ].sort((a, b) => a - b);
  for (let i = 1; i < edges.length; i++) {
    const spans = clipped.filter((r) =>
      r.x <= edges[i - 1] && r.x + r.width >= edges[i]
    )
      .map((r) => [r.y, r.y + r.height]).sort((a, b) => a[0] - b[0]);
    let end = target.y;
    for (const [start, bottom] of spans) {
      if (start > end) return false;
      end = Math.max(end, bottom);
    }
    if (end !== target.y + target.height) return false;
  }
  return true;
}
export function scrollSequence(bottom, height) {
  check(
    Number.isInteger(bottom) && Number.isInteger(height) && height > 1 &&
      bottom >= height,
    "invalid document extent",
  );
  const sequence = [];
  for (
    let y = 0;;
    y = Math.min(y + Math.max(1, Math.floor(height / 2)), bottom - height)
  ) {
    check(sequence.length < 512, "too many frames");
    sequence.push(y);
    if (y + height === bottom) return sequence;
  }
}

/** Browser observations contain canonical content and strictly viewport-local proof. */
export async function observeQualification(page, selector) {
  const raw = await page.evaluate((selector) => {
    const all = [...document.querySelectorAll("body, body *")];
    const qs = [...document.querySelectorAll(selector)], q = qs[0];
    if (qs.length !== 1) {
      throw new Error("Qualification: missing/duplicate qualification");
    }
    const box = (r) => ({
      x: r.x + scrollX,
      y: r.y + scrollY,
      width: r.width,
      height: r.height,
    });
    const intersect = (a, b) => {
      const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
      const right = Math.min(a.x + a.width, b.x + b.width),
        bottom = Math.min(a.y + a.height, b.y + b.height);
      return right > x && bottom > y
        ? { x, y, width: right - x, height: bottom - y }
        : null;
    };
    const contains = (a, b) =>
      a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width &&
      a.y + a.height >= b.y + b.height;
    const hazards = [];
    const alpha = (color) =>
      color === "transparent" || /rgba\([^)]*,\s*0\s*\)/.test(color);
    const inspect = (e, rects, text) => {
      for (let a = e; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (
          a.matches('[hidden],[inert],[aria-hidden="true"]') ||
          s.display === "none" || s.visibility !== "visible" ||
          s.opacity !== "1" || s.contentVisibility === "hidden"
        ) hazards.push("hidden/transparent content");
        if (
          s.clipPath !== "none" || s.clip !== "auto" ||
          s.maskImage !== "none" || s.filter !== "none" ||
          s.mixBlendMode !== "normal" || s.textOverflow === "ellipsis"
        ) hazards.push("unsupported clipping/paint");
        if (
          [s.overflowX, s.overflowY].some((v) =>
            ["hidden", "clip", "scroll", "auto"].includes(v)
          ) && rects.some((r) => !contains(box(a.getBoundingClientRect()), r))
        ) hazards.push("clipped content");
      }
      const s = getComputedStyle(e);
      if (
        text &&
        (alpha(s.color) || alpha(s.webkitTextFillColor) ||
          parseFloat(s.fontSize) <= 0)
      ) hazards.push("transparent text");
      for (const pseudo of ["::before", "::after"]) {
        const p = getComputedStyle(e, pseudo);
        if (!["none", "normal"].includes(p.content) && p.display !== "none") {
          hazards.push("unsupported generated paint");
        }
      }
      if (
        !rects.length || rects.some((r) =>
          r.width <= 0 || r.height <= 0 ||
          !contains(box(q.getBoundingClientRect()), r)
        )
      ) hazards.push("missing/outside qualification range");
    };
    const frame = {
      x: scrollX,
      y: scrollY,
      width: innerWidth,
      height: innerHeight,
    };
    const hit = (r, owner, allowDescendants) => {
      const i = intersect(r, frame);
      const bounds = i
        ? {
          left: Math.ceil(i.x - scrollX),
          top: Math.ceil(i.y - scrollY),
          right: Math.ceil(i.x + i.width - scrollX),
          bottom: Math.ceil(i.y + i.height - scrollY),
        }
        : { left: 0, top: 0, right: 0, bottom: 0 };
      const count = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
      let tested = 0, failed = 0, witness = null;
      for (let y = bounds.top; y < bounds.bottom; y++) {
        for (let x = bounds.left; x < bounds.right; x++) {
          const top = document.elementFromPoint(x, y);
          tested++;
          if (
            !top || !(top === owner || allowDescendants && owner.contains(top))
          ) {
            failed++;
            witness ??= { x, y, index: top ? all.indexOf(top) : null };
          }
        }
      }
      return {
        intersection: i,
        samples: { ...bounds, count, tested, failed, witness },
      };
    };
    const members = [...q.querySelectorAll("*")];
    const descendants = members.map((e) => {
      const s = getComputedStyle(e), r = box(e.getBoundingClientRect());
      // All descendants are represented, even non-painting wrappers. Never drop
      // zero-area SVG painters: the unchanged outer geometry guard binds them;
      // within qualification this unsupported case fails closed.
      const rects = [...e.getClientRects()].map(box);
      inspect(e, rects, false);
      return {
        index: all.indexOf(e),
        tag: e.tagName,
        box: r,
        rects,
        text: e.textContent,
        style: [...s].map((k) => [k, s.getPropertyValue(k)]),
      };
    });
    const ranges = [], localRanges = [];
    for (const e of [q, ...members]) {
      for (const [nodeIndex, n] of [...e.childNodes].entries()) {
        if (n.nodeType !== Node.TEXT_NODE || !n.data.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()].map(box);
        inspect(e, rects, true);
        const id = {
          index: all.indexOf(e),
          nodeIndex,
          text: n.data,
          start: 0,
          end: n.length,
          rects,
        };
        ranges.push(id);
        localRanges.push(rects.map((r) => hit(r, e, false)));
      }
    }
    const r = box(q.getBoundingClientRect());
    inspect(q, [r], false);
    return {
      canonical: {
        selector,
        count: qs.length,
        index: all.indexOf(q),
        box: r,
        text: q.textContent,
        role: q.getAttribute("role"),
        descendants,
        ranges,
        hazards,
      },
      ...hit(r, q, true),
      ranges: localRanges,
      descendants: members.map((e) =>
        [...e.getClientRects()].map((r) => hit(box(r), e, true))
      ),
    };
  }, selector);
  // Chromium accessibility tree computes the actual name (aria-labelledby wins
  // over aria-label); never mistake the latter attribute for accessible name.
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    const ax = nodes[0];
    raw.canonical.accessibility = {
      role: ax?.role?.value ?? null,
      name: ax?.name?.value ?? null,
      ignored: ax?.ignored ?? true,
    };
  } finally {
    await cdp.detach();
  }
  raw.canonical.textDigest = digest(raw.canonical.text);
  raw.canonical.nameDigest = digest(raw.canonical.accessibility.name);
  raw.canonical.contentDigest = digest({
    descendants: raw.canonical.descendants,
    ranges: raw.canonical.ranges,
  });
  return raw;
}

export function qualificationIssues(observation, expected) {
  const q = observation.qualification, c = q?.canonical;
  check(
    keys(q, [
      "canonical",
      "intersection",
      "samples",
      "ranges",
      "descendants",
    ]) &&
      keys(c, [
        "selector",
        "count",
        "index",
        "box",
        "text",
        "role",
        "descendants",
        "ranges",
        "hazards",
        "accessibility",
        "textDigest",
        "nameDigest",
        "contentDigest",
      ]),
    "invalid qualification schema",
  );
  check(
    expected &&
      Object.values(expected).every((s) =>
        typeof s === "string" && s.length > 0
      ),
    "missing fixture expectation",
  );
  check(
    c && c.selector === expected.selector && c.count === 1 &&
      Number.isInteger(c.index) && c.index >= 0 && rectangle(c.box),
    "invalid canonical qualification",
  );
  const doc = { x: 0, y: 0, ...observation.document };
  check(
    same(intersection(c.box, doc), c.box),
    "qualification outside document",
  );
  check(
    c.text === expected.text && c.role === expected.role &&
      c.accessibility?.role === expected.role &&
      c.accessibility.name === expected.name &&
      c.accessibility.ignored === false,
    "fixture copy/role/accessible name mismatch",
  );
  check(
    c.textDigest === digest(c.text) &&
      c.nameDigest === digest(c.accessibility.name),
    "text/name digest mismatch",
  );
  check(
    Array.isArray(c.hazards) && c.hazards.length === 0,
    "unreadable qualification content",
  );
  check(
    Array.isArray(c.descendants) && Array.isArray(c.ranges) &&
      c.ranges.length > 0 &&
      c.contentDigest ===
        digest({ descendants: c.descendants, ranges: c.ranges }),
    "missing/changed meaningful content",
  );
  const indices = [c.index, ...c.descendants.map((d) => d.index)];
  check(
    new Set(indices).size === indices.length &&
      indices.every((n, i) =>
        Number.isInteger(n) && (i === 0 || n > indices[i - 1])
      ),
    "reordered/missing descendants",
  );
  for (const d of c.descendants) {
    check(
      keys(d, ["index", "tag", "box", "rects", "text", "style"]) &&
        typeof d.tag === "string" && rectangle(d.box) &&
        Array.isArray(d.style) && d.style.length > 0 &&
        typeof d.text === "string",
      "invalid descendant paint",
    );
  }
  check(
    c.ranges.map((r) => r.text).join("") === c.text,
    "omitted/truncated text ranges",
  );
  const verifyHit = (r, hit) => {
    const frame = { ...observation.scroll, ...observation.context.viewport };
    check(Object.values(frame).every(Number.isFinite), "invalid frame");
    const i = intersection(r, frame),
      bounds = sampleBounds(i, observation.scroll);
    check(hit && same(hit.intersection, i), "falsified intersection");
    const s = hit.samples;
    check(
      keys(s, [
        "left",
        "top",
        "right",
        "bottom",
        "count",
        "tested",
        "failed",
        "witness",
      ]) && Object.entries(bounds).every(([k, v]) => s[k] === v) &&
        s.tested === bounds.count && s.failed === 0 && s.witness === null &&
        (!i || bounds.count > 0),
      `incomplete/occluded hit grid: ${JSON.stringify({ r, s, bounds })}`,
    );
  };
  verifyHit(c.box, q);
  check(
    Array.isArray(q.descendants) &&
      q.descendants.length === c.descendants.length,
    "missing descendant hit evidence",
  );
  for (const [i, d] of c.descendants.entries()) {
    check(
      Array.isArray(d.rects) && d.rects.length > 0 &&
        Array.isArray(q.descendants[i]) &&
        q.descendants[i].length === d.rects.length,
      "missing descendant ranges",
    );
    for (const [j, r] of d.rects.entries()) {
      check(
        rectangle(r) && same(intersection(r, c.box), r),
        "clipped descendant range",
      );
      verifyHit(r, q.descendants[i][j]);
    }
  }
  check(
    Array.isArray(q.ranges) && q.ranges.length === c.ranges.length,
    "missing range evidence",
  );
  for (const [i, r] of c.ranges.entries()) {
    check(
      indices.includes(r.index) && typeof r.text === "string" &&
        r.start === 0 && r.end === r.text.length && Array.isArray(r.rects) &&
        r.rects.length > 0 && q.ranges[i].length === r.rects.length,
      "invalid text range",
    );
    for (const [j, rect] of r.rects.entries()) {
      check(
        rectangle(rect) && same(intersection(rect, c.box), rect),
        "clipped text range",
      );
      verifyHit(rect, q.ranges[i][j]);
    }
  }
}
