import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  coordinationPlanDigest,
  CoordinationPlanInvalidError,
  type CoordinationPlanSpec,
  CoordinationPlanSpecSchema,
  projectLaneStatuses,
  resolveCoordinationPlan,
  validateCoordinationStructure,
} from "../../apps/server/src/modules/work/coordination-plan.ts";

const API = "11111111-1111-4111-8111-111111111111";
const WEB = "22222222-2222-4222-8222-222222222222";
const MOBILE = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const scope = (
  overrides: Partial<Parameters<typeof resolveCoordinationPlan>[1]> = {},
) => ({
  aliases: new Map([
    ["api", [{ repositoryId: API, role: "backend" }]],
    ["web", [{ repositoryId: WEB, role: "frontend" }]],
    ["mobile", [{ repositoryId: MOBILE, role: "mobile" }]],
    [
      "shared",
      [{ repositoryId: API, role: "backend" }, {
        repositoryId: WEB,
        role: "frontend",
      }],
    ],
  ]),
  applicationRepositoryIds: new Set([API, WEB, MOBILE]),
  linkedRepositoryIds: null,
  ...overrides,
});

function lane(
  key: string,
  alias: string,
  extra: Partial<CoordinationPlanSpec["lanes"][number]> = {},
): CoordinationPlanSpec["lanes"][number] {
  return {
    key,
    repositoryAlias: alias,
    title: `Lane ${key}`,
    instructions: "do the work",
    prerequisites: [],
    outputs: [],
    inputs: [],
    ...extra,
  };
}

function spec(
  lanes: CoordinationPlanSpec["lanes"],
): CoordinationPlanSpec {
  return CoordinationPlanSpecSchema.parse({
    lanes,
    maxConcurrency: 2,
    join: "all-required",
    failurePolicy: "stop-dependent",
  });
}

async function codes(
  plan: CoordinationPlanSpec,
  context = scope(),
): Promise<string[]> {
  try {
    await resolveCoordinationPlan(plan, context);
  } catch (error) {
    if (error instanceof CoordinationPlanInvalidError) {
      return error.issues.map((issue) => issue.code);
    }
    throw error;
  }
  return [];
}

const valid = () =>
  spec([
    lane("api", "api", {
      outputs: [{
        key: "contract",
        kind: "artifact",
        artifactType: "patch",
      }],
    }),
    lane("web", "web", {
      prerequisites: ["api"],
      inputs: [{ fromLane: "api", outputKey: "contract" }],
    }),
    lane("mobile", "mobile"),
  ]);

Deno.test("two independent lanes and a dependant resolve to concrete repositories", async () => {
  const lanes = await resolveCoordinationPlan(valid(), scope());
  assertEquals(lanes.map((l) => l.repositoryId), [API, WEB, MOBILE]);
  assert(lanes.every((l) => /^[0-9a-f]{64}$/.test(l.laneDigest)));
});

Deno.test("ambiguous and unknown aliases are rejected without picking a target", async () => {
  assertEquals(await codes(spec([lane("a", "shared")])), ["alias_ambiguous"]);
  assertEquals(await codes(spec([lane("a", "missing")])), ["alias_unknown"]);
});

Deno.test("cycles, self prerequisites and unknown prerequisites are rejected", async () => {
  assertEquals(
    await codes(spec([
      lane("a", "api", { prerequisites: ["b"] }),
      lane("b", "web", { prerequisites: ["a"] }),
    ])),
    ["dependency_cycle"],
  );
  assertEquals(
    await codes(spec([lane("a", "api", { prerequisites: ["a"] })])),
    ["self_prerequisite"],
  );
  assertEquals(
    await codes(spec([lane("a", "api", { prerequisites: ["zzz"] })])),
    ["prerequisite_unknown"],
  );
});

Deno.test("foreign repositories and repositories outside the parent's links are rejected", async () => {
  const foreign = scope({
    aliases: new Map([["api", [{ repositoryId: OTHER, role: "backend" }]]]),
  });
  assertEquals(await codes(spec([lane("a", "api")]), foreign), [
    "repository_foreign",
  ]);
  const narrowed = scope({ linkedRepositoryIds: new Set([WEB]) });
  assertEquals(await codes(spec([lane("a", "api")]), narrowed), [
    "repository_out_of_scope",
  ]);
});

Deno.test("two writer lanes on one repository would share a writable checkout", async () => {
  assertEquals(
    await codes(spec([lane("a", "api"), lane("b", "api")])),
    ["shared_writable_checkout"],
  );
});

