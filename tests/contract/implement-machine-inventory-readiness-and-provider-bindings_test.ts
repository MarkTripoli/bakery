// Machine readiness contract suite: the 15 new machine-readiness/provider-binding
// action entries round-trip through the real server routes with input and
// output validated against the generated contract schemas.
import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  adminRequest,
  enrollWorker,
  problemCode,
  registeredWorker,
  registerWorker,
  workerCredential,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

const OBSERVED = "2026-09-20T00:00:00.000Z";

Deno.test("enrollment contract entries round-trip status, cancel and replace", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue59-contract-enroll",
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = contractSchemas.WorkerEnrollment.parse(
      await enrollmentResponse.json(),
    );

    const status = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(status.status, 200);
    const statusBody = contractSchemas.EnrollmentStatus.parse(
      await status.json(),
    );
    assertEquals(statusBody.state, "pending");
    assertEquals(statusBody.enrollmentId, enrollment.enrollmentId);
    assertEquals(statusBody.workerHostId, null);
    assertEquals(statusBody.worker, null);

    const cancelKey = crypto.randomUUID();
    const cancel = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: cancelKey },
    );
    assertEquals(cancel.status, 200);
    const cancelBody = contractSchemas.EnrollmentStatus.parse(
      await cancel.json(),
    );
    assertEquals(cancelBody.state, "canceled");
    // The original idempotency key replays the stored cancellation response.
    const replay = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: cancelKey },
    );
    assertEquals(replay.status, 200);
    contractSchemas.EnrollmentStatus.parse(await replay.json());
    // A second cancel verb with a fresh key on an already-canceled enrollment
    // is a state conflict, not a success.
    const duplicate = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(duplicate.status, 409);
    assertEquals(await problemCode(duplicate), "STATE_CONFLICT");
    // Replacement issues a new one-use token with the same intended config,
    // but only while the predecessor enrollment is still pending: replacing a
    // canceled enrollment is a state conflict, not a success.
    const pendingResponse = await enrollWorker(fixture, {
      name: "issue59-contract-enroll",
    });
    assertEquals(pendingResponse.status, 201);
    const pending = contractSchemas.WorkerEnrollment.parse(
      await pendingResponse.json(),
    );
    const replacement = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${pending.enrollmentId}/replacements`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacement.status, 201);
    const replacementResponse = contractSchemas.WorkerEnrollment.parse(
      await replacement.json(),
    );
    assertEquals(
      replacementResponse.enrollmentId !== pending.enrollmentId,
      true,
    );
    // The replaced predecessor stays inspectable with its derived state.
    const inspect = await workerRequest(
      fixture,
      workerCredential(),
      "/v1/worker/enrollment-inspection",
      { enrollmentToken: pending.enrollmentToken },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(inspect.status, 200);
    const inspection = contractSchemas.WorkerEnrollmentInspection.parse(
      await inspect.json(),
    );
    assertEquals(inspection.name, "issue59-contract-enroll");
    assertEquals(inspection.state, "canceled");
    // Replacing an already-canceled enrollment is rejected.
    const replacedConflict = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${pending.enrollmentId}/replacements`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacedConflict.status, 409);
    assertEquals(await problemCode(replacedConflict), "STATE_CONFLICT");
  }));

Deno.test("inspection schema reports the organization intent before registration", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue59-contract-inspect",
      slots: 2,
    });
    const enrollment = contractSchemas.WorkerEnrollment.parse(
      await enrollmentResponse.json(),
    );
    const inspect = await workerRequest(
      fixture,
      workerCredential(),
      "/v1/worker/enrollment-inspection",
      { enrollmentToken: enrollment.enrollmentToken },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(inspect.status, 200);
    assertEquals(
      inspect.headers.get("Cache-Control"),
      "no-store",
    );
    const inspection = contractSchemas.WorkerEnrollmentInspection.parse(
      await inspect.json(),
    );
    assertEquals(inspection.slots, 2);
    assertEquals(inspection.state, "pending");
  }));

