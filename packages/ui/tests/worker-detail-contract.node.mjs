import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const { computeSourceIdentity } = await import(
  new URL("../scripts/render-paper-references.mjs", import.meta.url).href
);
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(resolve("apps/web/package.json"));
const { createServer } = await import(require.resolve("vite"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { alias: { "@bakery/i18n": resolve("packages/i18n/src/index.ts") } },
});
try {
  const { WorkerReadOnlyDetail } = await server.ssrLoadModule(
    "/packages/ui/src/templates/WorkerReadOnlyDetail.tsx",
  );
  const { createTranslator } = await server.ssrLoadModule(
    "/packages/i18n/src/index.ts",
  );
  const { workerDetailStates } = await server.ssrLoadModule(
    "/packages/ui/src/fixtures/worker-readiness.ts",
  );
  for (const state of workerDetailStates) {
    for (const locale of ["en", "en-XA", "ar-XB"]) {
      const html = renderToStaticMarkup(
        React.createElement(WorkerReadOnlyDetail, {
          state,
          t: createTranslator({ locale }),
        }),
      );
      assert(
        !/<(?:button|a|input)\b|\b(?:tabindex|onclick|onkeydown)=|role="(?:button|tab|link)"/i
          .test(html),
        state + " executable artwork",
      );
      assert(
        html.includes("synthetic") && html.includes("unproved") &&
          html.includes("Codex login"),
        state + " missing qualification",
      );
      assert(html.includes(`data-fixture-id="worker-detail-${state}"`));
      const qualification = html.match(
        /<section\b[^>]*class="ui-worker-detail__boundary"[^>]*>/,
      )?.[0];
      assert(qualification, state + " missing qualification section");
      assert.match(qualification, /\brole="region"/);
      assert.match(qualification, /\baria-label="[^"]+"/);
      if (state !== "ready" && state !== "worstcase") {
        assert(!html.includes("Machine online"));
        assert(!html.includes("0.153.4"));
      } else {for (
          const text of ["Codex", "Claude Code", "0.153.4", "2.1.263", "0.85.1"]
        ) {
          assert(html.includes(text));
        }}
    }
  }
  console.log(
    "42 SSR state/locale combinations: inert artwork, visible qualifications, negative-state facts, fixture IDs passed",
  );
} finally {
  await server.close();
}

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const base = "docs/technical-design/ui-baselines/";
const runtime = await json(base + "runtime-cases.json");
const catalog = await json(base + "components.json");
const baselines = await json(base + "paper-baselines.json");
const directory = "docs/technical-design/worker-readiness/";
const manifest = await json(directory + "paper-manifest.json");
const profile = await json(directory + "source-profile.json");
assert.deepEqual(profile, baselines.sourceProfiles["K-0"]);
assert.equal(
  (await computeSourceIdentity(baselines, { sourceProfile: "K-0" })).digest,
  profile.source.digest,
);
assert.equal(manifest.screens.length, 12);
for (const input of manifest.inputs) {
  assert.equal(
    createHash("sha256").update(await readFile(directory + input.path)).digest(
      "hex",
    ),
    input.sha256,
    input.path,
  );
}
for (
  const [surface, count] of [["list", 42], ["enrollment", 44], ["detail", 40]]
) {
  assert.equal(
    runtime.cases.filter((c) => c.id.startsWith(`wr.${surface}.`)).length,
    count,
  );
}
const cases = runtime.cases.filter((c) => c.id.startsWith("wr.detail."));
assert.equal(new Set(cases.map((c) => c.id)).size, 40);
const entry = catalog.entries.find((e) =>
  e.id === "template.workerReadOnlyDetail"
);
assert.deepEqual(
  entry.requiredCases.map((c) => c.id).sort(),
  cases.map((c) => c.id).sort(),
);
assert.equal(
  cases.filter((c) => !c.context.startsWith("paper-detail-")).length,
  38,
);
for (const c of cases) {
  assert.equal(c.storyId, "bakery-templates-workerreadonlydetail--contract");
  assert.equal(c.catalogId, entry.id);
  if (!c.context.startsWith("paper-detail-")) {
    assert(!c.paperBaselineId);
    assert(!c.sourceProvenance);
    continue;
  }
  const baseline = baselines.cases.find((b) => b.id === c.paperBaselineId);
  assert.equal(c.args.state, "ready");
  assert.equal(
    baseline.frameId,
    c.context.endsWith("phone") ? "90D-0" : "8Y2-0",
  );
  assert.deepEqual(baseline.viewport, runtime.contexts[c.context].viewport);
  assert.equal(baseline.theme, "light");
  assert.equal(baseline.sourceDigest, profile.source.digest);
}
console.log(
  "126 cases, 38+2 detail, exact-positive-only bindings, all source bytes and K-0 identity passed",
);

