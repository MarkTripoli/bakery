import { assert, assertEquals } from "@std/assert";
import {
  enrollWorker,
  problemCode,
  registerWorker,
  workerCredential,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";

Deno.test("worker enrollment is one-use and registration stores only a credential hash", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentName = "issue39-one-use";
    const enrollmentResponse = await enrollWorker(fixture, {
      name: enrollmentName,
      capabilities: ["git"],
      slots: 1,
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json() as {
      enrollmentId: string;
      enrollmentToken: string;
      expiresAt: string;
    };
    assert(enrollment.enrollmentToken.length > 0);
    const mismatch = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      workerCredential(),
      { name: "issue39-mismatched-name", capabilities: ["git"] },
    );
    assertEquals(mismatch.status, 422);
    assertEquals(await problemCode(mismatch), "UNPROCESSABLE");
    const invalid = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      "invalid-credential",
      { name: enrollmentName, capabilities: ["git"] },
    );
    assert(invalid.status >= 400 && invalid.status < 500);
    const untouched = await fixture.pgDatabase.query<{
      consumedAt: string | null;
      hostCount: number;
    }>(
      `select enrollment.consumed_at::text as "consumedAt",
          (select count(*)::int from bakery.worker_hosts
            where organization_id = enrollment.organization_id) as "hostCount"
     from bakery.worker_enrollments as enrollment
    where enrollment.id = $1`,
      [enrollment.enrollmentId],
    );
    assertEquals(untouched.rows[0], { consumedAt: null, hostCount: 0 });

    const credential = workerCredential();
    const registrationKey = crypto.randomUUID();
    const registeredResponse = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      credential,
      { name: enrollmentName, idempotencyKey: registrationKey },
    );
    assertEquals(registeredResponse.status, 200);
    const registered = await registeredResponse.json() as {
      workerHostId: string;
      principalId: string;
      registrationGeneration: number;
    };
    const storedNames = await fixture.pgDatabase.query<{
      hostName: string;
      principalName: string;
    }>(
      `select host.name as "hostName", principal.display_name as "principalName"
     from bakery.worker_hosts host
     join bakery.principals principal on principal.id = host.principal_id
    where host.id = $1`,
      [registered.workerHostId],
    );
    assertEquals(storedNames.rows[0], {
      hostName: enrollmentName,
      principalName: enrollmentName,
    });
    const registeredRaw = JSON.stringify(registered);
    assert(!registeredRaw.includes(credential));
    assert(!registeredRaw.includes(enrollment.enrollmentToken));

    const heartbeat = await workerRequest(
      fixture,
      credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: registered.workerHostId,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(heartbeat.status, 200);
    const tokenAsCredential = await workerRequest(
      fixture,
      enrollment.enrollmentToken,
      "/v1/worker/heartbeat",
      {
        workerHostId: registered.workerHostId,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(tokenAsCredential.status, 403);
    assertEquals(await problemCode(tokenAsCredential), "AUTH_FORBIDDEN");

    const changedReplay = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      workerCredential(),
      { idempotencyKey: registrationKey, name: "changed registration" },
    );
    assertEquals(changedReplay.status, 422);
    assertEquals(
      await problemCode(changedReplay),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    const reused = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      workerCredential(),
      { idempotencyKey: crypto.randomUUID() },
    );
    assert(reused.status >= 400 && reused.status < 500);
    const finalCounts = await fixture.pgDatabase.query<{
      hosts: number;
      consumed: number;
    }>(
      `select
     (select count(*)::int from bakery.worker_hosts where organization_id = $1) as hosts,
     (select count(*)::int from bakery.worker_enrollments
       where organization_id = $1 and consumed_at is not null) as consumed`,
      [fixture.organizationId],
    );
    assertEquals(finalCounts.rows[0], { hosts: 1, consumed: 1 });
  }));

Deno.test("worker registration negotiates protocol versions and rejects unsupported versions", () =>
  withWorkerFixture(async (fixture) => {
    const baseEnrollment = await enrollWorker(fixture, {
      name: "issue39-protocol-v1",
    });
    const baseBody = await baseEnrollment.json() as {
      enrollmentToken: string;
    };
    const base = await registerWorker(
      fixture,
      baseBody.enrollmentToken,
      workerCredential(),
      { name: "issue39-protocol-v1" },
    );
    assertEquals(base.status, 200);
    assertEquals(base.headers.get("X-Bakery-Worker-Protocol-Version"), "1");

    const v2Enrollment = await enrollWorker(fixture, {
      name: "issue39-protocol-v2",
    });
    const v2Body = await v2Enrollment.json() as {
      enrollmentToken: string;
    };
    const v2 = await registerWorker(
      fixture,
      v2Body.enrollmentToken,
      workerCredential(),
      { name: "issue39-protocol-v2", protocolVersion: 2 },
    );
    assertEquals(v2.status, 200);
    assertEquals(v2.headers.get("X-Bakery-Worker-Protocol-Version"), "2");

    const unsupportedEnrollment = await enrollWorker(fixture, {
      name: "issue39-protocol-unsupported",
    });
    const unsupportedBody = await unsupportedEnrollment.json() as {
      enrollmentToken: string;
    };
    const unsupported = await registerWorker(
      fixture,
      unsupportedBody.enrollmentToken,
      workerCredential(),
      { name: "issue39-protocol-unsupported", protocolVersion: 3 },
    );
    assertEquals(unsupported.status, 426);
    assertEquals(
      unsupported.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    assertEquals(await problemCode(unsupported), "WORKER_PROTOCOL_UNSUPPORTED");
  }));