Deno.test("inventory report, components list and host projection match schemas", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-contract-inventory",
      capabilities: ["git"],
    });
    const inventory = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: worker.registration.registrationGeneration,
        expectedInventoryRevision: 1,
        components: [{
          componentKey: "harness.bakery",
          kind: "harness",
          actualVersion: "1.0",
          installOwner: "bakery",
          adapterVersion: "1.0",
          observedAt: OBSERVED,
          capabilities: ["git"],
          maintenanceSupport: { remoteLogin: "device" },
        }],
        checks: [{
          checkId: "capability:git",
          checkVersion: "1",
          componentKey: "harness.bakery",
          status: "pass",
          observedAt: OBSERVED,
        }],
      },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    assertEquals(inventory.status, 200);
    const receipt = contractSchemas.WorkerInventoryReceipt.parse(
      await inventory.json(),
    );
    assertEquals(receipt.acceptedComponents, 1);
    assertEquals(receipt.acceptedChecks, 1);
    assertEquals(receipt.inventoryRevision > 0, true);
    assertEquals(receipt.replayed, false);

    const components = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/components?limit=25`,
      undefined,
      { method: "GET" },
    );
    assertEquals(components.status, 200);
    const componentItems = (contractSchemas["Page<WorkerComponent>"].parse(
      await components.json(),
    ) as unknown as { items: { componentKey: string }[] }).items;
    assertEquals(componentItems.length, 1);
    assertEquals(componentItems[0].componentKey, "harness.bakery");

    const binding = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
      {
        componentKey: "harness.bakery",
        provider: "anthropic",
        billingRoute: "subscription",
        enabled: true,
        authMode: "host_native",
        credentialLocation: "harness_host",
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(binding.status, 201);
    const bindingBody = contractSchemas.WorkerProviderBinding.parse(
      await binding.json(),
    ) as unknown as Record<string, string>;
    const list = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings?limit=25`,
      undefined,
      { method: "GET" },
    );
    assertEquals(list.status, 200);
    const bindingPage = contractSchemas["Page<WorkerProviderBinding>"].parse(
      await list.json(),
    ) as unknown as { items: { id: string; authGeneration: number }[] };
    assertEquals(bindingPage.items.length, 1);
    assertEquals(bindingPage.items[0].id, bindingBody.id);
    assertEquals(bindingPage.items[0].authGeneration, 1);

    const update = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${bindingBody.id}`,
      { enabled: false },
      {
        method: "PATCH",
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": '"1"' },
      },
    );
    assertEquals(update.status, 200);
    contractSchemas.WorkerProviderBinding.parse(await update.json());
  }));

Deno.test("provider auth attempt entries round-trip create, read, report and cancel", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-contract-auth",
      capabilities: ["git"],
    });
    const hostId = worker.registration.workerHostId;
    await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: worker.registration.registrationGeneration,
        expectedInventoryRevision: 1,
        components: [{
          componentKey: "harness.bakery",
          kind: "harness",
          actualVersion: "1.0",
          installOwner: "bakery",
          adapterVersion: "1.0",
          observedAt: OBSERVED,
          capabilities: ["git"],
          maintenanceSupport: { remoteLogin: "device" },
        }],
        checks: [{
          checkId: "capability:git",
          checkVersion: "1",
          status: "pass",
          observedAt: OBSERVED,
        }],
      },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const created = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings`,
      {
        componentKey: "harness.bakery",
        provider: "anthropic",
        billingRoute: "subscription",
        authMode: "host_native",
        credentialLocation: "harness_host",
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(created.status, 201);
    const binding = (await created.json()) as { id: string; version: number };

    const attempt = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}/auth-attempts`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(attempt.status, 201);
    const attemptCreated = contractSchemas.WorkerProviderAuthAttemptCreated
      .parse(await attempt.json());
    assertEquals(attemptCreated.flow, "remote_device");
    assertEquals(attemptCreated.state, "pending");
    assertEquals(attemptCreated.instructions, null);

    const challengeKey = crypto.randomUUID();
    const challenge = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptCreated.authAttemptId}/reports`,
      { reportId: crypto.randomUUID(), phase: "challenge_requested" },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: challengeKey,
      },
    );
    assertEquals(challenge.status, 200);
    assertEquals(challenge.headers.get("Cache-Control"), "no-store");
    const challengeBody = contractSchemas.WorkerProviderAuthAttempt.parse(
      await challenge.json(),
    );
    assertEquals(challengeBody.state, "challenge_issued");
    const challengePayload = challengeBody.challenge as { nonce: string };
    assertEquals(typeof challengePayload.nonce, "string");

    const read = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}/auth-attempts/${attemptCreated.authAttemptId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(read.status, 200);
    contractSchemas.WorkerProviderAuthAttempt.parse(await read.json());

    const canceled = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}/auth-attempts/${attemptCreated.authAttemptId}`,
      {},
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(canceled.status, 200);
    assertEquals(
      contractSchemas.WorkerProviderAuthAttempt.parse(await canceled.json())
        .state,
      "canceled",
    );
  }));

Deno.test("revocation and re-pair enrollment entries round-trip through registered workers", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-contract-repair",
    });
    const hostId = worker.registration.workerHostId;
    const revoked = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/revocations`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(revoked.status, 200);
    const revokedBody = contractSchemas.WorkerHost.parse(await revoked.json());
    assertEquals(revokedBody.status, "revoked");
    assertEquals(revokedBody.desiredMode, "revoked");

    const repair = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/enrollments`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(repair.status, 201);
    const repairEnrollment = contractSchemas.WorkerEnrollment.parse(
      await repair.json(),
    );
    const rePair = await registerWorker(
      fixture,
      repairEnrollment.enrollmentToken,
      workerCredential(),
      {
        name: "issue59-contract-repair",
        protocolVersion: 2,
      },
    );
    assertEquals(rePair.status, 200);
    const rePairBody = contractSchemas.WorkerRegistrationResult.parse(
      await rePair.json(),
    );
    assertEquals(rePairBody.status, "updated");
    assertEquals(rePairBody.workerHostId, hostId);
  }));

Deno.test("malformed machine entries carry the contract problem codes", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-contract-errors",
      capabilities: ["git"],
    });
    const staleRevision = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: worker.registration.registrationGeneration,
        expectedInventoryRevision: 8,
        components: [],
        checks: [],
      },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    assertEquals(staleRevision.status, 409);
    assertEquals(await problemCode(staleRevision), "STATE_CONFLICT");

    const wrongGeneration = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: 999,
        expectedInventoryRevision: 1,
        components: [],
        checks: [],
      },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    assertEquals(wrongGeneration.status, 403);
    assertEquals(await problemCode(wrongGeneration), "AUTH_FORBIDDEN");

    const unknownAttempt = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${crypto.randomUUID()}/reports`,
      { reportId: crypto.randomUUID(), phase: "failure" },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    assertEquals(unknownAttempt.status, 404);
    assertEquals(await problemCode(unknownAttempt), "RESOURCE_NOT_FOUND");

    const missingIfMatch = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${crypto.randomUUID()}`,
      { enabled: false },
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(await problemCode(missingIfMatch), "PRECONDITION_FAILED");
  }));
