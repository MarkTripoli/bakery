import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { captureK0Raster, verifyK0RasterProfile } from "./paper-k0-raster.mjs";
import {
  K0_ADAPTER_VERSION,
  paperRasterContext,
} from "./paper-browser-profile.mjs";
import { pngDimensions } from "./image-score.mjs";
import { viewportBundleRecordIssues } from "./native-viewport-bundle.mjs";

export const WHOLE_ARTBOARD_VERSION = "paper-k0-whole-artboard-v1";
export const WHOLE_ARTBOARD_BINDING = Object.freeze({
  contractVersion: WHOLE_ARTBOARD_VERSION,
  targetSelector: '[data-paper-whole-artboard="worker-detail"]',
  qualificationSelector: ".ui-worker-detail__boundary",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const metadataDigest = (value) => hash(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message) => {
  throw new Error(`Whole artboard: ${message}`);
};
const exactKeys = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Only the two admitted complete-detail positives can request paired capture. */
export function wholeArtboardBindingIssues(
  baseline,
  binding = baseline.wholeArtboardCapture,
) {
  if (binding === undefined) {
    return baseline.design?.screen === "detail" &&
        baseline.sourceProfile === "K-0"
      ? ["detail requires explicit wholeArtboardCapture"]
      : [];
  }
  const phone = baseline.id === "detail.default.light.phone";
  const allowed = phone || baseline.id === "detail.default.light.desktop";
  return allowed && baseline.sourceProfile === "K-0" &&
      baseline.reference === "design" &&
      baseline.frameId === (phone ? "90D-0" : "8Y2-0") &&
      baseline.candidate?.storyId ===
        "bakery-templates-workerreadonlydetail--contract" &&
      baseline.candidate?.args?.state === "ready" &&
      baseline.catalogId === "template.workerReadOnlyDetail" &&
      baseline.requiredStoryCase ===
        `wr.detail.ready.paper-detail-light-${phone ? "phone" : "desktop"}` &&
      baseline.design?.state === "default" && baseline.theme === "light" &&
      same(
        baseline.artboard,
        phone ? { width: 390, height: 1483 } : { width: 1440, height: 960 },
      ) &&
      !baseline.comparisonRegion && !baseline.comparisonMask &&
      exactKeys(binding, Object.keys(WHOLE_ARTBOARD_BINDING)) &&
      Object.entries(WHOLE_ARTBOARD_BINDING).every(([key, value]) =>
        binding[key] === value
      )
    ? []
    : ["invalid explicit whole-artboard binding (not a region or main alias)"];
}

const requiredSelectors = (
  phone,
) => [
  ".bakery-app-shell",
  ".bakery-app-shell__header",
  ".bakery-app-shell__main",
  ".ui-worker-detail__intro",
  ".ui-worker-detail__harnesses",
  ".ui-worker-detail__inspector",
  ".ui-worker-detail__tabs",
  ".ui-worker-detail__intro .ui-button",
  ".ui-worker-detail__harness:nth-of-type(1)",
  ".ui-worker-detail__harness:nth-of-type(2)",
  ".ui-worker-detail__harness:nth-of-type(1) .ui-worker-detail__versions",
  ".ui-worker-detail__harness:nth-of-type(2) .ui-worker-detail__versions",
  ".ui-worker-detail__inspector > div:nth-child(1)",
  ".ui-worker-detail__inspector > div:nth-child(2)",
  ".ui-worker-detail__inspector > div:nth-child(3)",
  ...(phone
    ? [
      ".ui-worker-detail__phone-status",
      ".ui-worker-detail__mobile-header",
      ".ui-worker-detail__footer",
    ]
    : [
      ".ui-worker-detail__rail",
      ".ui-worker-detail__desktop-header",
      ".ui-worker-detail__identity",
    ]),
];

/** Identity shared by both files and the browser receipt, never caller flags. */
export function pairedIdentity(candidate, baseline) {
  return {
    caseId: candidate.id,
    state: baseline.candidate.args.state,
    sourceProfile: baseline.sourceProfile,
    sourceDigest: baseline.sourceDigest,
    originalPng: { sha256: baseline.imageSha256, ...baseline.artboard },
    candidateDigest: metadataDigest({
      sourceCommit: candidate.sourceCommit,
      sourceDiffDigest: candidate.sourceDiffDigest,
    }),
    buildDigest: candidate.storybookBuildDigest,
    themeDigest: metadataDigest({
      tokenDigest: candidate.tokenDigest,
      tokenRevision: candidate.tokenRevision,
      theme: candidate.colorScheme,
      storedPreference: candidate.storedPreference,
    }),
    contextDigest: metadataDigest(paperRasterContext(candidate)),
  };
}

/** DOM evidence is deliberately serializable so consumers can check bounds,
 * uniqueness, accessibility and completeness instead of accepting true flags. */
export function observeWholeArtboard(page, binding) {
  return page.evaluate(
    (
      {
        targetSelector,
        qualificationSelector,
        desktopSelectors,
        phoneSelectors,
      },
    ) => {
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return {
          x: r.x + scrollX,
          y: r.y + scrollY,
          width: r.width,
          height: r.height,
        };
      };
      const visible = (element) => {
        if (
          !element ||
          !element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        ) return false;
        for (let node = element; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (
            node.hidden || s.opacity !== "1" || s.visibility !== "visible" ||
            s.contentVisibility === "hidden"
          ) return false;
        }
        const r = rect(element);
        return r.width > 0 && r.height > 0;
      };
      const describe = (element) => {
        const s = getComputedStyle(element);
        return {
          tag: element.tagName,
          className: element.getAttribute("class"),
          box: rect(element),
          visible: visible(element),
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          accessible: !element.closest(
            '[aria-hidden="true"], [inert], [hidden]',
          ),
          style: Array.from(s).map((key) => `${key}:${s.getPropertyValue(key)}`)
            .join(";"),
        };
      };
      const targets = [...document.querySelectorAll(targetSelector)];
      const qualifications = [
        ...document.querySelectorAll(qualificationSelector),
      ];
      if (targets.length !== 1 || qualifications.length !== 1) {
        return {
          targetCount: targets.length,
          qualificationCount: qualifications.length,
        };
      }
      const target = targets[0], qualification = qualifications[0];
      const root = target.closest('[data-ui-component="workerReadOnlyDetail"]');
      const phone = innerWidth < 744;
      const required = phone ? phoneSelectors : desktopSelectors;
      // Only existing responsive alternatives may be absent. Hiding any other
      // artwork is a capture failure, including entire parent subtrees.
      const responsive = phone
        ? ".bakery-app-shell__rail,.ui-worker-detail__desktop-header,.ui-worker-detail__breadcrumb-desktop"
        : ".ui-worker-detail__phone-status,.ui-worker-detail__mobile-header,.ui-worker-detail__breadcrumb-mobile,.ui-worker-detail__footer";
      const elements = [...target.querySelectorAll("*")];
      return {
        targetCount: targets.length,
        qualificationCount: qualifications.length,
        target: describe(target),
        qualification: {
          ...describe(qualification),
          text: qualification.textContent,
          label: qualification.getAttribute("aria-label"),
          textElements: [qualification, ...qualification.querySelectorAll("*")]
            .filter((element) =>
              [...element.childNodes].some((node) =>
                node.nodeType === Node.TEXT_NODE && node.textContent.trim()
              )
            )
            .map((element) => {
              let unclipped = true;
              const box = rect(element);
              for (let node = element; node; node = node.parentElement) {
                const style = getComputedStyle(node), bounds = rect(node);
                if (
                  style.clipPath !== "none" || style.maskImage !== "none" ||
                  style.filter !== "none" ||
                  (style.overflowX !== "visible" &&
                    (box.x < bounds.x ||
                      box.x + box.width > bounds.x + node.clientWidth)) ||
                  (style.overflowY !== "visible" &&
                    (box.y < bounds.y ||
                      box.y + box.height > bounds.y + node.clientHeight))
                ) unclipped = false;
              }
              return { ...describe(element), unclipped };
            }),
        },
        structure: Boolean(
          root && target.parentElement === root &&
            qualification.parentElement === root &&
            root.children.length === 2 && !target.contains(qualification),
        ),
        state: root?.getAttribute("data-state"),
        required: required.map((selector) => ({
          selector,
          elements: [...target.querySelectorAll(selector)].map(describe),
        })),
        hiddenArtwork: elements.filter((element) =>
          !visible(element) && !element.closest(responsive) &&
          // SVG definitions and empty structural nodes have no visible artwork.
          !element.closest("defs,clipPath") &&
          (element.textContent.trim() ||
            /^(IMG|SVG|BUTTON)$/.test(element.tagName))
        ).map((element) => element.outerHTML),
        elements: elements.filter(visible).map(describe),
        html: root?.outerHTML,
        fonts: [...document.fonts].map((
          font,
        ) => [font.family, font.weight, font.status]),
        document: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
      };
    },
    {
      ...binding,
      desktopSelectors: requiredSelectors(false),
      phoneSelectors: requiredSelectors(true),
    },
  );
}

export function wholeArtboardObservationIssues(observed, reference) {
  const issues = [];
  const inside = (a, b) =>
    a && b && a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width &&
    a.y + a.height <= b.y + b.height;
  if (
    !observed || observed.targetCount !== 1 || observed.qualificationCount !== 1
  ) return ["missing or duplicate target/qualification"];
  const t = observed.target, q = observed.qualification;
  if (
    !t?.visible || t.box?.width !== reference.width ||
    t.box?.height !== reference.height || !observed.structure ||
    observed.state !== "ready"
  ) issues.push("partial target or natural geometry mismatch");
  if (
    !q?.visible || !q.accessible || !q.text?.trim() || !q.label?.trim() ||
    q.box.y + q.box.height > t?.box?.y
  ) issues.push("hidden/inaccessible/overlapping qualification");
  if (
    !q?.textElements?.length ||
    q.textElements.some((element) =>
      !element.visible || !element.accessible || !element.unclipped ||
      !inside(element.box, q.box) ||
      element.scrollWidth > element.clientWidth ||
      element.scrollHeight > element.clientHeight
    )
  ) issues.push("hidden or clipped qualification text");
  if (
    !same(
      observed.required?.map((entry) => entry.selector),
      requiredSelectors(reference.width === 390),
    ) || observed.required.some((entry) =>
      entry.elements.length !== 1 || !entry.elements[0].visible ||
      !inside(entry.elements[0].box, t?.box)
    )
  ) issues.push("missing or hidden original artwork");
  if (
    !observed.elements?.length || observed.hiddenArtwork?.length ||
    observed.elements.some((element) =>
      !inside(element.box, t?.box) ||
      element.scrollWidth > element.clientWidth ||
      element.scrollHeight > element.clientHeight
    )
  ) issues.push("hidden artwork or overflow");
  if (!observed.html?.includes('data-paper-whole-artboard="worker-detail"')) {
    issues.push("missing complete DOM observation");
  }
  if (
    !observed.fonts?.length ||
    observed.fonts.some((font) => ["loading", "error"].includes(font[2]))
  ) issues.push("unsettled fonts");
  return issues;
}

/** Capture full UI first; scroll changes observation coordinates only, not
 * layout/viewport. The raster helper restores its own temporary paint style. */
export async function captureWholeArtboardPair(
  page,
  binding,
  profile,
  captureFullUI,
  assertBrowser,
) {
  const before = await observeWholeArtboard(page, binding);
  const issues = wholeArtboardObservationIssues(before, profile.reference);
  if (issues.length) fail(issues.join("; "));
  await assertBrowser();
  const snapshotNonce = randomUUID();
  const mutationKey = `bakeryPair${randomUUID()}`;
  await page.evaluate(({ key, selector }) => {
    const target = document.querySelector(selector);
    const canvas = target.parentElement;
    const originalCanvasStyle = canvas.getAttribute("style");
    const originalStyle = target.getAttribute("style");
    const transformed = document.createElement("div");
    if (originalStyle !== null) {
      transformed.setAttribute("style", originalStyle);
    }
    transformed.style.setProperty(
      "transform",
      "translateY(0.5px)",
      "important",
    );
    const backing = document.createElement("div");
    if (originalCanvasStyle !== null) {
      backing.setAttribute("style", originalCanvasStyle);
    }
    const bounds = target.getBoundingClientRect();
    const paints = [target, ...target.querySelectorAll("*")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.x === bounds.x && r.y === bounds.y && r.width === bounds.width &&
        getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)";
    });
    const fill = paints.length
      ? getComputedStyle(paints[0]).backgroundColor
      : "";
    backing.style.setProperty("background-color", fill, "important");
    const mutations = [];
    const collect = (records) => mutations.push(...records);
    const observer = new MutationObserver(collect);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    globalThis[key] = {
      observer,
      mutations,
      target,
      originalStyle,
      canvas,
      originalCanvasStyle,
      backedStyle: backing.getAttribute("style"),
      transformedStyle: transformed.getAttribute("style"),
    };
  }, { key: mutationKey, selector: binding.targetSelector });
  let fullUI;
  const originalScroll = await page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
  }));
  let parity;
  let mutationIssues;
  try {
    fullUI = await captureFullUI(snapshotNonce);
    await page.evaluate((selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      scrollTo(0, r.y + scrollY);
    }, binding.targetSelector);
    parity = await captureK0Raster(page, binding.targetSelector, profile);
  } finally {
    try {
      await page.evaluate(({ x, y }) => scrollTo(x, y), originalScroll);
    } finally {
      mutationIssues = await page.evaluate(({ key, odd }) => {
        const state = globalThis[key];
        state.mutations.push(...state.observer.takeRecords());
        state.observer.disconnect();
        delete globalThis[key];
        const records = state.mutations;
        const expected = odd
          ? [
            [state.canvas, state.originalCanvasStyle],
            [state.target, state.originalStyle],
            [state.target, state.transformedStyle],
            [state.canvas, state.backedStyle],
          ]
          : [];
        return records.length !== expected.length || records.some((record, i) =>
          record.type !== "attributes" || record.target !== expected[i]?.[0] ||
          record.attributeName !== "style" ||
          record.oldValue !== expected[i]?.[1]
        ) || state.target.getAttribute("style") !== state.originalStyle ||
          state.canvas.getAttribute("style") !== state.originalCanvasStyle;
      }, { key: mutationKey, odd: profile.offset.y !== 0 });
    }
  }
  if (mutationIssues) fail("DOM changed during paired capture");
  await assertBrowser();
  const after = await observeWholeArtboard(page, binding);
  if (!same(before, after)) {
    fail("DOM/layout/font/state changed between paired captures");
  }
  return {
    fullUI,
    parity,
    observation: before,
    snapshotNonce,
    snapshotGeneration: metadataDigest({ snapshotNonce, observation: before }),
  };
}

