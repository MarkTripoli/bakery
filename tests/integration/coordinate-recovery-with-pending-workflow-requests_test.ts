import { assert, assertEquals, assertRejects } from "@std/assert";
import { appendDomainEvent, withPgTransaction } from "@bakery/persistence";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { openOutboxTestFixture } from "../helpers/outbox-fixture.ts";

Deno.test("workflow recovery coordinates durable delivery without losing expired owners", async (test) => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const otherOrganizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const repository = createBakeryPostgresWorkflowRepository({
    database: appPg,
    maxAttempts: 3,
  });
  const runIds: string[] = [];
  const taskIds: string[] = [];
  try {
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${otherOrganizationId}, 'Other recovery tenant', ${otherOrganizationId},
        '{}'::jsonb, clock_timestamp(), clock_timestamp(), 1
      )`;
    await owner`
      insert into bakery.principals (id, display_name, principal_type)
      values (${principalId}, 'Recovery tester', 'service')`;
    await owner`
      insert into bakery.applications (id, organization_id, slug, name)
      values (${applicationId}, ${organizationId}, ${applicationId}, 'Recovery')`;
    await owner`
      insert into bakery.conversations (id, organization_id, application_id, title, created_by)
      values (${conversationId}, ${organizationId}, ${applicationId}, 'Recovery', ${principalId})`;
    await owner`
      insert into bakery.workflow_definitions (id, organization_id, slug, name, description)
      values (${workflowId}, ${organizationId}, ${workflowId}, 'Recovery', '')`;
    // These storage-level tests exercise owner/delivery selection, not the
    // interpreter or admission validation; the real-engine test covers those.
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
        digest, status, created_by
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1, '{}', '{}'::jsonb,
        ${"a".repeat(64)}, 'published', ${principalId}
      )`;
    const seedRun = async (): Promise<string> => {
      const runId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      taskIds.push(taskId);
      runIds.push(runId);
      await owner`
        insert into bakery.tasks (
          id, organization_id, application_id, conversation_id, title,
          task_type, status, created_by
        ) values (
          ${taskId}, ${organizationId}, ${applicationId}, ${conversationId},
          'Recovery', 'maintenance', 'queued', ${principalId}
        )`;
      await owner`
        insert into bakery.workflow_runs (
          id, organization_id, task_id, workflow_version_id, requested_by,
          status, snapshot, updated_at
        ) values (
          ${runId}, ${organizationId}, ${taskId}, ${workflowVersionId},
          ${principalId}, 'queued', '{}'::jsonb, clock_timestamp() - interval '10 seconds'
        )`;
      return runId;
    };
    const ageRun = async (runId: string): Promise<void> => {
      await owner`
        update bakery.workflow_runs
           set updated_at = clock_timestamp() - interval '10 seconds'
         where organization_id = ${organizationId} and id = ${runId}`;
    };
    let eventVersion = 0;
    const delivery = async (
      runId: string,
      options: {
        organizationId?: string;
        aggregateId?: string;
        eventType?: "run.requested" | "run.updated";
        destination?: "inngest" | "slack";
      } = {},
    ): Promise<string> => {
      const scope = options.organizationId ?? organizationId;
      const aggregateId = options.aggregateId ?? runId;
      const eventType = options.eventType ?? "run.requested";
      const eventId = await withPgTransaction(
        appPg,
        (transaction) =>
          appendDomainEvent(transaction, {
            organizationId: scope,
            eventType,
            aggregateId,
            aggregateVersion: ++eventVersion,
            payload: eventType === "run.requested"
              ? { runId: aggregateId }
              : { runId: aggregateId, version: eventVersion },
            traceId: crypto.randomUUID(),
            outboxDeliveryKey: crypto.randomUUID(),
          }),
      );
      if (options.destination) {
        await owner`
          update bakery.outbox set destination = ${options.destination}
           where organization_id = ${scope} and event_id = ${eventId}`;
      }
      return eventId;
    };
    const state = async (runId: string) => {
      const rows = await owner`
        select version, engine_owner_token, engine_owner_generation,
               engine_owner_lease_expires_at
          from bakery.workflow_runs
         where organization_id = ${organizationId} and id = ${runId}`;
      return rows[0];
    };
    const runId = await seedRun();
    const eventId = await delivery(runId);
    const setStatus = async (
      status: "pending" | "sending" | "failed" | "delivered",
    ): Promise<void> => {
      await owner`
        update bakery.outbox
           set status = ${status},
               lease_token = case when ${status} = 'sending' then gen_random_uuid() else null end,
               lease_until = case when ${status} = 'sending' then clock_timestamp() + interval '1 minute' else null end,
               delivered_at = case when ${status} = 'delivered' then clock_timestamp() else null end,
               engine_event_id = case when ${status} = 'delivered' then 'acknowledged-event' else null end,
               attempt_count = case when ${status} = 'pending' then 0 else 1 end,
               replay_deadline_at = case when ${status} = 'pending' then null else clock_timestamp() + interval '24 hours' end,
               last_error = case when ${status} = 'failed' then '{"code":"DELIVERY_FAILED"}'::jsonb else null end
         where organization_id = ${organizationId} and event_id = ${eventId}`;
    };
    for (const status of ["pending", "sending"] as const) {
      await test.step(`${status} matching delivery leaves null owner and version unchanged`, async () => {
        await setStatus(status);
        await ageRun(runId);
        const before = await state(runId);
        assertEquals(await repository.rearmExpiredEngineOwners(50), []);
        assertEquals(await state(runId), before);
      });
    }
    await test.step("retry delay and expired sending lease remain dispatcher responsibility", async () => {
      await setStatus("pending");
      await owner`
        update bakery.outbox set next_attempt_at = clock_timestamp() + interval '1 hour'
         where organization_id = ${organizationId} and event_id = ${eventId}`;
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      await setStatus("sending");
      await owner`
        update bakery.outbox set lease_until = clock_timestamp() - interval '1 second'
         where organization_id = ${organizationId} and event_id = ${eventId}`;
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
    });
    await test.step("failed delivery allows null-owner lost-wake recovery", async () => {
      await setStatus("failed");
      await ageRun(runId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), [{
        runId,
        generation: "0",
      }]);
    });
    await test.step("fresh delivered request waits for engine owner acceptance", async () => {
      await setStatus("delivered");
      await ageRun(runId);
      const before = await state(runId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      assertEquals(await state(runId), before);
    });
    await test.step("stale delivered request still allows lost-wake recovery", async () => {
      await owner`
        update bakery.outbox
           set delivered_at = clock_timestamp() - interval '10 seconds'
         where organization_id = ${organizationId} and event_id = ${eventId}`;
      await ageRun(runId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), [{
        runId,
        generation: "0",
      }]);
    });
    await test.step("unrelated organization, run, event type and destination do not suppress", async () => {
      for (
        const options of [
          { organizationId: otherOrganizationId },
          { aggregateId: crypto.randomUUID() },
          { eventType: "run.updated" as const },
          { destination: "slack" as const },
        ]
      ) {
        const unrelatedId = await delivery(runId, options);
        await ageRun(runId);
        assertEquals(await repository.rearmExpiredEngineOwners(50), [{
          runId,
          generation: "0",
        }]);
        await owner`delete from bakery.outbox where event_id = ${unrelatedId}`;
        await owner`delete from bakery.domain_events where id = ${unrelatedId}`;
      }
    });
    await test.step("active owner is protected; expired non-null owner recovers even with pending delivery", async () => {
      const liveOwner = await repository.acquireEngineOwner(
        runId,
        "live-owner",
        60_000,
      );
      assert(liveOwner);
      await ageRun(runId);
      const before = await state(runId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      assertEquals(await state(runId), before);
      await setStatus("pending");
      await owner`
        update bakery.workflow_runs
           set engine_owner_lease_expires_at = clock_timestamp() - interval '1 second'
         where organization_id = ${organizationId} and id = ${runId}`;
      assertEquals(await repository.rearmExpiredEngineOwners(50), [{
        runId,
        generation: "1",
      }]);
      assertEquals((await state(runId)).engine_owner_token, null);
      const contenders = await Promise.all([
        repository.acquireEngineOwner(runId, "successor-a", 60_000),
        repository.acquireEngineOwner(runId, "successor-b", 60_000),
      ]);
      assertEquals(contenders.filter(Boolean).length, 1);
      assertEquals((await state(runId)).engine_owner_generation, "2");
    });
    await test.step("handoff is atomic, fenced once, and pending delivery suppresses recovery", async () => {
      await setStatus("delivered");
      const current = await state(runId);
      const engineOwner = {
        runId,
        token: current.engine_owner_token as string,
        generation: current.engine_owner_generation as string,
        leaseMs: 60_000,
      };
      assertEquals(await repository.handoffEngineOwner(engineOwner), true);
      assertEquals(await repository.handoffEngineOwner(engineOwner), false);
      const requests = await owner`
        select count(*)::int as count from bakery.domain_events
         where organization_id = ${organizationId} and aggregate_id = ${runId}
           and event_type = 'run.requested'`;
      assertEquals(requests[0].count, 2);
      await ageRun(runId);
      const before = await state(runId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      assertEquals(await state(runId), before);
    });
    await test.step("fixed-workflow recovery never selects skill import runs", async () => {
      const importRunId = await seedRun();
      await owner`
        update bakery.workflow_runs
           set kind = 'skill_import',
               updated_at = clock_timestamp() - interval '10 seconds'
         where organization_id = ${organizationId} and id = ${importRunId}`;
      const before = await state(importRunId);
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      assertEquals(await state(importRunId), before);
    });
    await test.step("batch limit, oldest-first selection, skip locked, age and terminal status remain intact", async () => {
      const oldest = await seedRun();
      const newer = await seedRun();
      await owner`
        update bakery.workflow_runs set updated_at = clock_timestamp() - interval '20 seconds'
         where organization_id = ${organizationId} and id = ${oldest}`;
      const lock = await appPg.connect();
      try {
        await lock.query("begin");
        await lock.query(
          "select id from bakery.workflow_runs where id = $1 for update",
          [oldest],
        );
        assertEquals(await repository.rearmExpiredEngineOwners(1), [{
          runId: newer,
          generation: "0",
        }]);
      } finally {
        await lock.query("rollback");
        lock.release();
      }
      assertEquals(await repository.rearmExpiredEngineOwners(1), [{
        runId: oldest,
        generation: "0",
      }]);
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      await ageRun(oldest);
      await ageRun(newer);
      await owner`
        update bakery.workflow_runs set status = 'completed'
         where organization_id = ${organizationId} and id in (${oldest}, ${newer})`;
      assertEquals(await repository.rearmExpiredEngineOwners(50), []);
      await assertRejects(
        () => repository.rearmExpiredEngineOwners(0),
        Error,
        "WORKFLOW_RECONCILIATION_LIMIT_INVALID",
      );
    });
  } finally {
    await owner`delete from bakery.outbox where organization_id in (${organizationId}, ${otherOrganizationId})`;
    await owner`delete from bakery.domain_events where organization_id in (${organizationId}, ${otherOrganizationId})`;
    for (const runId of runIds) {
      await owner`delete from bakery.workflow_runs where id = ${runId}`;
    }
    for (const taskId of taskIds) {
      await owner`delete from bakery.tasks where id = ${taskId}`;
    }
    await owner`delete from bakery.workflow_versions where id = ${workflowVersionId}`;
    await owner`delete from bakery.workflow_definitions where id = ${workflowId}`;
    await owner`delete from bakery.conversations where id = ${conversationId}`;
    await owner`delete from bakery.applications where id = ${applicationId}`;
    await owner`delete from bakery.principals where id = ${principalId}`;
    await owner`delete from bakery.organizations where id = ${otherOrganizationId}`;
    await fixture.close();
  }
});
