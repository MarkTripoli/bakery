import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../../packages/contracts/src/action-registry.ts";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { DeliveryImplementedAction } from "../../../packages/contracts/src/implemented-actions.ts";
import {
  createDeliveryActionRegistry,
  createDeliveryHandlers,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { mergeDispatchStub } from "../merge-dispatch-stub.ts";
import {
  type ChecksFixture,
  openChecksFixture,
} from "../deterministic-checks/checks-fixture.ts";
import { insertCheckRun } from "../deterministic-checks/run-fixture.ts";
import { fingerprintOf } from "./fixtures.ts";
import {
  insertDeliveryDecision,
  insertReviewCycle,
  insertReviewFinding,
  type ReviewRun,
  seedReviewRun,
} from "./run-fixture.ts";

// Issue #94 (B10.03) Phase 4, integration lane: the three list operations
// through the real action registry and authority runner against Postgres.
// Rows are seeded as the owner because the writer under test is the finalizer
// (proved through the result route elsewhere); these cases prove what a reader
// sees: ordering, paging, the cursor binding, organization isolation and the
// finding status derived from the run's latest cycle.

const SECRET = "review-reads-cursor-secret";

type ListAction =
  | typeof DeliveryImplementedAction.RunReviewsList
  | typeof DeliveryImplementedAction.ReviewFindingsList
  | typeof DeliveryImplementedAction.RunDeliveryDecisionsList;

type Page = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

type Reads = ChecksFixture & {
  read(
    action: ListAction,
    options: {
      id: string;
      organizationId?: string;
      principalId?: string;
      query?: { cursor?: string; limit?: number };
    },
  ): Promise<Page>;
};

async function openReads(): Promise<Reads> {
  const checks = await openChecksFixture();
  const registry = createDeliveryActionRegistry(
    checks.fixture.appPg,
    createDeliveryHandlers(SECRET, mergeDispatchStub("loop-read-cases opens")),
  );
  return {
    ...checks,
    async read(action, options) {
      const path = action === DeliveryImplementedAction.ReviewFindingsList
        ? `/v1/reviews/${options.id}/findings`
        : action === DeliveryImplementedAction.RunReviewsList
        ? `/v1/runs/${options.id}/reviews`
        : `/v1/runs/${options.id}/delivery-decisions`;
      const organizationId = options.organizationId ??
        checks.fixture.organizationId;
      const context: ActionContext = {
        request: new Request(`http://test${path}`, {
          headers: { "Bakery-Organization-Id": organizationId },
        }),
        params: { id: options.id },
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        signal: new AbortController().signal,
        principal: {
          principalId: options.principalId ?? checks.principalId,
          principalType: "service",
          displayName: "Review reader",
        },
      };
      return await registry.execute(
        action,
        context,
        options.query ?? {},
      ) as Page;
    },
  };
}

/**
 * One migrated database for all the read cases (#37). Opening it resets the
 * test database and applies every migration, which took 20 to 50 s per case on
 * a loaded host and timed statements out; the reads themselves take
 * milliseconds. Every case seeds its own run (and organization or principal
 * where it needs one), so sharing the database shares nothing a case reads.
 * The last registered case closes it.
 */
let shared: Promise<Reads> | undefined;

async function withReads(work: (reads: Reads) => Promise<void>) {
  shared ??= openReads();
  await work(await shared);
}

async function closeSharedReads(): Promise<void> {
  const reads = shared;
  shared = undefined;
  if (reads) await (await reads).close();
}

/** Seeds `ordinals` cycles of one run, in the order given. */
async function seedCycles(
  reads: Reads,
  run: ReviewRun,
  ordinals: readonly number[],
  organizationId: string = reads.fixture.organizationId,
): Promise<Record<number, string>> {
  const ids: Record<number, string> = {};
  for (const ordinal of ordinals) {
    ids[ordinal] = await insertReviewCycle(reads.owner, {
      organizationId,
      runId: run.runId,
      runStepId: run.reviewStepId,
      reviewerSessionId: run.reviewerSessionId,
      implementerSessionId: run.implementerSessionId,
      ordinal,
      headSha: String(ordinal + 1).repeat(40),
      status: ordinal === 2 ? "approved" : "changes_requested",
      findingCount: 1,
      blockingCount: ordinal === 2 ? 0 : 1,
      createdAt: new Date(`2026-10-31T12:0${ordinal}:00.000Z`),
    });
  }
  return ids;
}

type PullRequestSeed = {
  organizationId: string;
  taskId: string;
  runId: string | null;
  providerNumber: number;
  headSha: string;
  createdAt: Date;
  repositoryId?: string;
};

/** A repository in the task's application, owned by the owner role. */
async function seedRepository(
  reads: Reads,
  organizationId: string,
  taskId: string,
): Promise<string> {
  const repositoryId = crypto.randomUUID();
  await reads.owner.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) select $1, organization_id, application_id, $2, $3, 'reads-owner', $3,
              'main'
         from bakery.tasks where organization_id = $4 and id = $5`,
    [
      repositoryId,
      crypto.randomUUID(),
      `repo-${repositoryId}`,
      organizationId,
      taskId,
    ],
  );
  return repositoryId;
}

/** One tracked pull request row, as registration and observation leave it. */
async function seedPullRequest(
  reads: Reads,
  seed: PullRequestSeed,
): Promise<{ id: string; repositoryId: string }> {
  const id = crypto.randomUUID();
  const repositoryId = seed.repositoryId ??
    await seedRepository(reads, seed.organizationId, seed.taskId);
  await reads.owner.query(
    `insert into bakery.pull_requests (
       id, organization_id, task_id, repository_id, run_id, provider_number,
       url, head_sha, base_sha, status, merged_sha, created_at, updated_at,
       version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'merged', $10, $11, $11, 2)`,
    [
      id,
      seed.organizationId,
      seed.taskId,
      repositoryId,
      seed.runId,
      seed.providerNumber,
      `https://github.example/o/r/pull/${seed.providerNumber}`,
      seed.headSha,
      "b".repeat(40),
      "c".repeat(40),
      seed.createdAt,
    ],
  );
  return { id, repositoryId };
}

