import { expect, test } from "@playwright/test";
import { createTranslator } from "@bakery/i18n";
import {
  workerListFixtures,
  workerListStates,
} from "../src/fixtures/worker-readiness.ts";
import runtime from "../../../docs/technical-design/ui-baselines/runtime-cases.json" with {
  type: "json",
};

test("list preserves all 38 finite cases and 14 state contracts", () => {
  const cases = runtime.cases.filter((item) =>
    item.id.startsWith("wr.list.") && !item.context.startsWith("paper-list-")
  );
  expect(cases).toHaveLength(38);
  expect(new Set(cases.map((item) => item.id)).size).toBe(38);
  const contexts = [
    "desktop-light-fine",
    "desktop-dark-fine",
    "worker-system-light",
    "system-dark",
    "phone-light-fine",
    "phone-light-coarse",
    "phone-dark-coarse",
    "zoom-200",
    "reduced-motion",
    "pseudo-locale",
    "rtl",
    "keyboard-focus",
    "worker-screen-reader",
  ];
  expect(cases.map((item) => item.id).sort()).toEqual(
    workerListStates.flatMap((state) =>
      (state === "ready" || state === "worstcase"
        ? contexts
        : ["desktop-light-fine"]).map((context) =>
          `wr.list.${state}.${context}`
        )
    ).sort(),
  );
  for (
    const item of runtime.cases.filter((entry) =>
      entry.id.startsWith("wr.list.")
    )
  ) {
    expect(item.catalogId).toBe("template.workerCatalog");
    expect(item.storyId).toBe("bakery-templates-workercatalog--contract");
  }
  expect(workerListStates).toHaveLength(14);
  for (const state of workerListStates) {
    const fixture = workerListFixtures[state];
    expect(fixture.source).toBe("synthetic-fixture");
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.rows)).toBe(true);
    expect(cases.filter((item) => item.args?.state === state)).toHaveLength(
      state === "ready" || state === "worstcase" ? 13 : 1,
    );
    expect(fixture.rows).toHaveLength(
      state === "ready" || state === "worstcase" ? 3 : 0,
    );
    const en = createTranslator({ locale: "en" });
    const pseudo = createTranslator({ locale: "en-XA" });
    expect(pseudo(`workerList.state.${state}`).length).toBeGreaterThanOrEqual(
      Math.ceil(en(`workerList.state.${state}`).length * 1.35),
    );
  }
  expect(new Set(cases.map((item) => item.sourceProvenance?.frameId))).toEqual(
    new Set(["8SD-0", "8SE-0", "A8Y-0", "AD7-0"]),
  );
});