// Original ten-frame input bytes remain pinned when extending the source profile.
const inheritedInputs = {
  "source/list-light-desktop-8SD-0.react-css.txt":
    "085163150328eabcee56e57baeb74071192a0959b38fdda31643c9c4c2fdc5dc",
  "source/list-light-desktop-8SD-0.png":
    "9673c25481d1e59e2e68f26c0977e44630c0333321f3c84d96e4b9a2a93c3e37",
  "source/list-light-mobile-8SE-0.react-css.txt":
    "ef333be42838cb36a9ca998c1d92bef1733afd921961dbd94d9ced0554495fa6",
  "source/list-light-mobile-8SE-0.png":
    "f8d5bb77953da08df4962d2c24ee5b1e4fadcfbeca05fc087cdf04e74f4b95ea",
  "source/list-dark-desktop-A8Y-0.react-css.txt":
    "b09624c242e4f7e754e54efafb21bdec17c5c5207f06f45d9932648a8e1b35a2",
  "source/list-dark-desktop-A8Y-0.png":
    "398f57b0a5fee8db66e573dba797f9fca9c199f89c5480d8919c1e035e4a7157",
  "source/list-dark-mobile-AD7-0.react-css.txt":
    "877fb50e0925a76266937e9400b7971448f07dcc7312426f9eda7fa91056290c",
  "source/list-dark-mobile-AD7-0.png":
    "496f94c249ce703d537610446da9e77111f6c1ef5e86aa3c8f7bf3a4e546b6dd",
  "source/onboarding-start-light-desktop-9VJ-0.react-css.txt":
    "4e5a8a5a762c7c83985490ddcd1ff5c139dc9041fbb28d521a3c681cd4264c8e",
  "source/onboarding-start-light-desktop-9VJ-0.png":
    "964168d498328d82468b7ec89e4374ca948ad34e15466097751fe7382976b365",
  "source/onboarding-start-light-mobile-9ZB-0.react-css.txt":
    "bb75b3adfcf0df990cb76533a1c0f8ed8afcc0ea7ede9d3df8eea3013aa7de16",
  "source/onboarding-start-light-mobile-9ZB-0.png":
    "816ca036dcc52c2490d2f239c3d93fac43618c4b423b722ee7c57df1b0458021",
  "source/onboarding-listening-light-desktop-AMY-0.react-css.txt":
    "9be190d0784dc9e74001d74c325b17f99fda938791393c6df92ab45e132b5f0e",
  "source/onboarding-listening-light-desktop-AMY-0.png":
    "4e068c8c34c7d4cea6ac70fabb56fe851df066f99a46d5b2554b50d6fffbfecc",
  "source/onboarding-listening-light-mobile-AR1-0.react-css.txt":
    "174ff0f687a73d4e7fd710c581b83c941d85d9a82850a7eb75104c69a104d479",
  "source/onboarding-listening-light-mobile-AR1-0.png":
    "e49d7e24752676260998bbdd744117078fafde4f3f146b22001ef86dad7b3a3f",
  "source/onboarding-connected-light-desktop-ATN-0.react-css.txt":
    "39a30de42460ca0820dfc0cea19928f7f6fa46ea3cd6ba3714e000f659611d8a",
  "source/onboarding-connected-light-desktop-ATN-0.png":
    "525209f0cf058239ef9c61379a841c26321c9cfe4d8e0a0cabe3e2748113e29b",
  "source/onboarding-connected-light-mobile-AXQ-0.react-css.txt":
    "b5ebcd2538079e7c77e460e9879d3a40778b2451c3caccaa8db85bc358bc9c1f",
  "source/onboarding-connected-light-mobile-AXQ-0.png":
    "50ae1ae4dc666a83145dd3b239996f63e72211ebcdac68f94dfe6ea6e4c88926",
  "source/02e-onboarding-realtime-motion-contract-B0C-0.react-css.txt":
    "4c8c8d39c88199591998171024ba642589e763297d5f25a2b719e41cee4d9cb4",
  "source/00-machines-scope-states-components-A5P-0.react-css.txt":
    "aff8cbd35578b004941aa22973f5615598dcce8bc3566ddd878b2735c39336a5",
  "theme-values.json":
    "a28d02101d28163ad7059df6542b3360bf44d4e1fcdb27da747a4b99959c2775",
  "source/assets/31Q0XHM9CWZXZBJC5KE8YZ9DZP.png":
    "acfbad4b08dc1e7b4f7fa929b4138c59ddf644c181cbb5f698a2a37c462a3baa",
  "fonts/fonts-provenance.json":
    "ef8c5719b9a6e06dbf0875d970f2937beba463789a8f156f60559b4df1da0392",
  "fonts/geist-mono-600.ttf":
    "fc769c5ca65bd787040f8c6fa273d8fc882eed881110de880b0911c5d8e8bc68",
  "fonts/geist-mono-500.ttf":
    "5c1b7b77c2d6132460f03b60c175adc80da1ebd0b418c785135b1aed27a28b30",
  "fonts/geist-mono-400.ttf":
    "7022da390e9b401ea35b722f8ed2376948e70add10954bc798839b4bfe17ef3f",
  "fonts/geist-600.ttf":
    "7171f481b121803d007f5c6c76cd9988c0d41cce4202db9a18dff9945505d36d",
  "fonts/geist-500.ttf":
    "a8eefb873ba9c9020665f8a98302697ce1f3b79ab2deef6ee508c0ca6a82e876",
  "fonts/geist-400.ttf":
    "ccce59465ae5c61930ada5453834f60500fbd95084d85db63e0e65fad0125455",
};
assert.equal(Object.keys(inheritedInputs).length, 31);
assert.equal(manifest.inputs.length, 35);
for (const [path, sha256] of Object.entries(inheritedInputs)) {
  assert.equal(
    manifest.inputs.find((input) => input.path === path)?.sha256,
    sha256,
  );
}
