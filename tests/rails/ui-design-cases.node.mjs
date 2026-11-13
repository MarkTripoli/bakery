import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DeviceChromeSchema,
  parseEnterpriseBaselines,
} from "../../packages/ui/catalog/design-cases.ts";
import {
  deriveWorkerDarkRuntimeContext,
  RUNTIME_CASES_PATH,
  WORKER_DARK_RUNTIME_CONTEXT,
} from "../../packages/ui/scripts/worker-dark-runtime-context.mjs";

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

// The worker-dark source digest must move only when something the renderer
// reads moves. It used to hash the whole of runtime-cases.json, so any new
// runtime case anywhere in the UI turned `render:paper:worker-dark --check` red
// on main (#319, #323). These tests restate the digest recipe of
// computeSourceIdentity (`path NUL sha256(bytes) newline`, hashed again) so a
// fixture can stand in for the repository, and ask the property directly: with
// runtime-cases.json changed and every derived file regenerated from it, does
// the committed digest still hold?
const DERIVED_CONTEXT =
  "docs/technical-design/worker-dark-mocks/runtime-context.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repoBytes = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url));
const digestOf = (inputs, read) =>
  sha256(inputs.map((path) => `${path}\0${sha256(read(path))}\n`).join(""));
// The repository as it would be after `runtimeText` became runtime-cases.json
// and --write regenerated the derived context file from it.
const afterRuntimeEdit = (runtimeText) => (path) => {
  if (path === RUNTIME_CASES_PATH) return Buffer.from(runtimeText);
  if (path === DERIVED_CONTEXT) {
    return deriveWorkerDarkRuntimeContext(runtimeText);
  }
  return repoBytes(path);
};
const runtimeCases = () =>
  JSON.parse(repoBytes(RUNTIME_CASES_PATH).toString("utf8"));
const edited = (mutate) => {
  const value = runtimeCases();
  mutate(value);
  return JSON.stringify(value, null, 2) + "\n";
};

test("the committed worker-dark runtime context is a fresh derivation", () => {
  assert.ok(
    repoBytes(DERIVED_CONTEXT).equals(
      deriveWorkerDarkRuntimeContext(
        repoBytes(RUNTIME_CASES_PATH).toString("utf8"),
      ),
    ),
    `${DERIVED_CONTEXT} differs from runtime-cases.json: run render:paper:worker-dark -- --write`,
  );
});

test("the worker-dark digest hashes the one context, not every runtime case", () => {
  const { source } = workerDark();
  assert.ok(source.inputs.includes(DERIVED_CONTEXT));
  assert.ok(
    !source.inputs.includes(RUNTIME_CASES_PATH),
    "hashing all of runtime-cases.json re-breaks main on every new case",
  );
  assert.equal(
    digestOf(
      source.inputs,
      afterRuntimeEdit(
        repoBytes(RUNTIME_CASES_PATH).toString("utf8"),
      ),
    ),
    source.digest,
  );
});

test("a new unrelated runtime case or context leaves the worker-dark digest unchanged", () => {
  const { source } = workerDark();
  const text = edited((value) => {
    value.cases.push({
      ...value.cases.at(-1),
      id: "ui.unrelated.contract.desktop-light-fine",
      catalogId: "ui.unrelated",
    });
    value.contexts["some-other-context"] = {
      ...value.contexts[WORKER_DARK_RUNTIME_CONTEXT],
      theme: "dark",
    };
  });
  assert.notEqual(text, repoBytes(RUNTIME_CASES_PATH).toString("utf8"));
  assert.equal(digestOf(source.inputs, afterRuntimeEdit(text)), source.digest);
});

test("changing any field of the context the worker-dark renderer reads changes the digest", () => {
  const { source } = workerDark();
  const realText = repoBytes(RUNTIME_CASES_PATH).toString("utf8");
  // Both sides go through the same derivation, so a derivation that ignored an
  // edit would fail here instead of differing from the recorded digest anyway.
  const unedited = digestOf(source.inputs, afterRuntimeEdit(realText));
  const bump = (value) =>
    typeof value === "number"
      ? value + 1
      : typeof value === "string"
      ? `${value}-edited`
      : typeof value === "boolean"
      ? !value
      : Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, bump(inner)]),
      );
  const fields = Object.keys(
    runtimeCases().contexts[WORKER_DARK_RUNTIME_CONTEXT],
  );
  assert.ok(fields.length > 0);
  for (const field of fields) {
    const text = edited((value) => {
      const context = value.contexts[WORKER_DARK_RUNTIME_CONTEXT];
      context[field] = bump(context[field]);
    });
    assert.notEqual(
      digestOf(source.inputs, afterRuntimeEdit(text)),
      unedited,
      `${field} is not part of the worker-dark derivation`,
    );
    assert.ok(
      !deriveWorkerDarkRuntimeContext(realText).equals(
        deriveWorkerDarkRuntimeContext(text),
      ),
      `--check must report the committed context file as stale after a ${field} edit`,
    );
  }
});

test("the worker-dark baseline case carries the pointer and motion setting of the slice", () => {
  // --check does not compare the case with the slice, so a --write that left the
  // case behind (a constant, a stale baseline) would pass it.
  const context = JSON.parse(repoBytes(DERIVED_CONTEXT).toString("utf8"))
    .contexts[WORKER_DARK_RUNTIME_CONTEXT];
  const [designCase] = workerDark().cases;
  assert.equal(designCase.pointer, context.pointer);
  assert.equal(designCase.candidate.reducedMotion, context.reducedMotion);
});

test("a missing or non-object worker-dark runtime context is an error, not an empty derivation", () => {
  for (
    const text of [
      edited((value) => delete value.contexts[WORKER_DARK_RUNTIME_CONTEXT]),
      edited((value) => {
        value.contexts[WORKER_DARK_RUNTIME_CONTEXT] = [];
      }),
      edited((value) => {
        value.contexts[WORKER_DARK_RUNTIME_CONTEXT] = "paper";
      }),
      edited((value) => {
        value.contexts[WORKER_DARK_RUNTIME_CONTEXT] = 7;
      }),
      edited((value) => {
        value.contexts[WORKER_DARK_RUNTIME_CONTEXT] = null;
      }),
      edited((value) => delete value.contexts),
    ]
  ) {
    assert.throws(
      () => deriveWorkerDarkRuntimeContext(text),
      /missing runtime context paper-detail-light-phone/,
    );
  }
});
