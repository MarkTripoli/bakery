import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  adminRequest,
  enrollWorker,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

const OBSERVED = "2026-09-20T00:00:00.000Z";
type EnrollmentPageItem = {
  enrollmentId: string;
  state: string;
  workerHostId: string | null;
};
type EnrollmentPage = {
  items: EnrollmentPageItem[];
  nextCursor: string | null;
};

function isEnrollmentPage(value: unknown): value is EnrollmentPage {
  if (
    value === null ||
    typeof value !== "object" ||
    !("items" in value) ||
    !("nextCursor" in value)
  ) {
    return false;
  }
  return (
    Array.isArray(value.items) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null) &&
    value.items.every((item) => {
      if (item === null || typeof item !== "object") return false;
      return "enrollmentId" in item && typeof item.enrollmentId === "string" &&
        "state" in item && typeof item.state === "string" &&
        "workerHostId" in item &&
        (typeof item.workerHostId === "string" || item.workerHostId === null);
    })
  );
}

Deno.test("worker enrollment inventory is a safe organization projection", () =>
  withWorkerFixture(async (fixture) => {
    const consumed = await registeredWorker(fixture, {
      name: "f701-consumed",
      capabilities: ["git"],
    });
    const pendingResponse = await enrollWorker(fixture, {
      name: "f701-pending",
      capabilities: ["shell"],
    });
    assertEquals(pendingResponse.status, 201);
    const pending = await pendingResponse.json() as {
      enrollmentId: string;
      enrollmentToken: string;
    };
    const canceledResponse = await enrollWorker(fixture, {
      name: "f701-canceled",
      capabilities: ["git"],
    });
    assertEquals(canceledResponse.status, 201);
    const canceled = await canceledResponse.json() as { enrollmentId: string };
    const cancel = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${canceled.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(cancel.status, 200);

    const expiredResponse = await enrollWorker(fixture, {
      name: "f701-expired",
      capabilities: ["git"],
    });
    assertEquals(expiredResponse.status, 201);
    const expired = await expiredResponse.json() as { enrollmentId: string };
    await fixture.pgDatabase.query(
      `update bakery.worker_enrollments
          set expires_at = current_timestamp - interval '1 minute'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, expired.enrollmentId],
    );

    const response = await adminRequest(
      fixture,
      "/v1/worker-enrollments?limit=100",
      undefined,
      { method: "GET" },
    );
    assertEquals(response.status, 200);
    const rawBody = await response.text();
    assertEquals(rawBody.includes("enrollmentToken"), false);
    assertEquals(rawBody.includes("tokenHash"), false);
    assertEquals(rawBody.includes(pending.enrollmentToken), false);
    const pageValue = contractSchemas["Page<WorkerEnrollmentSummary>"].parse(
      JSON.parse(rawBody),
    );
    assert(isEnrollmentPage(pageValue));
    const page = pageValue;
    const consumedEntry = page.items.find((item) =>
      item.enrollmentId === consumed.enrollment.enrollmentId
    );
    const pendingEntry = page.items.find((item) =>
      item.enrollmentId === pending.enrollmentId
    );
    const canceledEntry = page.items.find((item) =>
      item.enrollmentId === canceled.enrollmentId
    );
    const expiredEntry = page.items.find((item) =>
      item.enrollmentId === expired.enrollmentId
    );
    assert(canceledEntry);
    assert(expiredEntry);
    assert(consumedEntry);
    assert(pendingEntry);
    assertEquals(consumedEntry.state, "consumed");
    assertEquals(
      consumedEntry.workerHostId,
      consumed.registration.workerHostId,
    );
    assertEquals(pendingEntry.state, "pending");
    assertEquals(pendingEntry.workerHostId, null);
    assertEquals(canceledEntry.state, "canceled");
    assertEquals(expiredEntry.state, "expired");
    assertEquals("enrollmentToken" in consumedEntry, false);
    assertEquals("tokenHash" in consumedEntry, false);
    assertEquals("credential" in consumedEntry, false);
    for (
      const query of [
        "limit=0",
        "limit=101",
        "limit=abc",
        "limit=1.5",
        "limit=1&limit=2",
        "offset=1",
      ]
    ) {
      const invalid = await adminRequest(
        fixture,
        `/v1/worker-enrollments?${query}`,
        undefined,
        { method: "GET" },
      );
      assertEquals(invalid.status, 400, query);
      const problem = await invalid.json() as { code?: string };
      assertEquals(problem.code, "MALFORMED_REQUEST", query);
    }
  }));

Deno.test("worker enrollment cursor retains microsecond ordering", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentIds: string[] = [];
    for (const name of ["f701-cursor-a", "f701-cursor-b", "f701-cursor-c"]) {
      const response = await enrollWorker(fixture, {
        name,
        capabilities: ["git"],
      });
      assertEquals(response.status, 201);
      const body = await response.json() as { enrollmentId: string };
      enrollmentIds.push(body.enrollmentId);
    }
    for (
      const [enrollmentId, createdAt] of enrollmentIds.map((id, index) =>
        [
          id,
          `2026-10-19T00:00:00.123${100 + index * 100}Z`,
        ] as const
      )
    ) {
      await fixture.pgDatabase.query(
        `update bakery.worker_enrollments
            set created_at = $1::timestamptz
          where organization_id = $2 and id = $3`,
        [createdAt, fixture.organizationId, enrollmentId],
      );
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages++;
      if (pages > enrollmentIds.length) {
        throw new Error("enrollment cursor did not advance");
      }
      const response = await adminRequest(
        fixture,
        `/v1/worker-enrollments?limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
        undefined,
        { method: "GET" },
      );
      assertEquals(response.status, 200);
      const pageValue = contractSchemas["Page<WorkerEnrollmentSummary>"].parse(
        await response.json(),
      );
      assert(isEnrollmentPage(pageValue));
      for (const item of pageValue.items) seen.add(item.enrollmentId);
      cursor = pageValue.nextCursor ?? undefined;
    } while (cursor !== undefined);

    assertEquals(
      enrollmentIds.every((enrollmentId) => seen.has(enrollmentId)),
      true,
    );
  }));

