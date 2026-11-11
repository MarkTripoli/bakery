import { expect, test } from "@playwright/test";
import { createTranslator } from "@bakery/i18n";
import {
  workerEnrollmentFixtures,
  workerEnrollmentPlaceholder,
  workerEnrollmentStates,
} from "../src/fixtures/worker-readiness.ts";
import { runtime, storyUrl } from "./storybook-harness.ts";

test("enrollment registers preserves 38 cases and adds six source-shaped cases across seventeen states", () => {
  const cases = runtime.cases.filter((item) =>
    item.id.startsWith("wr.enrollment.")
  );
  expect(cases).toHaveLength(44);
  expect(new Set(cases.map((item) => item.id)).size).toBe(44);
  expect(workerEnrollmentStates).toHaveLength(17);
  for (const state of workerEnrollmentStates) {
    const fixture = workerEnrollmentFixtures[state];
    expect(fixture.source).toBe("synthetic-fixture");
    expect(Object.isFrozen(fixture)).toBe(true);
    const matching = cases.filter((item) =>
      item.id.startsWith(`wr.enrollment.${state}.`)
    );
    expect(matching).toHaveLength(
      state === "ready" || state === "worstcase"
        ? 13
        : ["start", "listening", "connected"].includes(state)
        ? 2
        : 1,
    );
    expect(matching.every((item) => item.args?.state === state)).toBe(
      true,
    );
    for (const locale of ["en", "en-XA", "ar-XB"] as const) {
      const t = createTranslator({
        locale,
        onMissing: () => {
          throw new Error("missing enrollment translation");
        },
      });
      expect(t(`workerEnrollment.state.${state}`).length).toBeGreaterThan(20);
    }
  }
  const original = cases.filter((item) =>
    !item.context.startsWith("paper-enrollment-")
  );
  expect(original).toHaveLength(38);
  expect(new Set(original.map((item) => item.args?.state)).size).toBe(14);
  for (const state of ["start", "listening", "connected"]) {
    for (const device of ["desktop", "phone"]) {
      const item = cases.find((entry) =>
        entry.id ===
          `wr.enrollment.${state}.paper-enrollment-${state}-${device}`
      );
      expect(item?.args).toEqual({ state });
      expect(item?.paperBaselineId).toBe(`enrollment.${state}.light.${device}`);
    }
  }
  expect(workerEnrollmentPlaceholder.replace(/\\\n\s*/g, "")).toBe(
    "npx @bakery/worker@VERIFIED_VERSION setup --server https://bakery.example",
  );
  expect(createTranslator({ locale: "en" })("workerEnrollment.disclaimer"))
    .toBe("Prototype only · package and release are placeholders.");
  expect(workerEnrollmentPlaceholder).not.toMatch(
    /curl|wget|sudo|token=/i,
  );
});

test("enrollment stages retain negative-state semantics and 35 percent expansion", () => {
  for (
    const state of ["ready", "error", "conflict", "stale", "worstcase"] as const
  ) {
    expect(workerEnrollmentFixtures[state].stage).toBe("connected");
  }
  for (const state of ["offline", "reconnecting"] as const) {
    expect(workerEnrollmentFixtures[state].stage).toBe("listening");
  }
  const en = createTranslator({ locale: "en" });
  const pseudo = createTranslator({ locale: "en-XA" });
  for (const state of workerEnrollmentStates) {
    expect(pseudo(`workerEnrollment.state.${state}`).length)
      .toBeGreaterThanOrEqual(
        Math.ceil(en(`workerEnrollment.state.${state}`).length * 1.35),
      );
  }
});

test("runtime arguments select a finite state without changing the story binding", () => {
  const item = runtime.cases.find((entry) =>
    entry.id === "wr.enrollment.expired.desktop-light-fine"
  );
  expect(item).toBeDefined();
  if (!item) throw new Error("Missing expired fixture");
  const url = new URL(
    storyUrl("http://localhost", item, runtime.contexts[item.context]),
  );
  expect(url.searchParams.get("args")).toBe("state:expired");
  expect(url.searchParams.get("id")).toBe(
    "bakery-templates-workerenrollmentinstructions--contract",
  );
  expect(() =>
    storyUrl("http://localhost", {
      ...item,
      args: { state: "expired;injected:true" },
    }, runtime.contexts[item.context])
  ).toThrow("finite identifier");
});
