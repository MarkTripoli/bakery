import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  countRows,
  publish,
  seedWorkflowDraft,
  send,
  withFixture,
} from "../helpers/definition-authoring.ts";
import {
  closeWorkerFixture,
  closeWorkerScope,
  createWorkerScope,
  openWorkerFixture,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  admitFundedModelRun as admit,
  fundedModelPolicy,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Issue #48 AC1: simultaneous work keeps capacity, budget, immutability and
// authority invariants. Each test races real production paths against one
// shared limit and reads the stored truth afterwards, never a counter the
// test kept itself.

const CONTENDERS = 16;

Deno.test("AC1: sixteen admissions racing for one installation cap never hold more than the cap", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  let second: WorkerScope | undefined;
  try {
    await seedProviderPricingSnapshot(database);
    second = await createWorkerScope(fixture, "race-second-tenant", fixture);
    // 0.1 each against a 1.0 installation cap: exactly ten fit, whichever
    // organization's transaction gets there first.
    const runs = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, index) =>
        seedRun(
          database,
          index % 2 === 0 ? fixture.organizationId : second!.organizationId,
          fixture.principalId,
          { reservationUsd: "0.1", stepKey: `cap-race-${index}` },
        )),
    );
    const raced = await Promise.allSettled(
      runs.map((run) => admit(database, run)),
    );
    const capUsd = Number(fundedModelPolicy.installationMonthlyLimitUsd);
    const winners = raced.filter((result) => result.status === "fulfilled");
    assertEquals(winners.length, Math.round(capUsd / 0.1));

    const held = (await database.query<{ total: string; holds: string }>(
      `select coalesce(sum(reservation.reserved_usd), 0)::text as total,
              count(*)::text as holds
         from bakery.budget_reservations as reservation
         join bakery.budget_accounts as account
           on account.id = reservation.budget_account_id
        where account.scope = 'installation' and reservation.status = 'held'`,
    )).rows[0];
    assert(held);
    assert(
      Number(held.total) <= capUsd,
      `installation holds ${held.total} exceed the ${capUsd} cap`,
    );
    assertEquals(Number(held.holds), winners.length);
    const account = (await database.query<{ reserved: string }>(
      `select reserved_usd::text as reserved from bakery.budget_accounts
        where scope = 'installation' and organization_id is null`,
    )).rows;
    assertEquals(account.map((row) => Number(row.reserved)), [capUsd]);
  } finally {
    if (second) await closeWorkerScope(fixture, second);
    await closeWorkerFixture(fixture);
  }
});