/** Strict manifest schema: each field records measured evidence or a digest
 * binding it to the mounted candidate. No arbitrary regions are admitted. */
export function wholeArtboardMetadataIssues(record) {
  const keys = [
    "contractVersion",
    "caseId",
    "state",
    "sourceProfile",
    "sourceDigest",
    "originalPng",
    "candidateDigest",
    "buildDigest",
    "themeDigest",
    "contextDigest",
    "snapshotGeneration",
    "adapter",
    "target",
    "fullUI",
    "parity",
    "browserContract",
    "qualification",
  ];
  if (!exactKeys(record, keys)) return ["invalid wholeArtboardCapture schema"];
  // Reject malformed nested values before dereferencing them. Consumer errors
  // must be data, not an exception that could bypass the pre-comparison gate.
  for (
    const key of [
      "originalPng",
      "adapter",
      "target",
      "fullUI",
      "parity",
      "browserContract",
      "qualification",
    ]
  ) {
    if (
      !record[key] || typeof record[key] !== "object" ||
      Array.isArray(record[key])
    ) return [`invalid ${key} schema`];
  }
  const issues = [];
  if (
    record.contractVersion !== WHOLE_ARTBOARD_VERSION ||
    record.sourceProfile !== "K-0" || record.state !== "ready" || !record.caseId
  ) issues.push("invalid contract identity");
  for (
    const key of [
      "sourceDigest",
      "candidateDigest",
      "buildDigest",
      "themeDigest",
      "contextDigest",
      "snapshotGeneration",
    ]
  ) if (!digest(record[key])) issues.push(`invalid ${key}`);
  if (
    !exactKeys(record.originalPng, ["sha256", "width", "height"]) ||
    !digest(record.originalPng.sha256)
  ) issues.push("invalid original PNG identity");
  if (
    !exactKeys(record.adapter, ["version", "implementationDigest", "x", "y"]) ||
    record.adapter.version !== K0_ADAPTER_VERSION ||
    !digest(record.adapter.implementationDigest) || record.adapter.x !== 0 ||
    record.adapter.y !== (record.originalPng.height % 2) / 2
  ) issues.push("invalid adapter");
  if (
    !exactKeys(record.target, [
      "selector",
      "naturalWidth",
      "naturalHeight",
      "completeArtwork",
    ]) || record.target.selector !== WHOLE_ARTBOARD_BINDING.targetSelector ||
    record.target.completeArtwork !== true ||
    record.target.naturalWidth !== record.originalPng.width ||
    record.target.naturalHeight !== record.originalPng.height
  ) issues.push("invalid complete target");
  if (
    !exactKeys(record.fullUI, [
      "scope",
      "adapter",
      "manifestPath",
      "manifestSha256",
    ]) ||
    record.fullUI.scope !== "full-ui-bundle" ||
    record.fullUI.adapter !== "none" ||
    typeof record.fullUI.manifestPath !== "string" ||
    !record.fullUI.manifestPath.endsWith(".full-ui/manifest.json") ||
    !digest(record.fullUI.manifestSha256)
  ) issues.push("invalid full-ui-bundle reference");
  const file = record.parity;
  if (
    !exactKeys(file, ["scope", "path", "sha256", "width", "height"]) ||
    file.scope !== "whole-artboard-parity" ||
    typeof file.path !== "string" ||
    !file.path.endsWith(".whole-artboard-parity.png") ||
    !digest(file.sha256) || !Number.isInteger(file.width) ||
    !Number.isInteger(file.height) || file.width <= 0 || file.height <= 0
  ) issues.push("invalid whole-artboard-parity file");
  if (
    record.parity.width !== record.originalPng.width ||
    record.parity.height !== record.originalPng.height
  ) issues.push("invalid paired dimensions");
  if (
    !exactKeys(record.browserContract, ["passed", "receiptSha256"]) ||
    record.browserContract.passed !== true ||
    !digest(record.browserContract.receiptSha256)
  ) issues.push("invalid browser receipt identity");
  if (
    !exactKeys(record.qualification, ["visible", "accessible", "textDigest"]) ||
    record.qualification.visible !== true ||
    record.qualification.accessible !== true ||
    !digest(record.qualification.textDigest)
  ) issues.push("invalid qualification");
  return issues;
}

