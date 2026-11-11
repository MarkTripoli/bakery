import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  decodeViewportPng,
  observeViewportV1,
} from "./native-viewport-bundle.mjs";
import {
  exactCoverage,
  observeQualification,
  qualificationIssues,
  scrollSequence,
} from "./qualification-visible-union.mjs";

export const VIEWPORT_BUNDLE_VERSION = "native-viewport-bundle-v2";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, message) => {
  if (!ok) throw new Error(`Viewport bundle: ${message}`);
};
const isDigest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const keys = (v, expected) =>
  v && same(Object.keys(v).sort(), [...expected].sort());

async function observe(page, qualificationSelector) {
  const raw = await observeViewportV1(page, qualificationSelector);
  return {
    ...raw,
    qualification: await observeQualification(page, qualificationSelector),
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
  qualification: o.qualification.canonical,
});

function observedIssues(o, initial) {
  check(isDigest(o.rootDomDigest), "missing root DOM observation");
  check(
    same(stable(o), stable(initial)),
    `context/DOM/layout changed: ${
      Object.keys(stable(o)).filter((key) =>
        !same(stable(o)[key], stable(initial)[key])
      ).join(",")
    }`,
  );
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
export async function captureViewportBundleV2(
  page,
  {
    root,
    directory,
    identity,
    nonce = randomUUID(),
    expectedQualification,
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
    qualificationContract: "qualification-visible-union-v1",
    expectedQualification,
    scope: "full-ui-bundle",
    adapter: "none",
    identity,
    nonce,
    frames: [],
  };
  let error;
  try {
    manifest.initial = await observe(page, qualificationSelector);
    observedIssues(manifest.initial, manifest.initial);
    qualificationIssues(manifest.initial, expectedQualification);
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
      const before = await observe(page, qualificationSelector);
      observedIssues(before, manifest.initial);
      qualificationIssues(before, expectedQualification);
      check(same(before.scroll, requestedScroll), "unobserved scroll");
      const bytes = await page.screenshot();
      const after = await observe(page, qualificationSelector);
      observedIssues(after, manifest.initial);
      qualificationIssues(after, expectedQualification);
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
    manifest.restored = await observe(page, qualificationSelector);
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
  const issues = await viewportBundleV2Issues(
    root,
    reference,
    identity,
    expectedQualification,
  );
  check(!issues.length, issues.join("; "));
  return { reference, manifest };
}

/** Recompute every file, rectangle, overlap and binding; never trust coverage flags. */
export async function viewportBundleV2Issues(
  root,
  reference,
  identity,
  expectedQualification,
) {
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
        "qualificationContract",
        "expectedQualification",
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
        m.qualificationContract === "qualification-visible-union-v1" &&
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
    const expected = expectedQualification ??
      await expectedWorkerQualification(identity);
    check(
      same(m.expectedQualification, expected),
      "wrong expected fixture qualification",
    );
    qualificationIssues(m.initial, expected);
    qualificationIssues(m.restored, expected);
    const sequence = scrollSequence(m.initial.document.height, height);
    check(m.frames.length === sequence.length, "missing/extra native frame");
    const intersections = [];
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
      qualificationIssues(f.before, expected);
      qualificationIssues(f.after, expected);
      check(
        f.before.scroll.y === sequence[i],
        "unexpected native frame sequence",
      );
      if (f.before.qualification.intersection) {
        intersections.push(f.before.qualification.intersection);
      }
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
        const q = f.before.qualification.canonical.box;
        const intersection = f.before.qualification.intersection;
        check(
          intersection !== null,
          "first qualification intersection missing",
        );
        if (q.width <= width && q.height <= height) {
          check(
            same(intersection, q),
            "fitting qualification incomplete in first frame",
          );
        }
      }
      bottom = r.y + height;
      previous = { rect: r, decoded };
    }
    check(
      bottom === m.initial.document.height,
      "partial coverage: lower edge missing",
    );
    check(
      exactCoverage(m.initial.qualification.canonical.box, intersections),
      "qualification coverage gap",
    );
    check(
      exactCoverage(
        { x: 0, y: 0, width, height: m.initial.document.height },
        m.frames.map((f) => f.rect),
      ),
      "document coverage gap",
    );
    return [];
  } catch (e) {
    return [e.message];
  }
}

/** Expectations come from unchanged source catalogs, never captured DOM. */
export async function expectedWorkerQualification(identity) {
  check(
    identity.catalogId === "template.workerReadOnlyDetail",
    "missing trusted qualification expectation",
  );
  const runtime = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/technical-design/ui-baselines/runtime-cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const fixture = runtime.cases.find((c) =>
    c.id === identity.id && c.catalogId === identity.catalogId
  );
  // Match the unchanged story translator: worstcase always expands, even
  // when the browser locale is en-US; RTL uses ar-XB unless expansion wins.
  const locale =
    identity.locale === "en-XA" || fixture?.args?.state === "worstcase"
      ? "en-XA"
      : identity.direction === "rtl"
      ? "ar-XB"
      : "en";
  const catalog = JSON.parse(
    await readFile(
      new URL(`../../i18n/locales/${locale}.json`, import.meta.url),
      "utf8",
    ),
  );
  return {
    selector: ".ui-worker-detail__boundary",
    role: "region",
    name: catalog["workerDetail.disclaimer"],
    text: catalog["workerDetail.disclaimer"] + catalog["workerDetail.boundary"],
  };
}
