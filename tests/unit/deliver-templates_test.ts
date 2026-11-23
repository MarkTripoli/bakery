import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  DELIVER_TEMPLATE_AUDIT_GAPS,
  DELIVER_TEMPLATE_IDS,
  deliverTemplateDefinition,
  type DeliverTemplateId,
} from "../../packages/contracts/src/deliver-templates.ts";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/compile.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

const compile = async (document: unknown) => {
  const { result } = await compileWorkflowDocumentDetailed(document, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result;
};

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
  const prefixIds = DELIVER_TEMPLATE_IDS.map((id) =>
    (deliverTemplateDefinition(id).steps as readonly { id: string }[])
      .map((s) => s.id).join(",")
  );
  assertEquals(new Set(prefixIds).size, 4);
});

Deno.test("every sign-off is a branch on gates: plan, so the steps after it run whichever arm is taken (#429)", () => {
  for (const id of DELIVER_TEMPLATE_IDS) {
    const steps = deliverTemplateDefinition(id).steps as readonly Record<
      string,
      unknown
    >[];
    const branches = steps.filter((step) => step.branch !== undefined);
    assert(branches.length >= 1, id);
    for (const node of branches) {
      const branch = node.branch as {
        when: string;
        then: { id: string; uses: string }[];
        else: unknown[];
      };
      assertEquals(branch.when, '$input.gates == "plan"', id);
      assertEquals(
        branch.then.map((step) => step.uses),
        ["human.approval"],
        id,
      );
      assertEquals(branch.else, [], id);
    }
    assert(
      !steps.some((step) => step.uses === "human.approval"),
      `${id} has a bare human.approval step`,
    );
    assert(
      !steps.some((step) => step.uses !== undefined && step.if !== undefined),
      `${id} has a step with an if that later steps need`,
    );
  }
});

Deno.test("each Deliver preset's digest is the digest of its definition, so an edited template cannot keep a stale one (#429)", async () => {
  const { WORKFLOW_PRESETS } = await import(
    "../../packages/contracts/src/workflow-presets.ts"
  );
  const { canonicalJson, sha256Hex } = await import(
    "../../apps/server/src/platform/canonical-json.ts"
  );
  for (const id of DELIVER_TEMPLATE_IDS) {
    const preset = WORKFLOW_PRESETS.find((candidate) => candidate.id === id);
    assert(preset, id);
    assertEquals(
      preset.digest,
      await sha256Hex(canonicalJson(deliverTemplateDefinition(id))),
      id,
    );
    assertEquals(
      JSON.parse(preset.sourceYaml),
      JSON.parse(JSON.stringify(preset.spec)),
      id,
    );
  }
});

Deno.test("a template hands a step only the brief or a document an earlier writer published under its slot (#429)", () => {
  const slotSources = (value: unknown, found: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v) => slotSources(v, found));
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.inputs)) {
        for (const slot of record.inputs) {
          const from = (slot as { from?: unknown }).from;
          if (typeof from === "string") found.push(from);
        }
      }
      for (const child of Object.values(record)) slotSources(child, found);
    }
    return found;
  };
  for (const id of DELIVER_TEMPLATE_IDS) {
    for (const from of slotSources(deliverTemplateDefinition(id))) {
      assert(
        from === "$step.brief.artifact.versionId" ||
          /^\$step\.([a-z_]+)\.outputs\.\1$/.test(from),
        `${id}: ${from}`,
      );
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
