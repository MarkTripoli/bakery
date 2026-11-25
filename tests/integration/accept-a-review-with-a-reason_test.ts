import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ActionContext,
  normalizeRegisteredRouteTarget,
} from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { DeliveryImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import {
  createDeliveryActionRegistry,
  createDeliveryHandlers,
} from "../../apps/server/src/modules/delivery/index.ts";
import {
  mergeDispatchStub,
  registrationStub,
} from "../helpers/merge-dispatch-stub.ts";
import {
  type ChecksFixture,
  openChecksFixture,
} from "../helpers/deterministic-checks/checks-fixture.ts";
import {
  insertReviewCycle,
  type ReviewRun,
  seedReviewRun,
} from "../helpers/review-repair/run-fixture.ts";

// #412 slice 5. Chapter 25 section 9 (O18): to overrule a reviewer, the owner
// records an "accept, with reason" decision in the open. It is recorded against
// the review, shown on it, and a person's: only an administrator, never an agent.

const SECRET = "accept-review-cursor-secret";

type Accepted = {
  id: string;
  status: string;
  acceptedBy: string | null;
  acceptedByName: string | null;
  acceptedAt: string | null;
  acceptReason: string | null;
};

type Harness = ChecksFixture & {
  accept(input: {
    runId: string;
    reviewId: string;
    reason: string;
    as: string;
    organizationId?: string;
    agent?: boolean;
  }): Promise<Accepted>;
  reviews(runId: string, as: string): Promise<Accepted[]>;
};

async function open(): Promise<Harness> {
  const checks = await openChecksFixture();
  const registry = createDeliveryActionRegistry(
    checks.fixture.appPg,
    createDeliveryHandlers(SECRET, mergeDispatchStub("accept-review")),
    registrationStub("accept-review", checks.fixture.appPg),
  );
  const context = (
    path: string,
    params: Record<string, string>,
    as: string,
    organizationId: string,
    agent = false,
  ): ActionContext => ({
    request: new Request(`http://test${path}`, {
      headers: { "Bakery-Organization-Id": organizationId },
    }),
    params,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    principal: {
      principalId: as,
      principalType: "service",
      displayName: "Reviewer override",
    },
    ...(agent ? { agentSession: { attemptId: crypto.randomUUID() } } : {}),
  });
  return {
    ...checks,
    async accept(input) {
      const result = await registry.execute(
        DeliveryImplementedAction.RunReviewsAccept,
        context(
          `/v1/runs/${input.runId}/reviews/${input.reviewId}/accept`,
          { id: input.runId, reviewId: input.reviewId },
          input.as,
          input.organizationId ?? checks.fixture.organizationId,
          input.agent,
        ),
        { reason: input.reason },
        {
          operation: DeliveryImplementedAction.RunReviewsAccept,
          idempotencyKey: crypto.randomUUID(),
          target: normalizeRegisteredRouteTarget(
            "/v1/runs/:id/reviews/:reviewId/accept",
            { id: input.runId, reviewId: input.reviewId },
          ),
        },
      ) as { status: number; body: Uint8Array };
      // A command answers with an encoded response; the review is its JSON body.
      assertEquals(result.status, 201);
      return JSON.parse(new TextDecoder().decode(result.body)) as Accepted;
    },
    async reviews(runId, as) {
      const page = await registry.execute(
        DeliveryImplementedAction.RunReviewsList,
        context(
          `/v1/runs/${runId}/reviews`,
          { id: runId },
          as,
          checks.fixture.organizationId,
        ),
        {},
      ) as { items: Accepted[] };
      return page.items;
    },
  };
}

let shared: Promise<Harness> | undefined;
async function withHarness(work: (h: Harness) => Promise<void>) {
  shared ??= open();
  await work(await shared);
}

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

async function blockedReview(h: Harness, status = "changes_requested") {
  const run: ReviewRun = await seedReviewRun(h.owner, h.scope());
  const reviewId = await insertReviewCycle(h.owner, {
    organizationId: h.fixture.organizationId,
    runId: run.runId,
    runStepId: run.reviewStepId,
    reviewerSessionId: run.reviewerSessionId,
    implementerSessionId: run.implementerSessionId,
    status,
    findingCount: 1,
    blockingCount: status === "changes_requested" ? 1 : 0,
  });
  return { run, reviewId };
}

const ledger = async (h: Harness, reviewId: string) =>
  (await h.owner.query<{ reason: string; decidedBy: string }>(
    `select reason, decided_by as "decidedBy" from bakery.decisions_ledger
      where subject_kind = 'review' and subject_id = $1
        and kind = 'accept_with_reason'`,
    [reviewId],
  )).rows;

const refusedWith = async (
  work: () => Promise<unknown>,
  code: string,
  reason?: string,
) => {
  const error = await assertRejects(work, StandardError);
  assertEquals(error.code, code);
  if (reason !== undefined) {
    assertEquals(
      (error.params as { reason?: string } | undefined)?.reason,
      reason,
    );
  }
};

test("AC: an administrator accepts a review that requested changes, with a reason shown on the review", () =>
  withHarness(async (h) => {
    const admin = await h.addPrincipal(h.fixture.organizationId, "admin");
    const { run, reviewId } = await blockedReview(h);

    const accepted = await h.accept({
      runId: run.runId,
      reviewId,
      reason: "The finding is a style preference; shipping as is.",
      as: admin,
    });
    assertEquals(accepted.status, "changes_requested");
    assertEquals(accepted.acceptedBy, admin);
    // The read names who accepted, from the principal's own display name.
    const name = (await h.owner.query<{ display_name: string }>(
      "select display_name from bakery.principals where id = $1",
      [admin],
    )).rows[0].display_name;
    assert(name.trim() !== "");
    assertEquals(accepted.acceptedByName, name);
    assertEquals(
      accepted.acceptReason,
      "The finding is a style preference; shipping as is.",
    );
    assert(accepted.acceptedAt !== null);

    // In the open: the ledger holds it, and the review list shows it.
    assertEquals(await ledger(h, reviewId), [{
      reason: "The finding is a style preference; shipping as is.",
      decidedBy: admin,
    }]);
    const listed = (await h.reviews(run.runId, admin)).find((item) =>
      item.id === reviewId
    );
    assertEquals(listed?.acceptedBy, admin);
    assertEquals(listed?.acceptedByName, name, "the list names them too");
    assertEquals(
      listed?.acceptReason,
      "The finding is a style preference; shipping as is.",
    );
    // The review itself is still what the reviewer found.
    assertEquals(listed?.status, "changes_requested");
  }));

test("AC: a developer and an agent are refused, and nothing is recorded", () =>
  withHarness(async (h) => {
    const admin = await h.addPrincipal(h.fixture.organizationId, "admin");
    const developer = await h.addPrincipal(
      h.fixture.organizationId,
      "developer",
    );
    const { run, reviewId } = await blockedReview(h);

    await refusedWith(
      () =>
        h.accept({ runId: run.runId, reviewId, reason: "ok", as: developer }),
      "AUTH_FORBIDDEN",
    );
    // An agent never overrules a reviewer, whoever it acts for.
    await refusedWith(
      () =>
        h.accept({
          runId: run.runId,
          reviewId,
          reason: "ok",
          as: admin,
          agent: true,
        }),
      "AUTH_FORBIDDEN",
    );
    assertEquals(await ledger(h, reviewId), []);
  }));

test("AC: a member whose custom role holds review:accept may record it, one without may not", () =>
  withHarness(async (h) => {
    const { run, reviewId } = await blockedReview(h);
    const withRole = async (label: string, permissions: string[]) => {
      const member = await h.addPrincipal(
        h.fixture.organizationId,
        "developer",
      );
      const roleId = crypto.randomUUID();
      await h.owner.query(
        `insert into bakery.organization_roles
           (id, organization_id, key, name, permissions, created_by_principal_id)
         values ($1, $2, $3, $3, $4, $5)`,
        [roleId, h.fixture.organizationId, label, permissions, member],
      );
      await h.owner.query(
        `update bakery.organization_memberships set custom_role_id = $3
          where organization_id = $1 and principal_id = $2`,
        [h.fixture.organizationId, member, roleId],
      );
      return member;
    };
    const without = await withRole("reads-only", ["review:read"]);
    await refusedWith(
      () => h.accept({ runId: run.runId, reviewId, reason: "ok", as: without }),
      "AUTH_FORBIDDEN",
    );
    const holder = await withRole("overrulers", ["review:accept"]);
    const accepted = await h.accept({
      runId: run.runId,
      reviewId,
      reason: "delegated overrule",
      as: holder,
    });
    assertEquals(accepted.acceptedBy, holder);
  }));

test("AC: an approved review has nothing to overrule, and a review is accepted once", () =>
  withHarness(async (h) => {
    const admin = await h.addPrincipal(h.fixture.organizationId, "admin");
    const approved = await blockedReview(h, "approved");
    await refusedWith(
      () =>
        h.accept({
          runId: approved.run.runId,
          reviewId: approved.reviewId,
          reason: "ok",
          as: admin,
        }),
      "STATE_CONFLICT",
      "review_not_blocking",
    );
    assertEquals(await ledger(h, approved.reviewId), []);

    const blocked = await blockedReview(h);
    await h.accept({
      runId: blocked.run.runId,
      reviewId: blocked.reviewId,
      reason: "first",
      as: admin,
    });
    await refusedWith(
      () =>
        h.accept({
          runId: blocked.run.runId,
          reviewId: blocked.reviewId,
          reason: "second",
          as: admin,
        }),
      "STATE_CONFLICT",
      "review_already_accepted",
    );
    assertEquals((await ledger(h, blocked.reviewId)).length, 1);
  }));

test("AC: a blank reason is refused before anything is written", () =>
  withHarness(async (h) => {
    const admin = await h.addPrincipal(h.fixture.organizationId, "admin");
    const { run, reviewId } = await blockedReview(h);
    await refusedWith(
      () => h.accept({ runId: run.runId, reviewId, reason: "   ", as: admin }),
      "UNPROCESSABLE",
    );
    await refusedWith(
      () =>
        h.accept({
          runId: run.runId,
          reviewId,
          reason: "bad \ud800",
          as: admin,
        }),
      "MALFORMED_REQUEST",
    );
    assertEquals(await ledger(h, reviewId), []);
  }));

test("AC: another organization's review and a review of another run are not found", () =>
  withHarness(async (h) => {
    const admin = await h.addPrincipal(h.fixture.organizationId, "admin");
    const foreignAdmin = await h.addPrincipal(h.otherOrganizationId, "admin");
    const { run, reviewId } = await blockedReview(h);
    const other = await blockedReview(h);

    // An administrator of another organization.
    await refusedWith(
      () =>
        h.accept({
          runId: run.runId,
          reviewId,
          reason: "ok",
          as: foreignAdmin,
          organizationId: h.otherOrganizationId,
        }),
      "RESOURCE_NOT_FOUND",
    );
    // The right organization, but the review belongs to a different run.
    await refusedWith(
      () =>
        h.accept({
          runId: other.run.runId,
          reviewId,
          reason: "ok",
          as: admin,
        }),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(await ledger(h, reviewId), []);
  }));

Deno.test({
  name: "closes the shared accept-review harness",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = shared;
    shared = undefined;
    if (h) await (await h).close();
  },
});