function pullRequestContext(
  organizationId: string,
  principalId: string,
): ActionContext {
  return {
    request: new Request("http://test/v1/pull-requests", {
      headers: { "Bakery-Organization-Id": organizationId },
    }),
    params: {},
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    principal: {
      principalId,
      principalType: "service",
      displayName: "Pull request reader",
    },
  };
}

const ids = (page: Page) => page.items.map((item) => item.id);

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise, StandardError);
  return (error as StandardError).code;
}

/**
 * A read case on the shared database: its pool outlives the case, so Deno's
 * per-test resource and op sanitizers are off for these cases only.
 */
function readCase(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
}

export function registerLoopReadCases(): void {
  readCase(
    "runReviews.list returns cycles in ordinal order, whatever order they were written, and pages without gaps",
    () =>
      withReads(async (reads) => {
        const run = await seedReviewRun(reads.owner, reads.scope());
        const cycles = await seedCycles(reads, run, [2, 0, 1]);

        const all = await reads.read("runReviews.list", { id: run.runId });
        assertEquals(ids(all), [cycles[0], cycles[1], cycles[2]]);
        assertEquals(all.nextCursor, null);
        // The projection is the contract's: provenance, counts and the nulls.
        contractSchemas["Page<ReviewCycle>"].parse(all);
        const [first] = all.items;
        assertEquals(first.runId, run.runId);
        assertEquals(first.runStepId, run.reviewStepId);
        assertEquals(first.ordinal, 0);
        assertEquals(first.pullRequestId, null);
        assertEquals(first.artifactVersionId, null);
        assertEquals(first.reviewerSessionId, run.reviewerSessionId);
        assertEquals(first.implementerSessionId, run.implementerSessionId);
        assertEquals(first.status, "changes_requested");
        assertEquals(first.findingCount, 1);
        assertEquals(first.blockingCount, 1);
        assertEquals(first.version, 1);
        assertEquals(first.updatedAt, first.createdAt);
        assertEquals(
          (await reads.read("runReviews.list", { id: run.runId })).items[2]
            .status,
          "approved",
        );

        const one = await reads.read("runReviews.list", {
          id: run.runId,
          query: { limit: 2 },
        });
        assertEquals(ids(one), [cycles[0], cycles[1]]);
        assert(one.nextCursor !== null);
        const two = await reads.read("runReviews.list", {
          id: run.runId,
          query: { limit: 2, cursor: one.nextCursor },
        });
        assertEquals(ids(two), [cycles[2]]);
        assertEquals(two.nextCursor, null);
        // A cycle written between pages does not disturb the boundary.
        const empty = await seedReviewRun(reads.owner, reads.scope());
        assertEquals(
          (await reads.read("runReviews.list", { id: empty.runId })).items,
          [],
        );
      }),
  );

  readCase(
    "runDeliveryDecisions.list returns decisions in ordinal order with their failed checks and limits",
    () =>
      withReads(async (reads) => {
        const run = await seedReviewRun(reads.owner, reads.scope());
        const organizationId = reads.fixture.organizationId;
        const cycles = await seedCycles(reads, run, [0, 1]);
        const failed = {
          checkRunId: crypto.randomUUID(),
          checkId: "unit",
          result: "failed",
          reason: "exit_nonzero",
          exitCode: 1,
        };
        const second = await insertDeliveryDecision(reads.owner, {
          organizationId,
          runId: run.runId,
          ordinal: 1,
          reviewCycleId: cycles[1],
          decision: "stop",
          reason: "repeated_blocker",
          blockingFingerprints: [fingerprintOf(1)],
        });
        const first = await insertDeliveryDecision(reads.owner, {
          organizationId,
          runId: run.runId,
          ordinal: 0,
          reviewCycleId: cycles[0],
          decision: "repair",
          reason: "repair_selected",
          failedChecks: [failed],
        });
        // A stop taken without a cycle reads with a null cycle id.
        const third = await insertDeliveryDecision(reads.owner, {
          organizationId,
          runId: run.runId,
          ordinal: 2,
          reviewCycleId: null,
          decision: "stop",
          reason: "reviewer_unavailable",
          baseSha: null,
          policyDigest: null,
        });

        const page = await reads.read("runDeliveryDecisions.list", {
          id: run.runId,
        });
        assertEquals(ids(page), [first, second, third]);
        contractSchemas["Page<DeliveryDecision>"].parse(page);
        assertEquals(page.items[0].failedChecks, [failed]);
        assertEquals(page.items[0].decision, "repair");
        assertEquals(page.items[0].reason, "repair_selected");
        assertEquals(page.items[0].limits, {
          maxRepairCycles: 2,
          maxLoopDurationMs: 86_400_000,
          maxFindings: 25,
        });
        assertEquals(page.items[1].blockingFingerprints, [fingerprintOf(1)]);
        assertEquals(page.items[2].reviewCycleId, null);
        assertEquals(page.items[2].baseSha, null);
        assertEquals(page.items[2].policyDigest, null);
        assertEquals(page.items[0].updatedAt, page.items[0].createdAt);

        const one = await reads.read("runDeliveryDecisions.list", {
          id: run.runId,
          query: { limit: 1 },
        });
        assertEquals(ids(one), [first]);
        const next = await reads.read("runDeliveryDecisions.list", {
          id: run.runId,
          query: { limit: 2, cursor: one.nextCursor! },
        });
        assertEquals(ids(next), [second, third]);
        assertEquals(next.nextCursor, null);
      }),
  );

  readCase(
    "reviewFindings.list derives each finding's status from the run's latest cycle",
    () =>
      withReads(async (reads) => {
        const run = await seedReviewRun(reads.owner, reads.scope());
        const organizationId = reads.fixture.organizationId;
        const cycles = await seedCycles(reads, run, [0, 1]);
        const finding = (cycle: number, n: number, severity: string) =>
          insertReviewFinding(reads.owner, {
            organizationId,
            reviewCycleId: cycles[cycle],
            fingerprint: fingerprintOf(n),
            severity,
            path: `src/file${n}.ts`,
            line: n === 3 ? null : n,
            body: `Finding ${n}`,
          });
        // Cycle 0 reports 1, 2 and 3; cycle 1 reports 2 again and a new 4.
        const f1 = await finding(0, 1, "blocker");
        const f2 = await finding(0, 2, "major");
        const f3 = await finding(0, 3, "minor");
        const f2again = await finding(1, 2, "major");
        const f4 = await finding(1, 4, "note");

        const first = await reads.read("reviewFindings.list", {
          id: cycles[0],
        });
        contractSchemas["Page<ReviewFinding>"].parse(first);
        const status = new Map(
          first.items.map((item) => [item.id, item.status]),
        );
        // 1 and 3 are not in the latest cycle, so they are resolved; 2 is, so
        // it is still open.
        assertEquals(status.get(f1), "resolved");
        assertEquals(status.get(f2), "open");
        assertEquals(status.get(f3), "resolved");
        const byId = new Map(first.items.map((item) => [item.id, item]));
        assertEquals(byId.get(f1)!.body, "Finding 1");
        assertEquals(byId.get(f1)!.path, "src/file1.ts");
        assertEquals(byId.get(f3)!.line, null);
        assertEquals(byId.get(f1)!.severity, "blocker");
        assertEquals(byId.get(f1)!.reviewCycleId, cycles[0]);
        assertEquals(byId.get(f1)!.resolutionArtifactId, null);
        assertEquals(byId.get(f1)!.remoteCommentId, null);
        assertEquals(byId.get(f1)!.version, 1);

        // The latest cycle is the reference, so everything in it is open.
        const second = await reads.read("reviewFindings.list", {
          id: cycles[1],
        });
        assertEquals(
          new Map(second.items.map((item) => [item.id, item.status])),
          new Map([[f2again, "open"], [f4, "open"]]),
        );

        // Paging: every finding exactly once.
        const seen: unknown[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 5; guard++) {
          const page = await reads.read("reviewFindings.list", {
            id: cycles[0],
            query: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
          });
          seen.push(...ids(page));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        assertEquals(new Set(seen), new Set([f1, f2, f3]));
        assertEquals(seen.length, 3);
      }),
  );

  readCase(
    "a finding that a middle cycle repeated but the latest cycle dropped reads resolved in every cycle",
    () =>
      withReads(async (reads) => {
        const run = await seedReviewRun(reads.owner, reads.scope());
        const organizationId = reads.fixture.organizationId;
        const cycles = await seedCycles(reads, run, [0, 1, 2]);
        const report = async (cycle: number, fingerprints: number[]) =>
          Object.fromEntries(
            await Promise.all(fingerprints.map(async (n) => [
              n,
              await insertReviewFinding(reads.owner, {
                organizationId,
                reviewCycleId: cycles[cycle],
                fingerprint: fingerprintOf(n),
                severity: "major",
                path: `src/file${n}.ts`,
                line: n,
                body: `Finding ${n}`,
              }),
            ])),
          ) as Record<number, string>;
        // Cycle 0 reports 1, 2, 3 and 6; cycle 1 repeats 1 and 2 and adds 4;
        // the latest cycle repeats 2, adds 5 and brings 6 back after cycle 1
        // skipped it. Fingerprint 1 was repeated by the middle cycle and then
        // dropped, which an earlier rule read as still open in cycle 0.
        const zero = await report(0, [1, 2, 3, 6]);
        const one = await report(1, [1, 2, 4]);
        const two = await report(2, [2, 5, 6]);
        const statuses = async (cycle: number) => {
          const page = await reads.read("reviewFindings.list", {
            id: cycles[cycle],
          });
          contractSchemas["Page<ReviewFinding>"].parse(page);
          return new Map(page.items.map((item) => [item.id, item.status]));
        };
        assertEquals(
          await statuses(0),
          new Map([
            [zero[1], "resolved"],
            [zero[2], "open"],
            [zero[3], "resolved"],
            [zero[6], "open"],
          ]),
        );
        assertEquals(
          await statuses(1),
          new Map([[one[1], "resolved"], [one[2], "open"], [
            one[4],
            "resolved",
          ]]),
        );
        assertEquals(
          await statuses(2),
          new Map([[two[2], "open"], [two[5], "open"], [two[6], "open"]]),
        );
      }),
  );

  readCase(
    "a single-cycle run reads every finding open, and another run's cycles never change that",
    () =>
      withReads(async (reads) => {
        const organizationId = reads.fixture.organizationId;
        const alone = await seedReviewRun(reads.owner, reads.scope());
        const busy = await seedReviewRun(reads.owner, reads.scope());
        const aloneCycles = await seedCycles(reads, alone, [0]);
        const busyCycles = await seedCycles(reads, busy, [0, 1, 2]);
        const insert = (cycleId: string, n: number, severity: string) =>
          insertReviewFinding(reads.owner, {
            organizationId,
            reviewCycleId: cycleId,
            fingerprint: fingerprintOf(n),
            severity,
            path: `src/file${n}.ts`,
            line: n,
            body: `Finding ${n}`,
          });
        const blocker = await insert(aloneCycles[0], 1, "blocker");
        const note = await insert(aloneCycles[0], 2, "note");
        // The same fingerprints in another run of the organization, whose latest
        // cycle reports neither: they are resolved there and only there.
        const busyBlocker = await insert(busyCycles[0], 1, "blocker");
        await insert(busyCycles[2], 3, "minor");

        const open = await reads.read("reviewFindings.list", {
          id: aloneCycles[0],
        });
        assertEquals(
          new Map(open.items.map((item) => [item.id, item.status])),
          new Map([[blocker, "open"], [note, "open"]]),
        );
        const other = await reads.read("reviewFindings.list", {
          id: busyCycles[0],
        });
        assertEquals(
          new Map(other.items.map((item) => [item.id, item.status])),
          new Map([[busyBlocker, "resolved"]]),
        );
      }),
  );

  readCase(
    "a cursor is bound to its operation, run, caller and organization",
    () =>
      withReads(async (reads) => {
        const organizationId = reads.fixture.organizationId;
        const run = await seedReviewRun(reads.owner, reads.scope());
        const other = await seedReviewRun(reads.owner, reads.scope());
        await seedCycles(reads, run, [0, 1]);
        await seedCycles(reads, other, [0, 1]);
        const page = await reads.read("runReviews.list", {
          id: run.runId,
          query: { limit: 1 },
        });
        const cursor = page.nextCursor!;
        // Reused where it was issued it works.
        assertEquals(
          (await reads.read("runReviews.list", {
            id: run.runId,
            query: { limit: 1, cursor },
          })).items.length,
          1,
        );
        // Reused against another operation, run or caller it is refused.
        assertEquals(
          await code(reads.read("runDeliveryDecisions.list", {
            id: run.runId,
            query: { cursor },
          })),
          "INVALID_CURSOR",
        );
        assertEquals(
          await code(reads.read("runReviews.list", {
            id: other.runId,
            query: { cursor },
          })),
          "INVALID_CURSOR",
        );
        const developer = await reads.addPrincipal(organizationId, "developer");
        assertEquals(
          await code(reads.read("runReviews.list", {
            id: run.runId,
            principalId: developer,
            query: { cursor },
          })),
          "INVALID_CURSOR",
        );
        assertEquals(
          await code(reads.read("runReviews.list", {
            id: run.runId,
            query: { cursor: `${cursor}x` },
          })),
          "INVALID_CURSOR",
        );
      }),
  );

  readCase(
    "the review reads never cross an organization boundary and hide a run from a caller without access",
    () =>
      withReads(async (reads) => {
        const organizationId = reads.fixture.organizationId;
        const mine = await seedReviewRun(reads.owner, reads.scope());
        const theirs = await seedReviewRun(
          reads.owner,
          reads.scope(reads.otherOrganizationId),
        );
        const mineCycles = await seedCycles(reads, mine, [0]);
        const theirCycles = await seedCycles(
          reads,
          theirs,
          [0],
          reads.otherOrganizationId,
        );
        await insertReviewFinding(reads.owner, {
          organizationId,
          reviewCycleId: mineCycles[0],
        });
        await insertReviewFinding(reads.owner, {
          organizationId: reads.otherOrganizationId,
          reviewCycleId: theirCycles[0],
        });
        await insertDeliveryDecision(reads.owner, {
          organizationId: reads.otherOrganizationId,
          runId: theirs.runId,
          reviewCycleId: theirCycles[0],
        });

        assertEquals(
          ids(await reads.read("runReviews.list", { id: mine.runId })),
          [mineCycles[0]],
        );
        // Another organization's run or cycle looks exactly like a missing one.
        for (
          const [action, id] of [
            ["runReviews.list", theirs.runId],
            ["runDeliveryDecisions.list", theirs.runId],
            ["reviewFindings.list", theirCycles[0]],
            ["runReviews.list", crypto.randomUUID()],
            ["runDeliveryDecisions.list", crypto.randomUUID()],
            ["reviewFindings.list", crypto.randomUUID()],
          ] as const
        ) {
          assertEquals(
            await code(reads.read(action, { id })),
            "RESOURCE_NOT_FOUND",
            `${action} ${id}`,
          );
        }
        // Naming an organization the caller does not belong to is refused.
        await assertRejects(
          () =>
            reads.read("runReviews.list", {
              id: theirs.runId,
              organizationId: reads.otherOrganizationId,
            }),
          StandardError,
        );
        // No membership, or a role without access: the run does not exist.
        const guest = await reads.addPrincipal(organizationId, "guest");
        const outsider = await reads.addPrincipal(organizationId, null);
        for (const principalId of [guest, outsider]) {
          for (
            const [action, id] of [
              ["runReviews.list", mine.runId],
              ["runDeliveryDecisions.list", mine.runId],
              ["reviewFindings.list", mineCycles[0]],
            ] as const
          ) {
            assertEquals(
              await code(reads.read(action, { id, principalId })),
              "RESOURCE_NOT_FOUND",
              `${action} as ${principalId}`,
            );
          }
        }
        for (const role of ["developer", "viewer", "admin"] as const) {
          const principalId = await reads.addPrincipal(organizationId, role);
          assertEquals(
            (await reads.read("runReviews.list", {
              id: mine.runId,
              principalId,
            })).items.length,
            1,
            role,
          );
        }
      }),
  );

  readCase(
    "#57 pullRequests.list pages the organization's pull requests with their fields and filters, and never another organization's",
    () =>
      withReads(async (reads) => {
        const registry = createDeliveryActionRegistry(
          reads.fixture.appPg,
          createDeliveryHandlers(
            SECRET,
            mergeDispatchStub("loop-read-cases late reads"),
          ),
        );
        const list = async (
          query: Record<string, unknown>,
          organizationId: string = reads.fixture.organizationId,
          principalId: string = reads.principalId,
        ) =>
          await registry.execute(
            DeliveryImplementedAction.PullRequestsList,
            pullRequestContext(organizationId, principalId),
            query,
          ) as Page;
        const run = await seedReviewRun(reads.owner, reads.scope());
        const other = await seedReviewRun(reads.owner, reads.scope());
        const orgId = reads.fixture.organizationId;
        const first = await seedPullRequest(reads, {
          organizationId: orgId,
          taskId: run.taskId,
          runId: run.runId,
          providerNumber: 101,
          headSha: "1".repeat(40),
          createdAt: new Date("2026-11-15T01:00:00.000Z"),
        });
        const second = await seedPullRequest(reads, {
          organizationId: orgId,
          taskId: run.taskId,
          runId: null,
          providerNumber: 102,
          headSha: "2".repeat(40),
          createdAt: new Date("2026-11-15T02:00:00.000Z"),
          repositoryId: first.repositoryId,
        });
        const third = await seedPullRequest(reads, {
          organizationId: orgId,
          taskId: other.taskId,
          runId: other.runId,
          providerNumber: 7,
          headSha: "3".repeat(40),
          createdAt: new Date("2026-11-15T03:00:00.000Z"),
        });
        // Another organization's pull request, on its own run.
        const foreignPrincipal = await reads.addPrincipal(
          reads.otherOrganizationId,
          "developer",
        );
        const foreignRun = await seedReviewRun(reads.owner, {
          organizationId: reads.otherOrganizationId,
          principalId: foreignPrincipal,
        });
        const foreign = await seedPullRequest(reads, {
          organizationId: reads.otherOrganizationId,
          taskId: foreignRun.taskId,
          runId: foreignRun.runId,
          providerNumber: 9,
          headSha: "4".repeat(40),
          createdAt: new Date("2026-11-15T00:30:00.000Z"),
        });

        const all = await list({});
        contractSchemas["Page<PullRequest>"].parse(all);
        assert(!ids(all).includes(foreign.id));
        const mine = ids(all).filter((id) =>
          [first.id, second.id, third.id].includes(String(id))
        );
        assertEquals(mine, [first.id, second.id, third.id]);
        const projected = all.items.find((item) => item.id === first.id)!;
        assertEquals(projected, {
          id: first.id,
          taskId: run.taskId,
          repositoryId: first.repositoryId,
          runId: run.runId,
          providerNumber: 101,
          url: "https://github.example/o/r/pull/101",
          headSha: "1".repeat(40),
          baseSha: "b".repeat(40),
          status: "merged",
          mergedSha: "c".repeat(40),
          createdAt: "2026-11-15T01:00:00.000Z",
          updatedAt: "2026-11-15T01:00:00.000Z",
          version: 2,
          // The reader holds pullRequest:merge here, and the method is the squash
          // default Bakery merges with.
          mayMerge: true,
          mergeMethod: "squash",
        });
        assertEquals(
          ids(await list({ repositoryId: first.repositoryId })),
          [first.id, second.id],
        );
        assertEquals(ids(await list({ taskId: run.taskId })), [
          first.id,
          second.id,
        ]);
        assertEquals(ids(await list({ runId: run.runId })), [first.id]);
        assertEquals(ids(await list({ runId: other.runId })), [third.id]);
        // A foreign filter id reads as an empty page, never the row.
        assertEquals(ids(await list({ runId: foreignRun.runId })), []);
        assertEquals(
          ids(await list({}, reads.otherOrganizationId, foreignPrincipal)),
          [foreign.id],
        );

        const one = await list({ taskId: run.taskId, limit: 1 });
        assertEquals(ids(one), [first.id]);
        assert(one.nextCursor !== null);
        const two = await list({
          taskId: run.taskId,
          limit: 1,
          cursor: one.nextCursor,
        });
        assertEquals(ids(two), [second.id]);
        assertEquals(two.nextCursor, null);
        // The cursor is bound to its filters.
        assertEquals(
          await code(list({ runId: run.runId, cursor: one.nextCursor })),
          "INVALID_CURSOR",
        );
      }),
  );

  readCase(
    "#57 a check and a review name the run's pull request at their head, and stay null without one",
    () =>
      withReads(async (reads) => {
        const orgId = reads.fixture.organizationId;
        const run = await seedReviewRun(reads.owner, reads.scope());
        const head = "5".repeat(40);
        const moved = "6".repeat(40);
        const pullRequest = await seedPullRequest(reads, {
          organizationId: orgId,
          taskId: run.taskId,
          runId: run.runId,
          providerNumber: 55,
          headSha: head,
          createdAt: new Date("2026-11-15T05:00:00.000Z"),
        });
        // A pull request of the same task but no run never matches.
        await seedPullRequest(reads, {
          organizationId: orgId,
          taskId: run.taskId,
          runId: null,
          providerNumber: 56,
          headSha: moved,
          createdAt: new Date("2026-11-15T05:01:00.000Z"),
          repositoryId: pullRequest.repositoryId,
        });
        const atHead = await insertCheckRun(reads.owner, {
          organizationId: orgId,
          runId: run.runId,
          headSha: head,
          checkId: "unit",
          createdAt: new Date("2026-11-15T05:02:00.000Z"),
        });
        const elsewhere = await insertCheckRun(reads.owner, {
          organizationId: orgId,
          runId: run.runId,
          headSha: moved,
          checkId: "lint",
          createdAt: new Date("2026-11-15T05:03:00.000Z"),
        });
        const checks = await reads.list(orgId, run.runId);
        contractSchemas["Page<CheckRun>"].parse(checks);
        const byId = new Map(checks.items.map((item) => [item.id, item]));
        assertEquals(byId.get(atHead)?.pullRequestId, pullRequest.id);
        assertEquals(byId.get(elsewhere)?.pullRequestId, null);

        await insertReviewCycle(reads.owner, {
          organizationId: orgId,
          runId: run.runId,
          runStepId: run.reviewStepId,
          reviewerSessionId: run.reviewerSessionId,
          implementerSessionId: run.implementerSessionId,
          ordinal: 0,
          headSha: head,
          status: "changes_requested",
          findingCount: 0,
          blockingCount: 0,
          createdAt: new Date("2026-11-15T05:04:00.000Z"),
        });
        await insertReviewCycle(reads.owner, {
          organizationId: orgId,
          runId: run.runId,
          runStepId: run.reviewStepId,
          reviewerSessionId: run.reviewerSessionId,
          implementerSessionId: run.implementerSessionId,
          ordinal: 1,
          headSha: moved,
          status: "approved",
          findingCount: 0,
          blockingCount: 0,
          createdAt: new Date("2026-11-15T05:05:00.000Z"),
        });
        const reviews = await reads.read("runReviews.list", { id: run.runId });
        contractSchemas["Page<ReviewCycle>"].parse(reviews);
        assertEquals(
          reviews.items.map((item) => item.pullRequestId),
          [pullRequest.id, null],
        );
      }),
  );

  // Not a case: closes the database the read cases shared, pass or fail.
  Deno.test({
    name: "review read cases: close the shared database",
    fn: closeSharedReads,
    sanitizeOps: false,
    sanitizeResources: false,
  });
}
