import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  WORKFLOW_COMPILER_VERSION,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #30 slice B1: the compiler changes the shipped presets need, under one
// compiler version bump (1 -> 2): the `$delivery` reference root, a step
// `agentVersionId` for model actions, structured (contract-typed) run inputs,
// and the ordering rule for `$step` reads (#157).

const UUID = "00000000-0000-4000-8000-0000000000a1";
// Contains hex letters, so lower-casing a shouted copy of it changes the text.
const AGENT = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const REPO = "$input.repositoryId";

type Step = Record<string, unknown>;
type Inputs = Record<string, unknown>;

const PRESET_INPUTS: Inputs = {
  repositoryId: { type: "uuid", required: true },
  brief: { type: "TaskBrief", required: true },
  instructions: { type: "string", required: true },
};

function workflow(steps: Step[], inputs: Inputs = PRESET_INPUTS) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "compiler-b1",
    description: "Exercises the slice B1 compiler changes.",
    inputs,
    steps,
  };
}

async function compile(
  steps: Step[],
  options: { inputs?: Inputs; typed?: boolean } = {},
) {
  return await compileWorkflowDocument(
    workflow(steps, options.inputs),
    options.typed === false
      ? undefined
      : { catalog: defaultWorkflowCompilerCatalog() },
  );
}

async function diagnose(
  steps: Step[],
  options: { inputs?: Inputs; typed?: boolean } = {},
) {
  const result = await compile(steps, options);
  return result.ok
    ? []
    : result.diagnostics.map(({ path, code }) => ({ path, code }));
}

const brief: Step = {
  id: "brief",
  uses: "task.brief",
  with: { brief: "$input.brief", repositoryId: REPO },
};
const implement: Step = {
  id: "implement",
  needs: ["brief"],
  uses: "harness.implement",
  with: {
    repositoryId: REPO,
    planArtifact: "$step.brief.artifact.versionId",
    instructions: "$input.instructions",
  },
};
const repair: Step = {
  id: "repair",
  needs: ["implement"],
  uses: "harness.repair",
  with: {
    repositoryId: REPO,
    revision: "$delivery.headSha",
    findings: "$delivery.blockingFindings",
    failedChecks: "$delivery.failedChecks",
  },
};
const check: Step = {
  id: "check",
  needs: ["repair"],
  uses: "quality.check",
  with: {
    repositoryId: REPO,
    revision: "$delivery.headSha",
    checks: "$delivery.checkIds",
  },
};
const review: Step = {
  id: "review",
  needs: ["check"],
  uses: "review.independent",
  with: {
    repositoryId: REPO,
    revision: "$delivery.headSha",
    evidence: "$step.check.checkRunIds",
  },
};
const REVIEWED = [brief, implement, repair, check, review];

// --- the version

