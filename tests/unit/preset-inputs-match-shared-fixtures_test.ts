import { assert } from "@std/assert";
import {
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
} from "../../packages/contracts/src/workflow-presets.ts";
import { automationVersionInputs } from "../helpers/automation-fixtures.ts";

// #499 changed the fixed-coding preset's `brief` input from a plain string to
// the structured `TaskBrief` contract and added two required inputs,
// `repositoryId` and `instructions`. The preset's own tests were updated with
// it; the shared automation fixture was not, and because it lives in suites
// the affected-route CI filter never ran, twelve automation tests went red on
// main and stayed red. This pins the two together so the next contract change
// fails here, by name, instead of silently over there.

const SAMPLE_REPOSITORY_ID = "00000000-0000-4000-8000-000000000000";

const PINNED_PRESETS = Object.freeze([
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
]);

/** Every shared fixture that supplies inputs to a preset version. */
const SHARED_FIXTURES: readonly Readonly<{
  fixture: string;
  inputs: Record<string, unknown>;
}>[] = Object.freeze([
  {
    fixture: "automation-fixtures.ts setUpAutomation",
    inputs: automationVersionInputs(SAMPLE_REPOSITORY_ID),
  },
]);

Deno.test("every shared fixture supplies exactly the preset inputs the preset declares", () => {
  for (const preset of PINNED_PRESETS) {
    // Only the document grammar declares inputs; the fixed grammar takes none.
    if (preset.spec.kind !== "workflow") continue;
    const declared = Object.keys(preset.spec.inputs);
    for (const { fixture, inputs } of SHARED_FIXTURES) {
      for (const name of declared) {
        assert(
          Object.hasOwn(inputs, name),
          `${fixture} is missing input "${name}" that preset "${preset.id}" ` +
            `declares; a version pinning this preset is refused at start`,
        );
      }
      for (const name of Object.keys(inputs)) {
        assert(
          declared.includes(name),
          `${fixture} supplies input "${name}" that preset "${preset.id}" ` +
            `does not declare; starting a firing is refused as input_unknown`,
        );
      }
    }
  }
});

Deno.test("every shared fixture input matches the type its preset declares", () => {
  for (const preset of PINNED_PRESETS) {
    if (preset.spec.kind !== "workflow") continue;
    for (const { fixture, inputs } of SHARED_FIXTURES) {
      for (const [name, declaration] of Object.entries(preset.spec.inputs)) {
        if (!Object.hasOwn(inputs, name)) continue;
        const value = inputs[name];
        // A structured contract type such as `TaskBrief` is an object with
        // fields; the scalars the presets use are the JavaScript primitives.
        const expected = declaration.type === "TaskBrief" ? "object" : null;
        assert(
          expected === null || typeof value === expected,
          `${fixture} supplies input "${name}" as ${typeof value} but preset ` +
            `"${preset.id}" declares it as ${declaration.type}`,
        );
      }
    }
  }
});
