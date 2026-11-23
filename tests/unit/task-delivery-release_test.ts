import { assert, assertEquals } from "@std/assert";
import {
  type DeliveryDeployment,
  type DeliveryInput,
  deliveryModel,
  type DeliveryPullRequest,
  type NowCard,
  releaseView,
} from "../../apps/web/src/pages/task-delivery/model.ts";
import {
  releaseCopy,
  releaseDetails,
  releaseTone,
} from "../../apps/web/src/pages/task-delivery/release-copy.ts";
import { goBackFailure } from "../../apps/web/src/pages/task-delivery/use-go-back.ts";
import { englishCatalog } from "../../packages/i18n/src/catalog.ts";

// #63. After a change is merged, the Delivery headline says where its release
// stands, in design-ux's words, and Go back is offered only to who may deploy
// and only with a release before this one.

const RUN = "3f0d1c2e-0000-4000-8000-0000000000a1";
const NEW = "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PREVIOUS = "4be19c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The English catalog with `{name}` filled in, as the page's translate does. */
const t = (key: string, values: Record<string, string | number> = {}) => {
  const text = (englishCatalog as Record<string, string>)[key];
  if (text === undefined) throw new Error(`no English text for ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
};

const deployment = (
  over: Partial<DeliveryDeployment> = {},
): DeliveryDeployment => ({
  id: "dep-2",
  environment: "staging",
  commitSha: NEW,
  status: "healthy",
  previousCommitSha: PREVIOUS,
  rollbackFailed: false,
  createdAt: "2026-11-23T10:00:00.000Z",
  ...over,
});

const mergedPullRequest = (
  over: Partial<DeliveryPullRequest> = {},
): DeliveryPullRequest => ({
  id: "p7",
  runId: RUN,
  url: "https://github.com/o/r/pull/7",
  providerNumber: 7,
  status: "merged",
  mergedSha: NEW,
  createdAt: "2026-11-13T10:07:00.000Z",
  repositoryId: "3f0d1c2e-0000-4000-8000-0000000000c3",
  headSha: NEW,
  baseSha: PREVIOUS,
  targetBranch: "main",
  mayMerge: true,
  mergeMethod: "squash",
  ...over,
});

const input = (over: Partial<DeliveryInput> = {}): DeliveryInput => ({
  runId: RUN,
  checks: [],
  reviews: [],
  findings: [],
  decisions: [],
  approvals: [],
  pullRequests: [mergedPullRequest()],
  mergeAttempts: [],
  mergeEntries: [],
  mergeUnavailable: false,
  approvalsUnavailable: false,
  revisionHeadSha: NEW,
  baseSha: PREVIOUS,
  paused: false,
  ...over,
});

const release = (
  over: Partial<Extract<NowCard, { kind: "release" }>> = {},
): Extract<NowCard, { kind: "release" }> => ({
  kind: "release",
  status: "healthy",
  environment: "staging",
  rollbackFailed: false,
  goBack: "none",
  ...over,
});

Deno.test("a merged change with a release shows the release headline", () => {
  const model = deliveryModel(
    input({ deployments: [deployment()], mayDeploy: true }),
  );
  assertEquals(model.now.kind, "release");
  assertEquals(model.release?.id, "dep-2");
  assertEquals(model.release?.goBack, "offer");
  assert(
    model.commits.includes(PREVIOUS),
    "the commit before can be a reference",
  );
});

Deno.test("the headline stays as it is before the merge and with no release", () => {
  const open = deliveryModel(
    input({
      pullRequests: [mergedPullRequest({ status: "open", mergedSha: null })],
      deployments: [deployment()],
    }),
  );
  assertEquals(open.release, null);
  assert(open.now.kind !== "release");
  const none = deliveryModel(input({ deployments: [] }));
  assertEquals(none.release, null);
  assert(none.now.kind !== "release");
  const noCommit = deliveryModel(
    input({
      pullRequests: [mergedPullRequest({ mergedSha: null })],
      deployments: [deployment()],
    }),
  );
  assertEquals(noCommit.release, null, "never merged without GitHub's commit");
});

Deno.test("the newest release of the run is the one shown", () => {
  const view = releaseView(
    [
      deployment({ id: "old", createdAt: "2026-11-23T09:00:00.000Z" }),
      deployment({ id: "new", createdAt: "2026-11-23T11:00:00.000Z" }),
    ],
    true,
    true,
  );
  assertEquals(view?.id, "new");
});

Deno.test("an environment the page has no words for is not shown", () => {
  assertEquals(
    releaseView([deployment({ environment: "canary" })], true, true),
    null,
  );
});

Deno.test("Go back is offered to who may deploy, only with a release before it", () => {
  const go = (over: Partial<DeliveryDeployment>, may: boolean) =>
    releaseView([deployment(over)], true, may)?.goBack;
  assertEquals(go({}, true), "offer");
  assertEquals(go({ status: "degraded" }, true), "offer");
  assertEquals(go({}, false), "viewer");
  assertEquals(go({ previousCommitSha: null }, true), "none");
  assertEquals(go({ previousCommitSha: null }, false), "none");
  for (
    const status of [
      "queued",
      "deploying",
      "verifying",
      "failed",
      "unknown",
      "rolling_back",
      "rolled_back",
    ] as const
  ) {
    assertEquals(go({ status }, true), "none", status);
  }
});

Deno.test("each release status says what the design says", () => {
  const rows: [
    NowCard & { kind: "release" },
    string,
    string,
    string,
    string | null,
  ][] = [
    [
      release({ status: "queued" }),
      "information",
      "Releasing to staging",
      "Bakery is putting this change on staging. Nothing for you to do yet.",
      null,
    ],
    [
      release({ status: "deploying" }),
      "information",
      "Releasing to staging",
      "Bakery is putting this change on staging. Nothing for you to do yet.",
      null,
    ],
    [
      release({ status: "verifying" }),
      "information",
      "Checking the release",
      "The change is on staging. Bakery is checking that it is healthy.",
      null,
    ],
    [
      release({ status: "healthy", goBack: "offer" }),
      "success",
      "Released to staging",
      "The release is healthy.",
      null,
    ],
    [
      release({ status: "degraded", goBack: "offer" }),
      "warning",
      "Released to staging, but not fully healthy",
      "Some health checks fail. You can go back to the release before it.",
      "goBack",
    ],
    [
      release({ status: "degraded", goBack: "viewer" }),
      "warning",
      "Released to staging, but not fully healthy",
      "Some health checks fail. Someone who may deploy can go back to the release before it.",
      null,
    ],
    [
      release({ status: "degraded", goBack: "none" }),
      "warning",
      "Released to staging, but not fully healthy",
      "Some health checks fail.",
      null,
    ],
    [
      release({ status: "failed" }),
      "error",
      "The release to staging failed",
      "The release did not finish. Send a message to say what to do next.",
      "tell",
    ],
    [
      release({ status: "unknown" }),
      "warning",
      "Bakery cannot tell whether the release finished",
      "Nothing else is released to staging until this is known. Bakery keeps checking.",
      null,
    ],
    [
      release({ status: "rolling_back", environment: "production" }),
      "information",
      "Going back to the last release",
      "Production is returning to the release before this one. Nothing for you to do yet.",
      null,
    ],
    [
      release({ status: "rolled_back", environment: "production" }),
      "information",
      "Went back to the last release",
      "Production runs the release before this one again. This change is merged, but not released.",
      null,
    ],
  ];
  for (const [now, tone, title, body, action] of rows) {
    const copy = releaseCopy(t, now);
    assertEquals(releaseTone(now.status), tone, `${now.status} tone`);
    assertEquals(copy.title, title);
    assertEquals(copy.body, body);
    assertEquals(copy.action, action, `${now.status} action`);
  }
});

Deno.test("the preview environment is never called Preview", () => {
  const copy = releaseCopy(t, release({ environment: "preview" }));
  assertEquals(copy.title, "Released to the preview environment");
  const back = releaseCopy(
    t,
    release({ environment: "preview", status: "rolling_back" }),
  );
  assertEquals(
    back.body,
    "The preview environment is returning to the release before this one. Nothing for you to do yet.",
  );
});

Deno.test("a failed going-back adds one sentence before the last, whatever the status", () => {
  const failed = releaseCopy(
    t,
    release({ status: "failed", rollbackFailed: true }),
  );
  assertEquals(
    failed.body,
    "The release did not finish. Bakery could not put staging back on the release before it, so check staging now. Send a message to say what to do next.",
  );
  assertEquals(
    releaseCopy(t, release({ status: "failed" })).body.includes(
      "could not put",
    ),
    false,
  );
});

Deno.test("the Details group names this release and the one kept before it", () => {
  const view = releaseView([deployment()], true, true);
  assert(view !== null);
  const details = releaseDetails(t, view, (sha) => sha.slice(0, 7));
  assertEquals(details.thisRelease, "91d0aa3 to staging");
  assertEquals(
    details.before,
    "4be19c2 · kept, so staging can go back to it",
  );
  const first = releaseView(
    [deployment({ previousCommitSha: null })],
    true,
    true,
  );
  assert(first !== null);
  assertEquals(releaseDetails(t, first, (sha) => sha.slice(0, 7)).before, null);
});

Deno.test("a refused or lost request to go back reads by its reason", () => {
  const problem = (
    status: number,
    reason?: string,
    extra: { retryable?: boolean; code?: string } = {},
  ) => ({
    kind: "problem",
    problem: {
      status,
      retryable: false,
      ...(reason ? { reason } : {}),
      ...extra,
    },
  });
  assertEquals(
    goBackFailure(problem(409, "not_current_release")),
    "notCurrent",
  );
  assertEquals(
    goBackFailure(problem(409, "outcome_unknown")),
    "outcomeUnknown",
  );
  assertEquals(goBackFailure(problem(409, "no_previous_release")), "error");
  assertEquals(goBackFailure(problem(409)), "error");
  assertEquals(goBackFailure(problem(403)), "forbidden");
  assertEquals(goBackFailure(problem(422)), "error");
  assertEquals(goBackFailure(problem(500)), "noAnswer");
  assertEquals(goBackFailure({ kind: "network" }), "noAnswer");
});