Deno.test("typed inputs must be declared by an upstream lane", () => {
  const undeclared = spec([
    lane("api", "api"),
    lane("web", "web", {
      prerequisites: ["api"],
      inputs: [{ fromLane: "api", outputKey: "contract" }],
    }),
  ]);
  assertEquals(
    validateCoordinationStructure(undeclared).map((i) => i.code),
    ["input_not_declared_upstream"],
  );
  const notUpstream = spec([
    lane("api", "api", {
      outputs: [{
        key: "contract",
        kind: "artifact",
        artifactType: "patch",
      }],
    }),
    lane("web", "web", {
      inputs: [{ fromLane: "api", outputKey: "contract" }],
    }),
  ]);
  assertEquals(
    validateCoordinationStructure(notUpstream).map((i) => i.code),
    ["input_not_declared_upstream"],
  );
});

Deno.test("the spec rejects unknown fields and out-of-range concurrency", () => {
  assert(
    !CoordinationPlanSpecSchema.safeParse({
      lanes: [lane("a", "api")],
      maxConcurrency: 99,
      join: "all-required",
      failurePolicy: "stop-dependent",
    }).success,
  );
  assert(
    !CoordinationPlanSpecSchema.safeParse({
      lanes: [lane("a", "api")],
      maxConcurrency: 1,
      join: "first-wins",
      failurePolicy: "stop-dependent",
    }).success,
  );
});

Deno.test("plan digests are canonical and lane digests fold in upstream changes", async () => {
  const a = valid();
  const reordered = CoordinationPlanSpecSchema.parse(
    JSON.parse(
      JSON.stringify(a),
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
    ),
  );
  assertEquals(
    await coordinationPlanDigest(a),
    await coordinationPlanDigest(reordered),
  );
  const base = await resolveCoordinationPlan(a, scope());
  const changedApi = spec([
    lane("api", "api", {
      instructions: "different",
      outputs: [{
        key: "contract",
        kind: "artifact",
        artifactType: "patch",
      }],
    }),
    a.lanes[1],
    a.lanes[2],
  ]);
  const changed = await resolveCoordinationPlan(changedApi, scope());
  assert(base[0].laneDigest !== changed[0].laneDigest);
  assert(base[1].laneDigest !== changed[1].laneDigest, "dependant invalidated");
  assertEquals(base[2].laneDigest, changed[2].laneDigest);
});

Deno.test("projection: all-required join, stop-dependent failure, partial delivery", () => {
  const lanes = (
    statuses: Record<string, "planned" | "running" | "completed" | "failed">,
  ) => [
    { key: "api", prerequisites: [], status: statuses.api },
    { key: "web", prerequisites: ["api"], status: statuses.web },
    { key: "mobile", prerequisites: [], status: statuses.mobile },
  ];
  assertEquals(
    projectLaneStatuses(
      lanes({ api: "completed", web: "completed", mobile: "completed" }),
    ).plan,
    "completed",
  );
  assertEquals(
    projectLaneStatuses(
      lanes({ api: "completed", web: "running", mobile: "completed" }),
    ).plan,
    "materialized",
  );
  const failed = projectLaneStatuses(
    lanes({ api: "failed", web: "planned", mobile: "running" }),
  );
  assertEquals(failed.lanes.get("web"), "stopped");
  assertEquals(failed.lanes.get("mobile"), "running");
  assertEquals(failed.plan, "materialized");
  assertEquals(
    projectLaneStatuses(
      lanes({ api: "failed", web: "planned", mobile: "completed" }),
    ).plan,
    "partially_delivered",
  );
  assertEquals(
    projectLaneStatuses(
      lanes({ api: "failed", web: "planned", mobile: "failed" }),
    ).plan,
    "failed",
  );
});

Deno.test("an invalid spec is reported as a typed error carrying every issue", async () => {
  const error = await assertRejects(
    () =>
      resolveCoordinationPlan(
        spec([lane("a", "missing"), lane("b", "shared")]),
        scope(),
      ),
    CoordinationPlanInvalidError,
  );
  assertEquals(error.issues.map((i) => i.code), [
    "alias_unknown",
    "alias_ambiguous",
  ]);
});

Deno.test("projection: a ready dependant waits until its prerequisites complete", () => {
  const lanes = (api: "ready" | "running" | "completed") => [
    { key: "api", prerequisites: [], status: api },
    { key: "web", prerequisites: ["api"], status: "ready" as const },
  ];
  assertEquals(
    projectLaneStatuses(lanes("running")).lanes.get("web"),
    "waiting",
  );
  assertEquals(projectLaneStatuses(lanes("running")).plan, "materialized");
  assertEquals(
    projectLaneStatuses(lanes("completed")).lanes.get("web"),
    "ready",
  );
});

Deno.test("an unknown artifact type is rejected at plan create", () => {
  const plan = valid();
  const bad = {
    ...plan,
    lanes: plan.lanes.map((item, index) =>
      index === 0
        ? {
          ...item,
          outputs: [{
            key: "contract",
            kind: "artifact",
            artifactType: "document",
          }],
        }
        : item
    ),
  };
  assertEquals(CoordinationPlanSpecSchema.safeParse(bad).success, false);
  assertEquals(CoordinationPlanSpecSchema.safeParse(plan).success, true);
});
