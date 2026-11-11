import { assert, assertEquals } from "@std/assert";
import {
  closeWorkerFixture,
  openWorkerFixture,
  problemCode,
  registeredWorker,
  workerRequest,
} from "../worker-execution.ts";
import { claimAssignment, heartbeatRequest } from "./scenarios.ts";
import { withWorkerFixture } from "./scenarios.ts";
import {
  sweepExecutionRetention,
  withCoordinatorRetry,
} from "../../../apps/server/src/modules/execution/coordination.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";

Deno.test("heartbeat redelivers delivered commands until typed outcome is persisted", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-heartbeat-commands",
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const command = await fixture.pgDatabase.query<{
      id: string;
      createdAt: Date | string;
    }>(
      `insert into bakery.worker_commands (
     organization_id, attempt_id, command_type, payload
   ) values ($1, $2, 'steer', $3::jsonb)
   returning id, created_at as "createdAt"`,
      [
        fixture.organizationId,
        assignment.attemptId,
        JSON.stringify({ message: "pause after this turn" }),
      ],
    );
    const commandRow = command.rows[0];
    const commandId = commandRow.id;
    const expectedCommand = {
      id: commandId,
      attemptId: assignment.attemptId,
      messageId: null,
      commandType: "steer",
      payload: { message: "pause after this turn" },
      status: "delivered",
      createdAt: new Date(commandRow.createdAt).toISOString(),
    };
    const heartbeat = (
      ackCommandIds: string[] = [],
      rejectedCommandIds: string[] = [],
    ) =>
      heartbeatRequest(fixture, worker, {
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds,
        rejectedCommandIds,
      });
    const first = await heartbeat();
    const firstBody = await first.json() as {
      pendingCommands: Array<typeof expectedCommand>;
      inventoryRevision: number;
    };
    assertEquals(firstBody.pendingCommands, [expectedCommand]);
    const hostRevision = await fixture.pgDatabase.query<{ revision: number }>(
      `select inventory_revision as revision from bakery.worker_hosts
        where id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(
      firstBody.inventoryRevision,
      Number(hostRevision.rows[0].revision),
    );
    assert(firstBody.inventoryRevision >= 1);
    // A revision bump (repair, inventory change) shows up on the next fresh
    // heartbeat, read from the host row after the heartbeat applies.
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set inventory_revision = inventory_revision + 1
        where id = $1`,
      [worker.registration.workerHostId],
    );
    const bumped = await (await heartbeat()).json() as {
      inventoryRevision: number;
    };
    assertEquals(bumped.inventoryRevision, firstBody.inventoryRevision + 1);
    const second = await heartbeat();
    const secondBody = await second.json() as {
      pendingCommands: Array<typeof expectedCommand>;
    };
    assertEquals(secondBody.pendingCommands, [expectedCommand]);
    const malformed = await heartbeat([commandId], [commandId]);
    assertEquals(malformed.status, 400);
    assertEquals(await problemCode(malformed), "MALFORMED_REQUEST");
    const rejected = await heartbeat([], [commandId]);
    const rejectedBody = await rejected.json() as {
      pendingCommands: Array<unknown>;
      commandAcks: Array<{
        commandId: string;
        status: string;
        acknowledgedAt: string;
      }>;
    };
    assertEquals(rejectedBody.pendingCommands, []);
    const storedAfterReject = await fixture.pgDatabase.query<{
      status: string;
      acknowledgedAt: Date | string | null;
    }>(
      `select status, acknowledged_at as "acknowledgedAt"
     from bakery.worker_commands
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, commandId],
    );
    const rejectedAt = storedAfterReject.rows[0]?.acknowledgedAt;
    assert(rejectedAt);
    assertEquals(rejectedBody.commandAcks[0], {
      commandId,
      status: "rejected",
      acknowledgedAt: new Date(rejectedAt).toISOString(),
    });
    assertEquals(storedAfterReject.rows[0].status, "rejected");

    const acknowledgedCommand = await fixture.pgDatabase.query<{
      id: string;
    }>(
      `insert into bakery.worker_commands (
     organization_id, attempt_id, command_type, payload
   ) values ($1, $2, 'cancel', '{}'::jsonb)
   returning id`,
      [fixture.organizationId, assignment.attemptId],
    );
    const acknowledgedCommandId = acknowledgedCommand.rows[0].id;
    const delivered = await heartbeat();
    const deliveredBody = await delivered.json() as {
      pendingCommands: Array<{ id: string }>;
    };
    assertEquals(
      deliveredBody.pendingCommands.map((command) => command.id),
      [acknowledgedCommandId],
    );
    const acknowledged = await heartbeat([acknowledgedCommandId]);
    const acknowledgedBody = await acknowledged.json() as {
      pendingCommands: Array<unknown>;
      commandAcks: Array<{
        commandId: string;
        status: string;
        acknowledgedAt: string;
      }>;
    };
    assertEquals(acknowledgedBody.pendingCommands, []);
    assertEquals(
      acknowledgedBody.commandAcks[0].commandId,
      acknowledgedCommandId,
    );
    assertEquals(acknowledgedBody.commandAcks[0].status, "acknowledged");
    const final = await heartbeat();
    const finalBody = await final.json() as { pendingCommands: Array<unknown> };
    assertEquals(finalBody.pendingCommands, []);
    const stored = await fixture.pgDatabase.query<{ status: string }>(
      `select status
     from bakery.worker_commands
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    assertEquals(stored.rows[0].status, "acknowledged");
    await fixture.pgDatabase.query(
      `update bakery.worker_commands
      set acknowledged_at = current_timestamp - interval '2 days'
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    const runtimeUser = await fixture.runtimePgDatabase.query<{
      currentUser: string;
    }>('select current_user as "currentUser"');
    assertEquals(runtimeUser.rows[0].currentUser, "bakery_app");
    await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) => sweepExecutionRetention(transaction),
    );
    const compactedCommand = await fixture.pgDatabase.query(
      `select 1 from bakery.worker_commands
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    assertEquals(compactedCommand.rows, []);
    const tombstone = await fixture.pgDatabase.query<{
      status: string;
      acknowledgedAt: Date | string;
    }>(
      `select status, acknowledged_at as "acknowledgedAt"
     from bakery.worker_command_ack_tombstones
    where organization_id = $1 and command_id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    assertEquals(tombstone.rows[0].status, "acknowledged");
    const replayed = await heartbeat([acknowledgedCommandId]);
    const replayedBody = await replayed.json() as {
      commandAcks: Array<{
        commandId: string;
        status: string;
        acknowledgedAt: string;
      }>;
    };
    assertEquals(replayedBody.commandAcks, [{
      commandId: acknowledgedCommandId,
      status: "duplicate",
      acknowledgedAt: new Date(tombstone.rows[0].acknowledgedAt).toISOString(),
    }]);
    await fixture.pgDatabase.query(
      `update bakery.worker_command_ack_tombstones
      set expires_at = current_timestamp - interval '1 second'
    where organization_id = $1 and command_id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    await Promise.all([
      withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      ),
      withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      ),
    ]);
    const collected = await fixture.pgDatabase.query(
      `select 1 from bakery.worker_command_ack_tombstones
    where organization_id = $1 and command_id = $2`,
      [fixture.organizationId, acknowledgedCommandId],
    );
    assertEquals(collected.rows, []);
    const afterCollection = await heartbeat([acknowledgedCommandId]);
    const afterCollectionBody = await afterCollection.json() as {
      commandAcks: Array<unknown>;
    };
    assertEquals(afterCollectionBody.commandAcks, []);
  }));

