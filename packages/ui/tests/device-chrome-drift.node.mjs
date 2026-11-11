import assert from "node:assert/strict";
import { test } from "node:test";

const { deviceChromeDrift } = await import(
  new URL("../scripts/render-enterprise-references.mjs", import.meta.url).href
);

const designCase = { deviceChrome: { top: 62 } };

test("device chrome drift passes for matching height and clock text", () => {
  assert.equal(deviceChromeDrift(designCase, 62, "9:41 LTE"), null);
});

test("device chrome drift fails when the element lacks the clock text", () => {
  assert.match(
    deviceChromeDrift(designCase, 62, "Work queue"),
    /status bar time text "9:41"/,
  );
});

test("device chrome drift still fails on height and missing element", () => {
  assert.match(deviceChromeDrift(designCase, 64, "9:41"), /differs/);
  assert.match(deviceChromeDrift(designCase, null, null), /not found/);
});
