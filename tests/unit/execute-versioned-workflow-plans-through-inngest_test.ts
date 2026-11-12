import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  type ActionDispatch,
  type StepRecord,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  noop,
} from "../helpers/workflow-interpreter.ts";

// #30 slice A1: the input and output contracts of rpi.research and the delivery
// actions, written to the field lists in docs/technical-design/06 ("The
// referenced schemas define required fields, types, nullability, and bounds").
// Until they existed the default catalog reported action_schema_unresolved for
// every one of these actions, so no workflow that used them could compile.

const UUID = "00000000-0000-4000-8000-0000000000a1";
const SHA = "a".repeat(40);
const CANDIDATE = {
  headSha: SHA,
  baseSha: SHA,
  policyDigest: "policy-digest",
  checksPassed: true,
  checkRunIds: [UUID],
  failedCheckIds: [] as string[],
  blockingFindings: 0,
  reviewId: UUID,
  findings: [] as unknown[],
};

type Step = Record<string, unknown>;

function workflow(steps: Step[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "delivery-contracts",
    description: "Exercises the delivery action contracts.",
    inputs: {
      repositoryId: { type: "uuid", required: true },
      taskId: { type: "uuid", required: true },
      profileRevision: { type: "integer", required: true },
    },
    steps,
  };
}