Deno.test("AC1: eight concurrent publishes of one draft make exactly one immutable version", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "publish-race", {
      role: "admin",
      agent: false,
    });
    const who = { seed: owner };
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      who,
      "publish-race",
    );
    const responses = await Promise.all(
      Array.from(
        { length: 8 },
        () => publish(fixture, who, workflowId, draft),
      ),
    );
    const statuses = responses.map((response) => response.status);
    await Promise.all(responses.map((response) => response.body?.cancel()));
    assertEquals(statuses.filter((status) => status === 200).length, 1);
    // Every loser is refused as stale or already published, never a 5xx.
    for (const status of statuses.filter((status) => status !== 200)) {
      assert([409, 412].includes(status), `unexpected ${status}`);
    }
    assertEquals(
      await countRows(
        fixture,
        `select count(*) from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [owner.organizationId, workflowId],
      ),
      1,
    );
    assertEquals(
      await countRows(
        fixture,
        `select count(*) from bakery.workflow_drafts
          where organization_id = $1 and workflow_id = $2`,
        [owner.organizationId, workflowId],
      ),
      0,
    );
  }));

Deno.test("AC1: a demotion that commits while a write is in flight is never outrun by that write", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "demote-race", {
      role: "admin",
      agent: false,
    });
    const database = fixture.pgDatabase;
    const slug = "held-slug";
    // An uncommitted row holding the slug parks the create request on the
    // unique index after it has passed authorization.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const blocker = withPgTransaction(database, async (transaction) => {
      await transaction.query(
        `insert into bakery.workflow_definitions
           (organization_id, slug, name, description)
         values ($1, $2, 'blocker', '')`,
        [owner.organizationId, slug],
      );
      holding();
      await released;
      throw new Error("roll back the blocker");
    }).catch(() => undefined);
    await held;

    const create = send(fixture, { seed: owner }, "POST", "/v1/workflows", {
      body: { slug, name: slug, description: "" },
    });
    // Let the request reach the slug wait, then demote the member.
    await sleep(500);
    let demotedAt: number | undefined;
    const demotion = database.query(
      `update bakery.organization_memberships
          set role = 'developer', updated_at = now(), version = version + 1
        where organization_id = $1 and principal_id = $2`,
      [owner.organizationId, owner.principalId],
    ).then(() => (demotedAt = performance.now()));
    await sleep(500);
    const demotionCommittedFirst = demotedAt !== undefined;
    release();
    await blocker;
    const response = await create;
    const createdAt = performance.now();
    await demotion;
    const status = response.status;
    await response.body?.cancel();

    // Either the demotion waited for the in-flight write, or the write was
    // refused: a write that already passed its role check must not commit
    // after the role it relied on was taken away.
    if (status === 201) {
      assert(
        !demotionCommittedFirst && demotedAt! >= createdAt - 50,
        "the create committed after the demotion it outran had committed",
      );
    } else {
      assertEquals(status, 403);
    }
    // And the next request sees the demotion.
    const after = await send(
      fixture,
      { seed: owner },
      "POST",
      "/v1/workflows",
      {
        body: { slug: "after-demotion", name: "after", description: "" },
      },
    );
    assertEquals(after.status, 403);
    await after.body?.cancel();
  }));

Deno.test("AC1: two admins demoting each other at once get a clean answer, never a server fault", () =>
  withFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const keeper = await seedOrganization(fixture, "mutual-keeper", {
      role: "admin",
      agent: false,
    });
    const organizationId = keeper.organizationId;
    // Two more admins of the same organization, each with a session.
    const admins = await Promise.all(
      ["mutual-a", "mutual-b"].map(async (label) => {
        const seed = await seedOrganization(fixture, label, { agent: false });
        const membershipId = crypto.randomUUID();
        await database.query(
          `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status, joined_at,
           created_at, updated_at, version
         ) values ($1, $2, $3, 'admin', 'active', now(), now(), now(), 1)`,
          [membershipId, organizationId, seed.principalId],
        );
        return { seed: { ...seed, organizationId }, membershipId };
      }),
    );
    const [a, b] = admins;
    const demote = (by: typeof a, target: typeof a) =>
      send(
        fixture,
        { seed: by.seed },
        "PATCH",
        `/v1/organizations/${organizationId}/memberships/${target.membershipId}`,
        { body: { role: "developer" } },
      );
    for (let round = 0; round < 4; round++) {
      await database.query(
        `update bakery.organization_memberships
            set role = 'admin', version = version + 1
          where id = any($1::uuid[])`,
        [[a.membershipId, b.membershipId]],
      );
      const responses = await Promise.all([demote(a, b), demote(b, a)]);
      const statuses = responses.map((response) => response.status);
      const problems = await Promise.all(
        responses.map(async (response) =>
          JSON.parse(await response.text()) as {
            code?: string;
            reason?: string;
          }
        ),
      );
      for (const [index, status] of statuses.entries()) {
        assert(
          [200, 403, 409].includes(status),
          `round ${round}: ${statuses.join(", ")}`,
        );
        // A lost deadlock is the named, retryable conflict, not any 409.
        if (status === 409) {
          assertEquals(
            { code: problems[index].code, reason: problems[index].reason },
            { code: "STATE_CONFLICT", reason: "concurrent_authority_change" },
          );
        }
      }
      // Whatever the order, at most one of the two demoted the other: the
      // second request either waited and found itself demoted, or lost the
      // deadlock and was told to retry.
      assert(statuses.filter((status) => status === 200).length <= 1);
      const roles = (await database.query<{ role: string }>(
        `select role from bakery.organization_memberships
          where id = any($1::uuid[]) order by role`,
        [[a.membershipId, b.membershipId]],
      )).rows.map((row) => row.role);
      assertEquals(
        roles.filter((role) => role === "admin").length,
        2 - statuses.filter((status) => status === 200).length,
      );
    }
  }));

Deno.test("AC2: a flooded organization's queue never delays another organization's claim", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  let quiet: WorkerScope | undefined;
  try {
    quiet = await createWorkerScope(fixture, "fair-quiet-tenant", fixture);
    // A noisy organization queues a backlog at the highest priority.
    for (let index = 0; index < 40; index++) {
      await seedEligibleNonmodelJob(
        database,
        fixture.organizationId,
        fixture.principalId,
        { priority: 100 },
      );
    }
    const quietJob = await seedEligibleNonmodelJob(
      database,
      quiet.organizationId,
      fixture.principalId,
      { priority: 1 },
    );
    const noisyWorker = await registeredWorker(fixture, {
      name: "fair-noisy",
      slots: 4,
    });
    const quietWorker = await registeredWorker(fixture, {
      name: "fair-quiet",
      slots: 1,
      scope: quiet,
    });
    const claim = (worker: typeof quietWorker) => {
      const claimKey = crypto.randomUUID();
      return workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities: [...workerFixtureCapabilities],
          supportedActions: ["quality.check"],
        },
        { idempotencyKey: claimKey },
      );
    };
    // The noisy worker drains its own backlog while the quiet one claims.
    const [quietClaim, ...noisyClaims] = await Promise.all([
      claim(quietWorker),
      ...Array.from({ length: 4 }, () => claim(noisyWorker)),
    ]);
    assertEquals(quietClaim.status, 200);
    await quietClaim.body?.cancel();
    await Promise.all(noisyClaims.map((response) => response.body?.cancel()));
    const attempts = (await database.query<
      { organization_id: string; job_id: string; worker_host_id: string }
    >(
      `select organization_id, job_id, worker_host_id from bakery.job_attempts
        where worker_host_id = any($1::uuid[])`,
      [[
        quietWorker.registration.workerHostId,
        noisyWorker.registration.workerHostId,
      ]],
    )).rows;
    // The quiet organization's only job went to its own worker at once, and
    // no worker ever crossed into the other organization's queue.
    const quietAttempts = attempts.filter((row) =>
      row.worker_host_id === quietWorker.registration.workerHostId
    );
    assertEquals(quietAttempts.map((row) => row.job_id), [quietJob.jobId]);
    for (const row of attempts) {
      const expected = row.worker_host_id ===
          quietWorker.registration.workerHostId
        ? quiet.organizationId
        : fixture.organizationId;
      assertEquals(row.organization_id, expected);
    }
  } finally {
    if (quiet) await closeWorkerScope(fixture, quiet);
    await closeWorkerFixture(fixture);
  }
});

Deno.test("AC2: oversized bodies from a hostile tenant are refused at the cap while healthy writes proceed", () =>
  withFixture(async (fixture) => {
    const hostile = await seedOrganization(fixture, "flood-hostile", {
      role: "admin",
      agent: false,
    });
    const healthy = await seedOrganization(fixture, "flood-healthy", {
      role: "admin",
      agent: false,
    });
    const capBytes = 1024 * 1024;
    const oversized = JSON.stringify({
      slug: "flood",
      name: "flood",
      description: "x".repeat(2 * capBytes),
    });
    const flood = (declared: boolean) => {
      const headers = new Headers({
        cookie: hostile.cookie,
        "Bakery-Organization-Id": hostile.organizationId,
        origin: authTestOrigin,
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      });
      // Half declare their size; half stream it with no length, so the cap
      // must hold while reading, not only on the header.
      if (declared) {
        headers.set("content-length", String(oversized.length));
      }
      const bytes = new TextEncoder().encode(oversized);
      const body = declared ? bytes : new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
          }
          controller.close();
        },
      });
      return fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/workflows`, {
          method: "POST",
          headers,
          body,
        }),
      );
    };
    const started = performance.now();
    const [hostileResponses, healthyResponses] = await Promise.all([
      Promise.all(
        Array.from({ length: 24 }, (_, index) => flood(index % 2 === 0)),
      ),
      Promise.all(
        Array.from(
          { length: 4 },
          (_, index) =>
            send(fixture, { seed: healthy }, "POST", "/v1/workflows", {
              body: {
                slug: `healthy-${index}`,
                name: `healthy ${index}`,
                description: "",
              },
            }),
        ),
      ),
    ]);
    const elapsedMs = performance.now() - started;
    for (const response of hostileResponses) {
      const problem = await response.json() as {
        code?: string;
        limit?: number;
      };
      assertEquals(response.status, 413);
      assertEquals(problem.code, "BODY_TOO_LARGE");
      assertEquals(problem.limit, capBytes);
    }
    for (const response of healthyResponses) {
      assertEquals(response.status, 201, await response.clone().text());
      await response.body?.cancel();
    }
    // Bounded: the healthy tenant's writes are not held behind the flood.
    assert(
      elapsedMs < 15_000,
      `healthy writes took ${Math.round(elapsedMs)} ms`,
    );
    assertEquals(
      await countRows(
        fixture,
        "select count(*) from bakery.workflow_definitions where organization_id = $1",
        [hostile.organizationId],
      ),
      0,
    );
    assertEquals(
      await countRows(
        fixture,
        "select count(*) from bakery.workflow_definitions where organization_id = $1",
        [healthy.organizationId],
      ),
      4,
    );
  }));