Deno.test("dispatch blockers use the same fresh gate as worker claims", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "f701-blocked",
      capabilities: workerFixtureCapabilities,
    });
    const host = await fixture.pgDatabase.query<{
      credentialGeneration: number;
      inventoryRevision: number;
    }>(
      `select credential_generation as "credentialGeneration",
              inventory_revision as "inventoryRevision"
         from bakery.worker_hosts
        where id = $1 and organization_id = $2`,
      [worker.registration.workerHostId, fixture.organizationId],
    );
    const hostRow = host.rows[0];
    assert(hostRow);

    const report = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: hostRow.credentialGeneration,
        expectedInventoryRevision: hostRow.inventoryRevision,
        components: [{
          componentKey: "harness.bakery",
          kind: "harness",
          actualVersion: "1.0",
          installOwner: "bakery",
          adapterVersion: "1.0",
          observedAt: OBSERVED,
          capabilities: workerFixtureCapabilities,
          maintenanceSupport: { remoteLogin: "none" },
        }],
        checks: [{
          checkId: "credential_isolation",
          checkVersion: "1",
          status: "fail",
          reason: "sandbox isolation unavailable",
          observedAt: OBSERVED,
        }],
      },
      {
        idempotencyKey: crypto.randomUUID(),
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(report.status, 200);

    const blockersResponse = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/dispatch-blockers`,
      undefined,
      { method: "GET" },
    );
    assertEquals(blockersResponse.status, 200);
    const blockers = contractSchemas.DispatchBlockers.parse(
      await blockersResponse.json(),
    );
    assertEquals(blockers.allBlocked, true);
    assertEquals(blockers.reason, "check_failed");
    assertEquals(blockers.connectivity, "online");
    assertEquals(blockers.blockedCapabilities, []);
    assertEquals(blockers.failedChecks, [{
      checkId: "credential_isolation",
      reason: "sandbox isolation unavailable",
    }]);

    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const blockedClaimKey = crypto.randomUUID();
    const blockedClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: blockedClaimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: workerFixtureCapabilities,
      },
      { idempotencyKey: blockedClaimKey },
    );
    assertEquals(blockedClaim.status, 204);

    await fixture.pgDatabase.query(
      `update bakery.worker_checks
          set expires_at = current_timestamp - interval '1 minute'
        where organization_id = $1 and worker_host_id = $2
          and check_id = 'credential_isolation'`,
      [fixture.organizationId, worker.registration.workerHostId],
    );

    const freshResponse = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/dispatch-blockers`,
      undefined,
      { method: "GET" },
    );
    assertEquals(freshResponse.status, 200);
    const fresh = contractSchemas.DispatchBlockers.parse(
      await freshResponse.json(),
    );
    assertEquals(fresh.allBlocked, false);
    assertEquals(fresh.reason, null);
    assertEquals(fresh.connectivity, "online");
    assertEquals(fresh.blockedCapabilities, []);
    assertEquals(fresh.failedChecks, []);

    const claimableKey = crypto.randomUUID();
    const claimable = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: claimableKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: workerFixtureCapabilities,
      },
      { idempotencyKey: claimableKey },
    );
    assertEquals(claimable.status, 200);
    const assignment = await claimable.json() as { jobId: string };
    assertEquals(assignment.jobId, job.jobId);
  }));

