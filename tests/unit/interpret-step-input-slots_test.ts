import { assert, assertEquals } from "@std/assert";
import {
  type ActionDispatch,
  nextStep,
  nextStepWithGroups,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import { compiled, noop, stateOf } from "../helpers/workflow-interpreter.ts";

// #527: a step that declares input slots gets each slot's resolved value on its
// dispatch, so admission can pin what the slot names. A step with none gets the
// dispatch it always had.

const VERSION = "00000000-0000-4000-8000-0000000000b1";
const DOC = { type: "uuid", required: true };

function dispatchOf(next: ReturnType<typeof nextStep>): ActionDispatch {
  assert(next.kind === "dispatch" && next.step.kind === "action");
  return next.step;
}

for (
  const [revision, interpreter] of [
    ["1", nextStep],
    ["2", nextStepWithGroups],
  ] as const
) {
  Deno.test(`revision ${revision}: a declared slot is resolved onto the dispatch in authored order`, async () => {
    const document = await compiled([
      noop("read", {
        inputs: [
          { name: "doc", from: "$input.doc" },
          { name: "again", from: "$input.doc" },
        ],
      }),
    ], { doc: DOC });
    const step = dispatchOf(
      interpreter(document, stateOf({ inputs: { doc: VERSION } })),
    );
    assertEquals(step.inputs, [
      { slot: "doc", value: VERSION },
      { slot: "again", value: VERSION },
    ]);
  });

  Deno.test(`revision ${revision}: a step with no slots has no inputs field`, async () => {
    const document = await compiled([noop("read")], { doc: DOC });
    const step = dispatchOf(
      interpreter(document, stateOf({ inputs: { doc: VERSION } })),
    );
    assertEquals(Object.hasOwn(step, "inputs"), false);
  });
}
