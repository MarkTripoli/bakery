import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  DELIVER_TEMPLATE_AUDIT_GAPS,
  DELIVER_TEMPLATE_IDS,
  deliverTemplateDefinition,
  type DeliverTemplateId,
} from "../../packages/contracts/src/deliver-templates.ts";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/compile.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #429: the four Deliver templates are built only from public primitives
// (deliver-as-workflow.md section 5.7), compile in the published grammar, and a
// pasted copy of the definition is the same workflow.

const compile = async (document: unknown) => {
  const { result } = await compileWorkflowDocumentDetailed(document, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result;
};

/** Every `uses` in a definition, in document order, through groups and repeats. */
function actionsOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) actionsOf(item, found);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.uses === "string") found.push(record.uses);
    for (const child of Object.values(record)) actionsOf(child, found);
  }
  return found;
}

const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
};

Deno.test("each Deliver template compiles in the published grammar with its own digest (#429)", async () => {
  const digests = new Set<string>();
  for (const id of DELIVER_TEMPLATE_IDS) {
    const compiled = await compile(deliverTemplateDefinition(id));
    digests.add(compiled.digest);
  }
  assertEquals(digests.size, 4);
});

Deno.test("a pasted copy of a template is the same workflow: same semantic digest (#429)", async () => {
  for (const id of DELIVER_TEMPLATE_IDS) {
    const original = await compile(deliverTemplateDefinition(id));
    const pasted = await compile(
      JSON.parse(JSON.stringify(deliverTemplateDefinition(id))),
    );
    assertEquals(pasted.digest, original.digest, id);
    // Building it again is the same definition.
    assertEquals(
      (await compile(deliverTemplateDefinition(id))).digest,
      original.digest,
    );
  }
});

Deno.test("the template audit: only public primitives, no private engine path (#429, 5.7)", () => {
  const PUBLIC = new Set([
    "task.brief",
    "agent.freeform",
    "human.approval",
    "harness.implement",
    "harness.repair",
    "quality.check",
    "review.independent",
    "workflow.stop",
  ]);
  for (const id of DELIVER_TEMPLATE_IDS) {
    const definition = deliverTemplateDefinition(id);
    for (const action of actionsOf(definition)) {
      assert(PUBLIC.has(action), `${id} uses ${action}`);
      assert(!action.startsWith("rpi."), `${id} uses a registry-only action`);
    }
    // Nothing the compiler has no word for, and no call: the shared steps are inlined.
    const keys = keysOf(definition);
    for (const unknown of ["call", "artifactKinds", "checkpoint", "allow"]) {
      assert(!keys.has(unknown), `${id} uses ${unknown}`);
    }
  }
});

Deno.test("the variants differ only in their planning prefix and share the build and finish tail (#429)", () => {
  const tailOf = (id: DeliverTemplateId) => {
    const steps = deliverTemplateDefinition(id).steps as readonly {
      id: string;
    }[];
    return steps.slice(steps.findIndex((s) => s.id === "build"));
  };
  const actionsAfterBuild = (id: DeliverTemplateId) =>
    actionsOf(tailOf(id)).join(",");
  const first = actionsAfterBuild(DELIVER_TEMPLATE_IDS[0]);
  for (const id of DELIVER_TEMPLATE_IDS) {
    assertEquals(actionsAfterBuild(id), first, id);
    const repair = tailOf(id).find((s) => s.id === "repair");
    assertEquals(
      JSON.stringify(repair),
      JSON.stringify(
        tailOf(DELIVER_TEMPLATE_IDS[0]).find((s) => s.id === "repair"),
      ),
      id,
    );
  }
  // The prefixes are what differ.
  const prefixIds = DELIVER_TEMPLATE_IDS.map((id) =>
    (deliverTemplateDefinition(id).steps as readonly { id: string }[])
      .map((s) => s.id).join(",")
  );
  assertEquals(new Set(prefixIds).size, 4);
});

Deno.test("every plan sign-off applies only when the run asks for gates: plan (#429)", () => {
  for (const id of DELIVER_TEMPLATE_IDS) {
    const approvals = (deliverTemplateDefinition(id).steps as readonly Record<
      string,
      unknown
    >[]).filter((step) => step.uses === "human.approval");
    assert(approvals.length >= 1, id);
    for (const approval of approvals) {
      assertEquals(approval.if, '$input.gates == "plan"', id);
    }
  }
});

Deno.test("the audit names each gap with its design reference and what stands in for it (#429)", () => {
  assert(DELIVER_TEMPLATE_AUDIT_GAPS.length > 0);
  for (const gap of DELIVER_TEMPLATE_AUDIT_GAPS) {
    assert(gap.construct.length > 0 && gap.stand_in.length > 0);
    assert(/^[AG]\d+/.test(gap.design), gap.design);
  }
  assertNotEquals(
    DELIVER_TEMPLATE_AUDIT_GAPS.map((g) => g.construct).length,
    0,
  );
});
