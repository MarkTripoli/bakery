import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  DOCUMENT_STEPS,
  documentKey,
  documentsBefore,
  NEW_NOTIFY,
  type NotifyFields,
  notifyInput,
  notifyOfNode,
  notifyProblems,
} from "../../apps/web/src/pages/library/notify-step.ts";

const review: NotifyFields = {
  who: "run:starter",
  need: "review",
  from: "flow.design",
  note: "Check the shape",
  wait: true,
  next: { after: 4, who: "role:admin" },
};

const refused = async (steps: readonly unknown[]) => {
  const compiled = await compileWorkflowDocumentDetailed({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "notify",
    steps: [{ id: "flow", steps }],
  }, { catalog: defaultWorkflowCompilerCatalog() });
  return compiled.result.ok
    ? []
    : compiled.result.diagnostics.filter((one) =>
      one.path.includes(`/steps/${steps.length - 1}/`)
    );
};

Deno.test("what the panel writes reads back as the same fields", () => {
  assertEquals(notifyOfNode({ with: notifyInput(review) }), review);
  assertEquals(notifyOfNode({ with: notifyInput(NEW_NOTIFY) }), NEW_NOTIFY);
});

Deno.test("only a waiting review keeps who is asked next", () => {
  assertEquals(
    "ifNobodyAnswers" in notifyInput({ ...review, wait: false }),
    false,
  );
  assertEquals("wait" in notifyInput({ ...review, need: "fyi" }), false);
});

Deno.test("input the panel cannot show is left to code", () => {
  for (
    const extra of [
      { artifactVersionId: "11111111-1111-4111-8111-111111111111" },
      { recipientGroupId: "11111111-1111-4111-8111-111111111111" },
      { unknown: 1 },
    ]
  ) {
    assertEquals(
      notifyOfNode({ with: { ...notifyInput(NEW_NOTIFY), ...extra } }),
      null,
    );
  }
});

Deno.test("the compiler accepts a review of every step offered as a document", async () => {
  for (const uses of DOCUMENT_STEPS) {
    assertEquals(
      await refused([
        { id: "design", uses },
        {
          id: "ask",
          uses: "people.tag",
          with: notifyInput(review),
        },
      ]),
      [],
      uses,
    );
  }
});

Deno.test("a review needs a document from earlier, and someone new to ask next", () => {
  const steps = [
    { id: "design", uses: "rpi.design", list: "flow" },
    { id: "ask", uses: "people.tag", list: "flow" },
    { id: "plan", uses: "rpi.plan", list: "flow" },
  ];
  const documents = documentsBefore(steps, "ask").map(documentKey);
  assertEquals(documents, ["flow.design"]);
  assertEquals(notifyProblems(review, documents), []);
  assertEquals(
    notifyProblems({ ...review, from: "flow.plan" }, documents),
    [{ field: "from", kind: "fromGone" }],
  );
  assertEquals(
    notifyProblems({
      ...review,
      from: "",
      next: { after: 4, who: "run:starter" },
    }, documents),
    [{ field: "from", kind: "from" }, { field: "next", kind: "nextSame" }],
  );
});