export async function wholeArtboardPairIssues(root, baseline, candidate) {
  try {
    const record = candidate.wholeArtboardCapture;
    const issues = wholeArtboardBindingIssues(baseline);
    if (issues.length) return issues;
    if (!baseline.wholeArtboardCapture) {
      return record ? ["unregistered whole-artboard output"] : [];
    }
    issues.push(...wholeArtboardMetadataIssues(record));
    if (issues.length) return issues;
    if (candidate.wholeArtboardCaptureSha256 !== metadataDigest(record)) {
      issues.push("stale paired metadata hash");
    }
    if (
      candidate.id !== baseline.requiredStoryCase ||
      candidate.requiredCaseId !== baseline.requiredStoryCase ||
      candidate.storyId !== baseline.candidate.storyId ||
      candidate.status !== "passed" || !candidate.assertions?.includes("axe") ||
      !candidate.assertions?.includes("containment")
    ) issues.push("wrong case or failed browser contract");
    const original = await readFile(join(root, baseline.imagePath));
    const profile = verifyK0RasterProfile(original, candidate.rasterProfile);
    const identity = pairedIdentity(candidate, baseline);
    for (const [key, value] of Object.entries(identity)) {
      if (!same(record[key], value)) issues.push(`stale paired ${key}`);
    }
    if (
      !same(profile, baseline.rasterProfile) ||
      !same(record.adapter, {
        version: K0_ADAPTER_VERSION,
        implementationDigest: profile.implementationDigest,
        ...profile.offset,
      })
    ) issues.push("asymmetric adapter/profile");
    if (
      candidate.outputPath !== record.fullUI.manifestPath ||
      candidate.outputSha256 !== record.fullUI.manifestSha256 ||
      !same(candidate.fullUIBundle, record.fullUI)
    ) issues.push("unpaired full UI");
    const bundleIssues = await viewportBundleRecordIssues(root, candidate);
    if (bundleIssues.length) return [...issues, ...bundleIssues];
    const manifestBytes = await readFile(
      join(root, record.fullUI.manifestPath),
    );
    if (hash(manifestBytes) !== record.fullUI.manifestSha256) {
      return [...issues, "stale manifest digest"];
    }
    const manifest = JSON.parse(manifestBytes);
    for (const file of [record.parity]) {
      const bytes = await readFile(join(root, file.path));
      if (
        hash(bytes) !== file.sha256 ||
        !same(pngDimensions(bytes), { width: file.width, height: file.height })
      ) issues.push(`stale ${file.scope} bytes/dimensions`);
    }
    const receiptBytes = await readFile(
      join(root, `${record.parity.path}.browser.json`),
    );
    if (hash(receiptBytes) !== record.browserContract.receiptSha256) {
      issues.push("stale browser receipt hash");
    }
    const receipt = JSON.parse(receiptBytes);
    if (
      typeof receipt.snapshotNonce !== "string" || !receipt.snapshotNonce ||
      manifest.nonce !== receipt.snapshotNonce ||
      receipt.captureStartedAt !== candidate.captureStartedAt ||
      receipt.captureFinishedAt !== candidate.captureFinishedAt ||
      !same(receipt.assertions, candidate.assertions)
    ) issues.push("stale browser generation");
    if (
      !same(receipt.identity, identity) ||
      receipt.snapshotGeneration !== record.snapshotGeneration ||
      !same(receipt.fullUI, record.fullUI) ||
      !same(receipt.parity, record.parity) ||
      !same(receipt.adapter, record.adapter) || receipt.status !== "passed" ||
      !same(receipt.checks, [
        "runtime-assertions-before",
        "runtime-assertions-after",
        "unchanged-dom-layout-fonts",
        "whole-artboard-bounds",
      ])
    ) issues.push("unpaired or failed browser proof");
    issues.push(
      ...wholeArtboardObservationIssues(
        receipt.observation,
        record.originalPng,
      ),
    );
    if (
      metadataDigest({
          snapshotNonce: receipt.snapshotNonce,
          observation: receipt.observation,
        }) !== record.snapshotGeneration ||
      hash(receipt.observation?.qualification?.text ?? "") !==
        record.qualification.textDigest
    ) issues.push("stale generation/qualification digest");
    const naturalDocumentHeight = manifest.initial.document.height;
    if (
      !same(manifest.initial.document, receipt.observation?.document) ||
      manifest.initial.context.viewport.width !== record.parity.width ||
      !Number.isInteger(naturalDocumentHeight) ||
      naturalDocumentHeight <= record.parity.height
    ) issues.push("cropped full UI");
    if (
      typeof receipt.observation?.html !== "string" ||
      manifest.initial.rootDomDigest !== hash(receipt.observation.html)
    ) issues.push("paired root DOM mismatch");
    const qualification = receipt.observation?.qualification;
    for (const observed of [manifest.initial, manifest.frames[0].before]) {
      // The bundle validator has already admitted the exact discriminator.
      // Keep historical v1 fields untouched; v2 binds its canonical semantics.
      if (manifest.version === "native-viewport-bundle-v2") {
        const q = observed.qualification.canonical;
        if (
          q.text !== qualification?.text ||
          q.accessibility.name !== qualification?.label ||
          !same(q.box, qualification?.box) ||
          qualification?.visible !== true || !qualification?.accessible ||
          q.accessibility.ignored || q.hazards.length !== 0 ||
          hash(q.text) !== record.qualification.textDigest
        ) issues.push("paired qualification mismatch");
        continue;
      }
      const q = observed.qualification;
      if (
        q.text !== qualification?.text || q.label !== qualification?.label ||
        !same(q.box, qualification?.box) ||
        q.visible !== qualification?.visible ||
        !qualification?.accessible || q.hidden ||
        hash(q.text) !== record.qualification.textDigest
      ) issues.push("paired qualification mismatch");
    }
    return issues;
  } catch (error) {
    return [`invalid paired evidence: ${error.message}`];
  }
}