async function diagnose(steps: Step[]) {
  const result = await compileWorkflowDocument(workflow(steps), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  return result.ok
    ? []
    : result.diagnostics.map(({ path, code }) => ({ path, code }));
}

const REPO = "$input.repositoryId";

const research: Step = {
  id: "research",
  uses: "rpi.research",
  with: { taskId: "$input.taskId", repositoryId: REPO },
};
const merge = (): Step => ({
  id: "merge",
  uses: "delivery.merge",
  with: { repositoryId: REPO, candidate: { $literal: CANDIDATE } },
  effectKey: ["merge", REPO],
});
const prepare = (headSha: unknown): Step => ({
  id: "prepare",
  needs: ["merge"],
  uses: "delivery.prepare",
  with: {
    repositoryId: REPO,
    headSha,
    profileRevision: "$input.profileRevision",
  },
});
const deploy: Step = {
  id: "deploy_release",
  needs: ["prepare"],
  uses: "delivery.deploy",
  with: { releaseId: "$step.prepare.releaseId", environment: "production" },
  effectKey: ["deploy", REPO],
};
const health = (deploymentId: unknown): Step => ({
  id: "health",
  needs: ["deploy_release"],
  uses: "delivery.health",
  with: { deploymentId },
});

Deno.test("every A1 action resolves in the default catalog and compiles with valid input", async () => {
  const uses: [string, Step[]][] = [
    ["rpi.research", [research]],
    ["delivery.candidate_evidence", [{
      id: "evidence",
      uses: "delivery.candidate_evidence",
      with: CANDIDATE,
    }]],
    ["delivery.merge", [merge()]],
    ["delivery.prepare", [{
      id: "prepare",
      uses: "delivery.prepare",
      with: { repositoryId: REPO, headSha: SHA, profileRevision: 1 },
    }]],
    ["delivery.deploy", [{
      id: "deploy_release",
      uses: "delivery.deploy",
      with: { releaseId: "release-1", environment: "production" },
      effectKey: ["deploy", REPO],
    }]],
    ["delivery.health", [{
      id: "health",
      uses: "delivery.health",
      with: { deploymentId: UUID },
    }]],
  ];
  for (const [name, steps] of uses) {
    assertEquals(await diagnose(steps), [], name);
  }
});

Deno.test("the doc 06 delivery chain compiles end to end, each step reading the last one's output", async () => {
  assertEquals(
    await diagnose([
      merge(),
      prepare("$step.merge.commitSha"),
      deploy,
      health("$step.deploy_release.deploymentId"),
    ]),
    [],
  );
});

Deno.test("a step output field that the producing action does not declare is refused", async () => {
  assertEquals(
    await diagnose([
      merge(),
      prepare("$step.merge.nope"),
      deploy,
      health("$step.deploy_release.deploymentId"),
    ]),
    [{ path: "/steps/1/with/headSha", code: "reference_field_unknown" }],
  );
});

Deno.test("an output of the wrong type is refused where the consumer needs a uuid", async () => {
  // DeployOutput.commitSha is a string; HealthInput.deploymentId is a uuid.
  assertEquals(
    await diagnose([
      merge(),
      prepare("$step.merge.commitSha"),
      deploy,
      health("$step.deploy_release.commitSha"),
    ]),
    [{ path: "/steps/3/with/deploymentId", code: "type_mismatch" }],
  );
});

Deno.test("missing, unknown and mistyped input fields are refused at their paths", async () => {
  const cases: [string, Step, { path: string; code: string }[]][] = [
    [
      "research without taskId",
      { id: "research", uses: "rpi.research", with: { repositoryId: REPO } },
      [{ path: "/steps/0/with/taskId", code: "input_field_missing" }],
    ],
    [
      "research with an extra field",
      {
        id: "research",
        uses: "rpi.research",
        with: { taskId: "$input.taskId", repositoryId: REPO, extra: 1 },
      },
      [{ path: "/steps/0/with", code: "input_field_unknown" }],
    ],
    [
      "prepare with profileRevision as text",
      {
        id: "prepare",
        uses: "delivery.prepare",
        with: { repositoryId: REPO, headSha: SHA, profileRevision: "1" },
      },
      [{ path: "/steps/0/with/profileRevision", code: "type_mismatch" }],
    ],
    [
      "deploy without an environment",
      {
        id: "deploy",
        uses: "delivery.deploy",
        with: { releaseId: "r1" },
        effectKey: ["deploy", REPO],
      },
      [{ path: "/steps/0/with/environment", code: "input_field_missing" }],
    ],
    [
      "health given a non-uuid reference",
      health("$input.profileRevision"),
      [{ path: "/steps/0/with/deploymentId", code: "type_mismatch" }],
    ],
  ];
  for (const [name, step, expected] of cases) {
    // A lone step cannot name a predecessor that is not in the document.
    const { needs: _needs, ...alone } = step;
    assertEquals(await diagnose([alone]), expected, name);
  }
});

Deno.test("effectKey is the step's, not an authored input: giving it twice is refused", async () => {
  // MergeInput and DeployInput list effectKey (doc 06), and the compiler
  // supplies it from the step-level effectKey. Authoring it in `with` as well
  // would be two sources for one key.
  assertEquals(
    await diagnose([{
      id: "merge",
      uses: "delivery.merge",
      with: {
        repositoryId: REPO,
        candidate: { $literal: CANDIDATE },
        effectKey: "k",
      },
      effectKey: ["merge", REPO],
    }]),
    [{ path: "/steps/0/effectKey", code: "action_duplicate_field" }],
  );
});

// --- the runtime contracts: bounds the compiler does not check on literals

type Parser = { safeParse: (value: unknown) => { success: boolean } };
const contract = (name: string): Parser => {
  const schema = (contractSchemas as unknown as Record<string, Parser>)[name];
  assert(schema !== undefined, `${name} is not a contract`);
  return schema;
};
const accepts = (name: string, value: unknown) =>
  contract(name).safeParse(value).success;

Deno.test("PrepareInput enforces its bounds", () => {
  const ok = { repositoryId: UUID, headSha: SHA, profileRevision: 1 };
  assert(accepts("PrepareInput", ok));
  assert(!accepts("PrepareInput", { ...ok, profileRevision: 0 }));
  assert(!accepts("PrepareInput", { ...ok, headSha: "" }));
  assert(!accepts("PrepareInput", { ...ok, repositoryId: "not-a-uuid" }));
  assert(!accepts("PrepareInput", { ...ok, extra: true }));
});

Deno.test("MergeInput and DeployInput require their effect key", () => {
  const merge = {
    repositoryId: UUID,
    candidate: CANDIDATE,
    effectKey: "merge:repo",
  };
  assert(accepts("MergeInput", merge));
  assert(!accepts("MergeInput", { ...merge, effectKey: "" }));
  const { effectKey: _dropped, ...withoutKey } = merge;
  assert(!accepts("MergeInput", withoutKey));
  const deploy = {
    releaseId: "r1",
    environment: "production",
    effectKey: "deploy:repo",
  };
  assert(accepts("DeployInput", deploy));
  assert(!accepts("DeployInput", { ...deploy, environment: "" }));
});

Deno.test("CandidateEvidence needs at least one check run and a bounded finding count", () => {
  assert(accepts("CandidateEvidence", CANDIDATE));
  assert(!accepts("CandidateEvidence", { ...CANDIDATE, checkRunIds: [] }));
  assert(!accepts("CandidateEvidence", { ...CANDIDATE, blockingFindings: -1 }));
  assert(!accepts("CandidateEvidence", { ...CANDIDATE, policyDigest: "" }));
});

Deno.test("action outputs are fixed shapes: a status outside the declared set is refused", () => {
  const prepared = {
    releaseId: "r1",
    artifactDigest: "sha256:abc",
    environment: "production",
    status: "prepared",
  };
  assert(accepts("PrepareOutput", prepared));
  assert(!accepts("PrepareOutput", { ...prepared, status: "failed" }));

  const merged = {
    commitSha: SHA,
    providerEffectId: "pe-1",
    status: "confirmed",
  };
  assert(accepts("MergeOutput", merged));
  assert(!accepts("MergeOutput", { ...merged, status: "uncertain" }));

  const deployed = {
    deploymentId: UUID,
    commitSha: SHA,
    status: "queued",
    providerEffectId: "pe-2",
  };
  assert(accepts("DeployOutput", deployed));
  assert(!accepts("DeployOutput", { ...deployed, status: "healthy" }));
  assert(!accepts("DeployOutput", { ...deployed, deploymentId: "not-a-uuid" }));

  const healthy = {
    deploymentId: UUID,
    status: "healthy",
    checkedAt: "2026-11-11T12:00:00.000Z",
    evidenceArtifact: {
      artifactId: UUID,
      versionId: UUID,
      sha256: "b".repeat(64),
    },
  };
  assert(accepts("HealthOutput", healthy));
  assert(!accepts("HealthOutput", { ...healthy, status: "queued" }));
  assert(!accepts("HealthOutput", { ...healthy, checkedAt: "yesterday" }));

  const researched = {
    artifact: { artifactId: UUID, versionId: UUID, sha256: "c".repeat(64) },
    repositoryRevision: SHA,
  };
  assert(accepts("ResearchOutput", researched));
  assert(!accepts("ResearchOutput", { ...researched, repositoryRevision: "" }));
});

Deno.test("every status an output declares is accepted, not only the first", () => {
  const evidence = {
    artifactId: UUID,
    versionId: UUID,
    sha256: "d".repeat(64),
  };
  for (const status of ["healthy", "degraded", "failed"]) {
    assert(
      accepts("HealthOutput", {
        deploymentId: UUID,
        status,
        checkedAt: "2026-11-11T12:00:00.000Z",
        evidenceArtifact: evidence,
      }),
      `HealthOutput status ${status}`,
    );
  }
  for (const status of ["accepted", "queued", "deploying"]) {
    assert(
      accepts("DeployOutput", {
        deploymentId: UUID,
        commitSha: SHA,
        status,
        providerEffectId: "pe-3",
      }),
      `DeployOutput status ${status}`,
    );
  }
});

// --- slice E1: the pure interpreter (AC1 and the plan-order requirement of #157)

const counter = (over: Record<string, unknown> = {}) => ({
  id: "loop",
  repeat: {
    max: 3,
    seed: { currentCandidate: { n: 0 } },
    until: "$repeat.currentCandidate.n >= 2",
    steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
    outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
    ...over,
  },
});

const report = noop("report", {
  with: {
    outcome: "$step.loop.outcome",
    iterations: "$step.loop.iterations",
    candidate: "$step.loop.currentCandidate",
  },
});

const grow = (step: Dispatch): StepRecord =>
  completed({ next: ((step as ActionDispatch).input as { n: number }).n + 1 });

Deno.test("AC1: a clean seed runs zero iterations and is the final result, unchanged", async () => {
  const document = await compiled([
    counter({ seed: { currentCandidate: { n: 5 } } }),
    report,
  ]);
  const { trace, dispatched } = drive(document, grow);
  assertEquals(trace, ["report"]);
  assertEquals((dispatched[0] as ActionDispatch).input, {
    outcome: "completed",
    iterations: 0,
    candidate: { n: 5 },
  });
});

Deno.test("AC1: a failed or canceled iteration preserves the prior completed candidate", async () => {
  for (const status of ["failed", "canceled", "timed_out"] as const) {
    const document = await compiled([
      counter({ until: "$repeat.currentCandidate.n >= 99" }),
      report,
    ]);
    const { dispatched } = drive(
      document,
      (step) => step.key === "loop@3.bump" ? { status } : grow(step),
    );
    // Two iterations completed (n = 2); the third left that result in place.
    assertEquals(
      (dispatched.at(-1) as ActionDispatch).input,
      { outcome: status, iterations: 2, candidate: { n: 2 } },
      status,
    );
  }
});

Deno.test("AC1: an exhausted repeat cannot satisfy a delivery gate", async () => {
  const document = await compiled([
    counter({ until: "$repeat.currentCandidate.n >= 99" }),
    noop("deliver", {
      needs: ["loop"],
      if: '$step.loop.outcome == "completed"',
    }),
    report,
  ]);
  const { trace, dispatched } = drive(document, grow);
  assert(!trace.includes("deliver"), "an exhausted repeat reached delivery");
  assertEquals((dispatched.at(-1) as ActionDispatch).input, {
    outcome: "exhausted",
    iterations: 3,
    candidate: { n: 3 },
  });
});

Deno.test("#157: with no needs edge anywhere the interpreter still runs the plan in plan order", async () => {
  // doc 06: sequence order is execution order; a step that reads an earlier
  // one needs no `needs` edge. Merge-then-deploy is the shape that matters.
  const steps = [
    noop("implement", { with: { go: true } }),
    noop("merge", { with: { revision: "$step.implement.sha" } }),
    noop("prepare", { with: { commit: "$step.merge.commit" } }),
    noop("deploy", { with: { release: "$step.prepare.release" } }),
    noop("health", { with: { deployment: "$step.deploy.id" } }),
  ];
  const result = await compileWorkflowDocument({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "plan-order",
    description: "A delivery chain with no needs edges.",
    inputs: {},
    steps,
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assert(result.plan.steps.every((step) => step.position >= 0));
  const planned = result.plan.steps.map((step) => step.qualifiedId);
  const { trace } = drive(
    result.document,
    () => completed({ sha: "s", commit: "c", release: "r", id: "d" }),
  );
  assertEquals(trace, planned);
});