Deno.test("the compiler version is 2, and the compiled document says so", async () => {
  assertEquals(WORKFLOW_COMPILER_VERSION, "2");
  const result = await compile([brief, implement]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(result.document.compilerVersion, 2);
});

// --- the $delivery root

Deno.test("the reviewed preset's shape compiles end to end against the live catalog", async () => {
  const result = await compile(REVIEWED);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(
    result.plan.steps.map((step) => `${step.position}:${step.qualifiedId}`),
    ["0:brief", "1:implement", "2:repair", "3:check", "4:review"],
  );
});

Deno.test("the plain coding preset's shape compiles against the live catalog", async () => {
  const result = await compile([brief, implement]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
});

Deno.test("a $delivery field that does not exist is refused at its path", async () => {
  assertEquals(
    await diagnose([
      brief,
      implement,
      {
        ...repair,
        with: { ...(repair.with as Step), revision: "$delivery.nope" },
      },
    ]),
    [{ path: "/steps/2/with/revision", code: "reference_field_unknown" }],
  );
});

Deno.test("a $delivery value of the wrong type is refused where it is read", async () => {
  // $delivery.headSha is text; delivery.prepare.profileRevision is an integer.
  assertEquals(
    await diagnose([{
      id: "prepare",
      uses: "delivery.prepare",
      with: {
        repositoryId: REPO,
        headSha: "$delivery.headSha",
        profileRevision: "$delivery.headSha",
      },
    }]),
    [{ path: "/steps/0/with/profileRevision", code: "type_mismatch" }],
  );
});

Deno.test("$delivery inside a longer text is ambiguous, like the other roots", async () => {
  assertEquals(
    await diagnose([
      brief,
      {
        ...implement,
        with: {
          ...(implement.with as Step),
          instructions: "build it, then compare with $delivery.headSha",
        },
      },
    ]),
    // Value-grammar errors point at the `with` object, as for `$input`/`$task`.
    [{ path: "/steps/1/with", code: "value_reference_ambiguous" }],
  );
});

Deno.test("$delivery reads add no ordering requirement of their own", async () => {
  // Only `needs` and authored order decide order. A $delivery read names run
  // state resolved at claim time, not an earlier step.
  const result = await compile([
    {
      id: "check",
      uses: "quality.check",
      with: {
        repositoryId: REPO,
        revision: "$delivery.headSha",
        checks: "$delivery.checkIds",
      },
    },
  ]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
});

Deno.test("without a catalog $delivery has no type to check, and reading it is not an error", async () => {
  assertEquals(
    await diagnose(
      [{
        id: "check",
        uses: "quality.check",
        with: {
          repositoryId: REPO,
          revision: "$delivery.headSha",
          checks: "$delivery.checkIds",
        },
      }],
      { typed: false },
    ),
    [],
  );
});

Deno.test("a catalog that does not describe $delivery refuses every read of it", async () => {
  const bare = {
    ...defaultWorkflowCompilerCatalog(),
    delivery: () => undefined,
  };
  const result = await compileWorkflowDocument(
    workflow([brief, implement, repair]),
    { catalog: bare },
  );
  assert(!result.ok);
  assertEquals(
    result.diagnostics.map(({ path, code }) => ({ path, code })),
    [
      { path: "/steps/2/with/revision", code: "reference_field_unknown" },
      { path: "/steps/2/with/findings", code: "reference_field_unknown" },
      { path: "/steps/2/with/failedChecks", code: "reference_field_unknown" },
    ],
  );
});

// --- structured run inputs

Deno.test("a TaskBrief input is typed by the contract: its fields are readable and typed", async () => {
  const result = await compile([
    brief,
    {
      id: "note",
      needs: ["brief"],
      uses: "harness.implement",
      with: {
        repositoryId: REPO,
        planArtifact: "$step.brief.artifact.versionId",
        instructions: "$input.brief.title",
      },
    },
  ]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
});

Deno.test("a field the TaskBrief contract does not have is refused", async () => {
  assertEquals(
    await diagnose([
      brief,
      {
        ...implement,
        with: {
          ...(implement.with as Step),
          instructions: "$input.brief.nope",
        },
      },
    ]),
    [{ path: "/steps/1/with/instructions", code: "reference_field_unknown" }],
  );
});

Deno.test("an optional structured input is nullable and cannot fill a required field", async () => {
  assertEquals(
    await diagnose(
      [brief],
      {
        inputs: {
          repositoryId: { type: "uuid", required: true },
          brief: { type: "TaskBrief", required: false },
        },
      },
    ),
    [{ path: "/steps/0/with/brief", code: "type_mismatch" }],
  );
});

Deno.test("a structured input must name a type the compiler knows, and takes no enum", async () => {
  assertEquals(
    await diagnose([brief], {
      inputs: {
        repositoryId: { type: "uuid", required: true },
        brief: { type: "Session", required: true },
      },
    }),
    [{ path: "/inputs/brief/type", code: "input_type_unsupported" }],
  );
  assertEquals(
    await diagnose([brief], {
      inputs: {
        repositoryId: { type: "uuid", required: true },
        brief: { type: "TaskBrief", required: true, enum: ["a"] },
      },
    }),
    [{ path: "/inputs/brief/enum", code: "input_type_unsupported" }],
  );
});

Deno.test("a catalog that cannot type a structured input reports it once, at the declaration", async () => {
  const noBrief = {
    ...defaultWorkflowCompilerCatalog(),
    inputType: () => undefined,
  };
  const result = await compileWorkflowDocument(
    workflow([
      {
        id: "note",
        uses: "workflow.noop",
        if: '$input.brief.title == "x" && $input.brief.nope == "y"',
      },
    ]),
    { catalog: noBrief },
  );
  assert(!result.ok);
  // One diagnostic on the declaration, none per read through it.
  assertEquals(
    result.diagnostics.map(({ path, code }) => ({ path, code })),
    [{ path: "/inputs/brief/type", code: "input_type_unsupported" }],
  );
});

Deno.test("without a catalog a structured input's fields are not an error to read", async () => {
  assertEquals(
    await diagnose(
      [{ id: "note", uses: "workflow.noop", if: '$input.brief.title == "x"' }],
      { typed: false },
    ),
    [],
  );
});

// --- the agent version of a step

const model = (extra: Step = {}): Step => ({
  id: "build",
  uses: "harness.implement",
  with: { repositoryId: REPO, planArtifact: UUID },
  ...extra,
});

Deno.test("a model action may select its agent version, and the plan carries it", async () => {
  const result = await compile([model({ agentVersionId: AGENT })]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  const step = result.plan.steps[0]!;
  assertEquals(step.agentVersionId, AGENT);
  const node = result.document.steps[0]!;
  assertEquals(node.kind === "action" ? node.agentVersionId : null, AGENT);
});

Deno.test("the selected agent version is part of the digest, and its case is not", async () => {
  const plain = await compile([model()]);
  const bound = await compile([model({ agentVersionId: AGENT })]);
  const upper = await compile([model({ agentVersionId: AGENT.toUpperCase() })]);
  const other = await compile([
    model({ agentVersionId: "abcdefab-cdef-4abc-8def-abcdefabcdee" }),
  ]);
  assert(plain.ok && bound.ok && upper.ok && other.ok);
  assertNotEquals(plain.digest, bound.digest);
  assertNotEquals(other.digest, bound.digest);
  assertEquals(upper.digest, bound.digest);
  assertEquals(plain.plan.steps[0]!.agentVersionId, undefined);
});

Deno.test("an action without the model capability may not select an agent version", async () => {
  for (
    const [action, withField] of [
      ["workflow.noop", undefined],
      ["task.brief", { brief: "$input.brief", repositoryId: REPO }],
      ["quality.check", {
        repositoryId: REPO,
        revision: "abc",
        checks: ["lint"],
      }],
    ] as const
  ) {
    assertEquals(
      await diagnose([{
        id: "step",
        uses: action,
        agentVersionId: AGENT,
        ...(withField ? { with: withField } : {}),
      }]),
      [{
        path: "/steps/0/agentVersionId",
        code: "step_agent_version_forbidden",
      }],
      action,
    );
  }
});

Deno.test("an agent version must be a uuid, and a container cannot take one", async () => {
  for (const bad of ["not-a-uuid", "", 7, null]) {
    assertEquals(
      await diagnose([model({ agentVersionId: bad })]),
      [{ path: "/steps/0/agentVersionId", code: "agent_binding_invalid" }],
      JSON.stringify(bad),
    );
  }
  assertEquals(
    await diagnose([{
      id: "group",
      agentVersionId: AGENT,
      steps: [{ id: "noop", uses: "workflow.noop" }],
    }]),
    [{ path: "/steps/0/agentVersionId", code: "step_agent_version_forbidden" }],
  );
});

Deno.test("the capability rule needs no catalog: it reads the static registry", async () => {
  // A model action takes an id, a non-model action never does, and a malformed
  // id is refused, whether or not the compile has a catalog.
  assertEquals(
    await diagnose([model({ agentVersionId: AGENT })], { typed: false }),
    [],
  );
  assertEquals(
    await diagnose(
      [{ id: "step", uses: "workflow.noop", agentVersionId: AGENT }],
      { typed: false },
    ),
    [{ path: "/steps/0/agentVersionId", code: "step_agent_version_forbidden" }],
  );
  assertEquals(
    await diagnose([model({ agentVersionId: "nope" })], { typed: false }),
    [{ path: "/steps/0/agentVersionId", code: "agent_binding_invalid" }],
  );
});

// --- reads of other steps (#157): sequence order is execution order

Deno.test("a read of an earlier step needs no `needs` edge, and the plan runs the earlier step first", async () => {
  // doc 06: `needs` is a dependency constraint; sequence order remains the
  // execution order, so a read of an earlier sibling is ordered by position.
  const result = await compile([
    brief,
    {
      id: "implement",
      uses: "harness.implement",
      with: {
        repositoryId: REPO,
        planArtifact: "$step.brief.artifact.versionId",
      },
    },
  ]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  const order = result.plan.steps.map((step) => step.qualifiedId);
  assert(order.indexOf("brief") < order.indexOf("implement"));
  const positions = result.plan.steps.map((step) => step.position);
  assertEquals(positions, [...positions].sort((a, b) => a - b));
});

Deno.test("a read of a later step is refused, with or without a `needs` edge", async () => {
  const later: Step = {
    id: "implement",
    uses: "harness.implement",
    with: {
      repositoryId: REPO,
      planArtifact: "$step.brief.artifact.versionId",
    },
  };
  assertEquals(await diagnose([later, brief]), [
    { path: "/steps/0/with/planArtifact", code: "reference_future" },
  ]);
  assertEquals(await diagnose([{ ...later, needs: ["brief"] }, brief]), [
    { path: "/steps/0/needs/0", code: "needs_forward" },
    { path: "/steps/0/with/planArtifact", code: "reference_future" },
  ]);
});

Deno.test("a read of a step that may be skipped is refused unless the reader reaches it through `needs`", async () => {
  // doc 06: a guard on the read step must also guard the reader, and skipping
  // propagates only through `needs`. This is where a `needs` edge is required.
  const guarded: Step = { ...brief, if: '$input.instructions == "go"' };
  const reader: Step = {
    id: "implement",
    uses: "harness.implement",
    with: {
      repositoryId: REPO,
      planArtifact: "$step.brief.artifact.versionId",
    },
  };
  assertEquals(await diagnose([guarded, reader]), [
    { path: "/steps/1/with/planArtifact", code: "reference_skipped_step" },
  ]);
  const result = await compile([guarded, { ...reader, needs: ["brief"] }]);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
});