Deno.test("stale, offline and paused hosts are refused by claims and named by both projections", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "f704-connectivity",
      capabilities: workerFixtureCapabilities,
    });
    const hostId = worker.registration.workerHostId;
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const setHost = async (heartbeatAgeSeconds: number, desiredMode: string) =>
      await fixture.pgDatabase.query(
        `update bakery.worker_hosts
            set last_heartbeat_at = clock_timestamp()
                  - ($3::integer * interval '1 second'),
                desired_mode = $4
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, hostId, heartbeatAgeSeconds, desiredMode],
      );
    const projections = async () => {
      const blockers = contractSchemas.DispatchBlockers.parse(
        await (await adminRequest(
          fixture,
          `/v1/workers/${hostId}/dispatch-blockers`,
          undefined,
          { method: "GET" },
        )).json(),
      );
      const detail = contractSchemas.WorkerHost.parse(
        await (await adminRequest(
          fixture,
          `/v1/workers/${hostId}`,
          undefined,
          { method: "GET" },
        )).json(),
      );
      return { blockers, detail };
    };
    const claim = async () => {
      const claimKey = crypto.randomUUID();
      return await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: hostId,
          capabilities: workerFixtureCapabilities,
        },
        { idempotencyKey: claimKey },
      );
    };

    await setHost(45, "accepting");
    let seen = await projections();
    assertEquals(seen.blockers.reason, "stale");
    assertEquals(seen.blockers.connectivity, "stale");
    assertEquals(seen.blockers.allBlocked, true);
    assertEquals(seen.detail.readinessReason, "stale");
    assertEquals((await claim()).status, 204);

    await setHost(120, "accepting");
    seen = await projections();
    assertEquals(seen.blockers.reason, "offline");
    assertEquals(seen.blockers.connectivity, "offline");
    assertEquals(seen.blockers.allBlocked, true);
    assertEquals(seen.detail.readinessReason, "offline");
    assertEquals((await claim()).status, 204);

    await setHost(0, "paused");
    seen = await projections();
    assertEquals(seen.blockers.reason, "paused");
    assertEquals(seen.blockers.allBlocked, true);
    assertEquals((await claim()).status, 204);

    await setHost(0, "accepting");
    seen = await projections();
    assertEquals(seen.blockers.reason, null);
    assertEquals(seen.blockers.allBlocked, false);
    assertEquals((await claim()).status, 200);
  }));