Deno.test(
  "heartbeat retention races skip locked commands and preserve expiry outcomes",
  async () => {
    const fixture = await openWorkerFixture();
    let gate: {
      query: (queryText: string, values?: unknown[]) => Promise<unknown>;
      release: () => void;
    } | undefined;
    let heartbeatPromise: Promise<Response> | undefined;
    let retentionPromise: Promise<void> | undefined;
    try {
      const worker = await registeredWorker(fixture, {
        name: "issue39-heartbeat-retention-boundary",
      });
      await seedEligibleNonmodelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const claimKey = crypto.randomUUID();
      const assignment = await claimAssignment(fixture, worker, { claimKey });
      const command = await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.worker_commands (
           organization_id, attempt_id, command_type, payload, status,
           acknowledged_at
         ) values (
           $1, $2, 'cancel', '{}'::jsonb, 'acknowledged',
           clock_timestamp() - interval '1 day' - interval '1 second'
         )
         returning id`,
        [fixture.organizationId, assignment.attemptId],
      );
      const commandId = command.rows[0].id;
      const idempotencyKey = crypto.randomUUID();
      const body = {
        workerHostId: worker.registration.workerHostId,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [commandId],
        rejectedCommandIds: [],
      };

      gate = await fixture.runtimePgDatabase.connect();
      await gate.query("begin");
      await gate.query(
        `select id
           from bakery.worker_hosts
          where id = $1
          for update`,
        [worker.registration.workerHostId],
      );
      await gate.query(
        `select id
           from bakery.worker_commands
          where organization_id = $1 and id = $2
          for update`,
        [fixture.organizationId, commandId],
      );
      heartbeatPromise = workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/heartbeat",
        body,
        { idempotencyKey },
      );

      let retentionCompleted = false;
      retentionPromise = withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      ).then(() => {
        retentionCompleted = true;
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          retentionPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("RETENTION_LOCKED_HEARTBEAT_COMMAND")),
              1_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      assert(retentionCompleted);

      await gate.query("rollback");
      gate.release();
      gate = undefined;
      const first = await heartbeatPromise;
      assertEquals(first.status, 200);
      const firstRaw = new Uint8Array(await first.arrayBuffer());
      const immediateReplay = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/heartbeat",
        body,
        { idempotencyKey },
      );
      assertEquals(immediateReplay.status, 200);
      assertEquals(
        new Uint8Array(await immediateReplay.arrayBuffer()),
        firstRaw,
      );

      await fixture.pgDatabase.query(
        `update bakery.worker_heartbeat_replays
            set expires_at = clock_timestamp()
          where organization_id = $1 and worker_host_id = $2
            and idempotency_key = $3`,
        [
          fixture.organizationId,
          worker.registration.workerHostId,
          idempotencyKey,
        ],
      );
      await fixture.pgDatabase.query(
        `update bakery.worker_command_ack_tombstones
            set expires_at = clock_timestamp()
          where organization_id = $1 and command_id = $2`,
        [fixture.organizationId, commandId],
      );
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      );
      const compacted = await fixture.pgDatabase.query<{
        command: number;
        tombstone: number;
        replay: number;
      }>(
        `select
           (select count(*)::int from bakery.worker_commands
             where organization_id = $1 and id = $2) as command,
           (select count(*)::int from bakery.worker_command_ack_tombstones
             where organization_id = $1 and command_id = $2) as tombstone,
           (select count(*)::int from bakery.worker_heartbeat_replays
             where organization_id = $1 and worker_host_id = $3
               and idempotency_key = $4) as replay`,
        [
          fixture.organizationId,
          commandId,
          worker.registration.workerHostId,
          idempotencyKey,
        ],
      );
      assertEquals(compacted.rows[0], { command: 0, tombstone: 0, replay: 0 });

      const afterExpiry = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/heartbeat",
        body,
        { idempotencyKey },
      );
      assertEquals(afterExpiry.status, 200);
      const afterExpiryBody = await afterExpiry.json() as {
        commandAcks: unknown[];
      };
      assertEquals(afterExpiryBody.commandAcks, []);

      const rejectedCommand = await fixture.pgDatabase.query<{
        id: string;
        acknowledgedAt: Date | string;
      }>(
        `insert into bakery.worker_commands (
           organization_id, attempt_id, command_type, payload, status,
           acknowledged_at
         ) values (
           $1, $2, 'cancel', '{}'::jsonb, 'rejected',
           clock_timestamp() - interval '2 days'
         )
         returning id, acknowledged_at as "acknowledgedAt"`,
        [fixture.organizationId, assignment.attemptId],
      );
      const rejectedCommandId = rejectedCommand.rows[0].id;
      await fixture.pgDatabase.query(
        `insert into bakery.worker_command_ack_tombstones (
           command_id, organization_id, worker_host_id, status,
           acknowledged_at, expires_at
         ) values (
           $1, $2, $3, 'rejected', $4,
           clock_timestamp() - interval '1 second'
         )`,
        [
          rejectedCommandId,
          fixture.organizationId,
          worker.registration.workerHostId,
          rejectedCommand.rows[0].acknowledgedAt,
        ],
      );
      const rejectedBody = {
        ...body,
        ackCommandIds: [],
        rejectedCommandIds: [rejectedCommandId],
      };
      const rejectedGate = await fixture.runtimePgDatabase.connect();
      await rejectedGate.query("begin");
      await rejectedGate.query(
        `select id
           from bakery.worker_commands
          where organization_id = $1 and id = $2
          for update`,
        [fixture.organizationId, rejectedCommandId],
      );
      const rejectedHeartbeat = workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/heartbeat",
        rejectedBody,
        { idempotencyKey: crypto.randomUUID() },
      );
      let rejectedRetentionComplete = false;
      const rejectedRetention = withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      ).then(() => {
        rejectedRetentionComplete = true;
      });
      let rejectedTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rejectedRetention,
          new Promise<never>((_, reject) => {
            rejectedTimeout = setTimeout(
              () => reject(new Error("RETENTION_LOCKED_REJECTED_COMMAND")),
              1_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(rejectedTimeout);
      }
      assert(rejectedRetentionComplete);
      await rejectedGate.query("rollback");
      rejectedGate.release();
      const rejectedHeartbeatResponse = await rejectedHeartbeat;
      assertEquals(rejectedHeartbeatResponse.status, 200);
      const rejectedHeartbeatBody = await rejectedHeartbeatResponse.json() as {
        commandAcks: Array<{
          commandId: string;
          status: string;
          acknowledgedAt: string;
        }>;
      };
      assertEquals(rejectedHeartbeatBody.commandAcks, [{
        commandId: rejectedCommandId,
        status: "duplicate",
        acknowledgedAt: new Date(
          rejectedCommand.rows[0].acknowledgedAt,
        ).toISOString(),
      }]);
      const preservedRejected = await fixture.pgDatabase.query<{
        commandStatus: string;
        tombstoneStatus: string;
      }>(
        `select command.status as "commandStatus",
                tombstone.status as "tombstoneStatus"
           from bakery.worker_commands command
           join bakery.worker_command_ack_tombstones tombstone
             on tombstone.command_id = command.id
          where command.organization_id = $1 and command.id = $2`,
        [fixture.organizationId, rejectedCommandId],
      );
      assertEquals(preservedRejected.rows[0], {
        commandStatus: "rejected",
        tombstoneStatus: "rejected",
      });
    } finally {
      if (gate !== undefined) {
        await gate.query("rollback").catch(() => undefined);
        gate.release();
      }
      await retentionPromise?.catch(() => undefined);
      await heartbeatPromise?.catch(() => undefined);
      await closeWorkerFixture(fixture);
    }
  },
);

Deno.test("coordinator retries transient retention failures and stays live", () =>
  withWorkerFixture(async (fixture) => {
    let attempts = 0;
    const recovered = await withCoordinatorRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      );
    });
    assert(recovered);
    assertEquals(attempts, 2);

    let exhaustedAttempts = 0;
    const exhausted = await withCoordinatorRetry(() => {
      exhaustedAttempts++;
      throw Object.assign(new Error("serialization failure"), {
        code: "40001",
      });
    });
    assertEquals(exhausted, false);
    assertEquals(exhaustedAttempts, 4);

    const nextCycle = await withCoordinatorRetry(() =>
      withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      )
    );
    assert(nextCycle);
  }));
