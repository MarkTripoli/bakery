import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureViewportBundleV2,
  expectedWorkerQualification,
} from "../scripts/native-viewport-bundle-v2.mjs";
import {
  viewportBundleIdentity,
  viewportBundleIssues,
} from "../scripts/native-viewport-bundle.mjs";
import { exactCoverage } from "../scripts/qualification-visible-union.mjs";

const enabled = process.env.BROWSER_TESTS === "1";
const root = resolve(process.env.V2_TEST_OUTPUT ?? ".tmp/v2-tests");
const hash = (b) => createHash("sha256").update(b).digest("hex");
let browser;
before(async () => {
  if (enabled) {
    await mkdir(root, { recursive: true });
    browser = await chromium.launch();
  }
});
after(async () => {
  await browser?.close();
});
async function fixture(name, height = 500, mutate) {
  const viewport = { width: 640, height: 360 };
  const identity = viewportBundleIdentity({
    id: name,
    catalogId: "template.workerReadOnlyDetail",
    viewport,
    dpr: 1,
    pointer: "fine",
    locale: "en-US",
    timezone: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const expected = await expectedWorkerQualification(identity);
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><style>body{margin:0}span{display:block}.ui-worker-detail__boundary{height:${height}px;background:#ffe099}#tail{height:720px;background:linear-gradient(#334455,#aabbcc)}</style><section class="ui-worker-detail__boundary" role="region"><span></span></section><div id="tail">Native tail</div>`,
  );
  await page.locator("section").evaluate((e, expected) => {
    e.setAttribute("aria-label", expected.name);
    e.firstElementChild.textContent = expected.text;
  }, expected);
  if (name === "fractional") {
    await page.locator("section").evaluate((e) => {
      e.style.cssText =
        "margin-top:0.25px;height:499.75px;padding-top:0.75px;box-sizing:border-box";
    });
  }
  if (mutate) await page.evaluate(mutate);
  try {
    return {
      ...(await captureViewportBundleV2(page, {
        root,
        directory: join(root, `${name}.full-ui`),
        identity,
        expectedQualification: expected,
      })),
      identity,
    };
  } finally {
    await context.close();
  }
}
test("exact union rejects final row and fractional gaps", () => {
  const q = { x: 0.25, y: 0.25, width: 10, height: 10 };
  assert.equal(exactCoverage(q, [q]), true);
  assert.equal(exactCoverage(q, [{ ...q, height: 9 }]), false);
  assert.equal(exactCoverage(q, [{ ...q, height: 9.999 }]), false);
});
for (
  const [name, height] of [
    ["short", 120],
    ["exact-height", 360],
    ["tall", 500],
    ["fractional", 500.75],
  ]
) {
  test(`real native v2 ${name}`, { skip: !enabled }, async () => {
    const { reference, identity, manifest } = await fixture(name, height);
    assert.deepEqual(await viewportBundleIssues(root, reference, identity), []);
    assert.ok(
      manifest.frames.some((f) => f.before.qualification.intersection === null),
    );
  });
}
test(
  "fractional edge with foreign native hit fails closed",
  { skip: !enabled },
  async () => {
    await assert.rejects(
      fixture("fractional-foreign-hit", 500.25),
      /incomplete\/occluded hit grid/,
    );
  },
);
const mutations = {
  missing: () => document.querySelector("section").remove(),
  hidden: () => document.querySelector("span").style.visibility = "hidden",
  transparent: () => document.querySelector("span").style.color = "transparent",
  clipped: () => {
    const s = document.querySelector("span");
    s.style.cssText = "display:block;height:1px;overflow:hidden";
  },
  changed: () => document.querySelector("span").textContent = "Changed meaning",
  name: () =>
    document.querySelector("section").setAttribute("aria-label", "Wrong"),
  role: () => document.querySelector("section").setAttribute("role", "note"),
  duplicate: () =>
    document.body.append(document.querySelector("section").cloneNode(true)),
  occluded: () => {
    const e = document.createElement("div");
    e.style.cssText =
      "position:absolute;left:0;top:0;width:1px;height:1px;background:red";
    document.body.append(e);
  },
  internal: () => {
    const e = document.createElement("div");
    e.style.cssText =
      "position:absolute;left:0;top:0;width:640px;height:35px;background:red";
    document.querySelector("section").append(e);
  },
  lastrow: () => {
    const e = document.createElement("div");
    e.style.cssText =
      "position:absolute;left:0;top:499px;width:640px;height:1px;background:red";
    document.body.append(e);
  },
};
for (const [name, mutation] of Object.entries(mutations)) {
  test(`reject real ${name}`, { skip: !enabled }, async () => {
    await assert.rejects(
      fixture(`negative-${name}`, 500, mutation),
      /Qualification:|Viewport bundle:/,
    );
  });
}
test("independent rehashed corruptions of genuine native bundle", {
  skip: !enabled,
}, async (t) => {
  const { reference, identity, manifest } = await fixture("offline", 500);
  const mutations = {
    missing: (m) => m.frames.splice(1, 1),
    last: (m) => m.frames.pop(),
    first: (m) => m.frames.shift(),
    reordered: (m) => m.frames.reverse(),
    reindexed: (m) => {
      m.frames.splice(1, 1);
      m.frames.forEach((f, i) => f.index = i);
    },
    unknown: (m) => m.version = "unknown",
    mixed: (m) => m.version = "native-viewport-bundle-v1",
    missingVersion: (m) => delete m.version,
    missingContract: (m) => delete m.qualificationContract,
    unknownContract: (m) => m.qualificationContract = "unknown",
    partialQ: (m) =>
      m.frames[0].before.qualification.intersection.height -= 0.001,
    partialDocument: (m) => m.frames.at(-1).rect.height -= 1,
    grid: (m) => m.frames[0].before.qualification.samples.tested--,
    witness: (m) =>
      m.frames[0].before.qualification.samples.witness = {
        x: 0,
        y: 0,
        index: null,
      },
    descendants: (m) =>
      m.frames[0].before.qualification.canonical.descendants = [],
    missingPaintProof: (m) =>
      delete m.frames[0].before.qualification.descendants,
    stalePng: (m) => m.frames[0].sha256 = "0".repeat(64),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const m = structuredClone(manifest);
      mutate(m);
      const bytes = Buffer.from(JSON.stringify(m));
      await writeFile(join(root, reference.manifestPath), bytes);
      assert.notDeepEqual(
        await viewportBundleIssues(root, {
          ...reference,
          manifestSha256: hash(bytes),
        }, identity),
        [],
      );
    });
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, reference.manifestPath), bytes);
  assert.deepEqual(
    await viewportBundleIssues(root, {
      ...reference,
      manifestSha256: hash(bytes),
    }, identity),
    [],
  );
  assert.ok((await readFile(join(root, manifest.frames[0].path))).length > 0);
});

test("expected qualification follows unchanged story translation precedence", async () => {
  const base = { catalogId: "template.workerReadOnlyDetail", locale: "en-US" };
  const english = await expectedWorkerQualification(base);
  const expanded = await expectedWorkerQualification({
    ...base,
    id: "wr.detail.worstcase.zoom-200",
  });
  const pseudo = await expectedWorkerQualification({
    ...base,
    locale: "en-XA",
  });
  const rtl = await expectedWorkerQualification({ ...base, direction: "rtl" });
  assert.deepEqual(expanded, pseudo);
  assert.notDeepEqual(english, expanded);
  assert.notDeepEqual(english, rtl);
  assert.deepEqual(
    await expectedWorkerQualification({
      ...base,
      id: "wr.detail.worstcase.rtl",
      direction: "rtl",
    }),
    expanded,
  );
});
