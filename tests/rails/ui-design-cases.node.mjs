import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DeviceChromeSchema,
  parseEnterpriseBaselines,
} from "../../packages/ui/catalog/design-cases.ts";

const BASELINES = new URL(
  "../../docs/technical-design/ui-baselines/enterprise-baselines.json",
  import.meta.url,
);
const raw = () => JSON.parse(readFileSync(BASELINES, "utf8"));
const phone = (value) =>
  value.cases.find((entry) => entry.id === "queue.default.light.phone");

function issuesFor(mutate) {
  const value = raw();
  mutate(value);
  const result = parseEnterpriseBaselines(value);
  assert.equal(result.success, false, "mutated manifest must be rejected");
  return result.issues.join("\n");
}

test("committed enterprise manifest parses and phone cases carry device chrome", () => {
  const result = parseEnterpriseBaselines(raw());
  assert.equal(result.success, true, result.issues?.join("\n"));
  const chromeIds = result.data.cases.filter((entry) => entry.deviceChrome)
    .map((entry) => entry.id).sort();
  assert.deepEqual(chromeIds, [
    "projects-onboarding.default.light.phone",
    "queue.default.light.phone",
    "task-conversation.default.light.phone",
    "task-coordination.default.light.phone",
  ]);
  for (const entry of result.data.cases) {
    if (entry.design.device === "desktop") {
      assert.equal(entry.deviceChrome, undefined, entry.id);
    }
  }
});

test("device chrome requires a nonblank reason", () => {
  assert.match(
    issuesFor((value) => {
      delete phone(value).deviceChrome.reason;
    }),
    /deviceChrome\.reason/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.reason = "   ";
    }),
    /deviceChrome\.reason/,
  );
});

test("device chrome top must be a positive integer below the artboard height", () => {
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.top = -4;
    }),
    /deviceChrome\.top/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.top = 0;
    }),
    /deviceChrome\.top/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.top = 62.5;
    }),
    /deviceChrome\.top/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.top = 844;
    }),
    /must be smaller than the artboard height 844/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.top = 900;
    }),
    /must be smaller than the artboard height/,
  );
});

test("device chrome is phone-only and bound to the case frame", () => {
  assert.match(
    issuesFor((value) => {
      const desktop = value.cases.find((entry) =>
        entry.id === "queue.default.light.desktop"
      );
      desktop.deviceChrome = { ...phone(value).deviceChrome };
    }),
    /phone cases only/,
  );
  assert.match(
    issuesFor((value) => {
      phone(value).deviceChrome.source.frameId = "ZZ-0";
    }),
    /must equal the case frameId/,
  );
});

test("device chrome schema is strict and described", () => {
  assert.equal(
    DeviceChromeSchema.safeParse({
      top: 62,
      reason: "x",
      source: { frameId: "E8-0" },
      extra: true,
    }).success,
    false,
  );
  assert.ok(DeviceChromeSchema.description);
  for (const field of Object.values(DeviceChromeSchema.shape)) {
    assert.ok(field.description?.trim(), "every field carries a description");
  }
});

test("a case carrying both deviceChrome and comparisonRegion is rejected", () => {
  const issues = issuesFor((value) => {
    phone(value).comparisonRegion = {
      x: 0,
      y: 62,
      width: 390,
      height: 100,
    };
  });
  assert.match(issues, /comparisonRegion/);
  assert.match(issues, /mutually exclusive/);
});

const WORKER_DARK = new URL(
  "../../docs/technical-design/ui-baselines/worker-dark-baselines.json",
  import.meta.url,
);
const workerDark = () => JSON.parse(readFileSync(WORKER_DARK, "utf8"));

test("the worker-dark manifest parses with a story candidate", () => {
  const result = parseEnterpriseBaselines(workerDark());
  assert.equal(result.success, true, result.issues?.join("\n"));
  assert.equal(
    result.data.cases[0].candidate.storyId,
    "bakery-templates-workerreadonlydetail--contract",
  );
});

test("a story candidate refuses device chrome, regions and route fields", () => {
  const reject = (mutate, pattern) => {
    const value = workerDark();
    mutate(value.cases[0]);
    const result = parseEnterpriseBaselines(value);
    assert.equal(result.success, false);
    assert.match(result.issues.join("\n"), pattern);
  };
  reject((entry) => {
    entry.deviceChrome = {
      top: 62,
      reason: "status bar",
      source: { frameId: entry.frameId },
    };
  }, /whole-artboard element/);
  reject((entry) => {
    entry.comparisonRegion = { x: 0, y: 0, width: 390, height: 100 };
  }, /whole-artboard element/);
  reject((entry) => {
    entry.candidate.route = "/__fixtures__/machines/detail";
  }, /candidate/);
  reject((entry) => {
    delete entry.candidate.wholeArtboard;
  }, /candidate/);
});

test("story candidates are admitted only for site-rendered manifests", async () => {
  const { baselineMetadataIssues, baselineInputIssues } = await import(
    "../../packages/ui/scripts/compare-paper.mjs"
  );
  const manifest = workerDark();
  assert.match(
    baselineMetadataIssues(manifest).join("\n"),
    /source-shaped story requires an explicit profile/,
  );
  assert.deepEqual(
    baselineMetadataIssues(manifest, undefined, { siteStories: true }),
    [],
  );
  const issues = await baselineInputIssues(manifest.cases[0], {
    status: "passed",
    kind: "story",
  });
  assert.ok(
    issues.includes(
      "story candidates are admitted only in site-rendered manifests",
    ),
  );
});
