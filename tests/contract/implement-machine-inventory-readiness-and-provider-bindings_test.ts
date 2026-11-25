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
          componentKey: "harness.claude",
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
          componentKey: "harness.claude",
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
    assertEquals(componentItems[0].componentKey, "harness.claude");

    const binding = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
      {
        componentKey: "harness.claude",
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

    const patchBinding = (ifMatch: string) =>
      adminRequest(
        fixture,
        `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${bindingBody.id}`,
        { enabled: true },
        {
          method: "PATCH",
          idempotencyKey: crypto.randomUUID(),
          headers: { "If-Match": ifMatch },
        },
      );
    const clientFormat = await patchBinding('"v2"');
    assertEquals(clientFormat.status, 200, await clientFormat.clone().text());
    assertEquals((await patchBinding('"v9"')).status, 412);

    const hostPath = `/v1/workers/${worker.registration.workerHostId}`;
    const host = await adminRequest(fixture, hostPath, undefined, {
      method: "GET",
    });
    const { version } = await host.json() as { version: number };
    const patchHost = (ifMatch: string) =>
      adminRequest(fixture, hostPath, { status: "draining" }, {
        method: "PATCH",
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": ifMatch },
      });
    assertEquals((await patchHost(`"v${version + 7}"`)).status, 412);
    const hostUpdated = await patchHost(`"v${version}"`);
    assertEquals(hostUpdated.status, 200, await hostUpdated.clone().text());
  }));

Deno.test("coding agents serve their payment methods; bindings keep to them (#68)", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue68-payment-methods",
      capabilities: ["git"],
    });
    const hostId = worker.registration.workerHostId;
    const inventory = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: worker.registration.registrationGeneration,
        expectedInventoryRevision: 1,
        components: ["harness.claude", "harness.pi", "harness.bakery"].map((
          componentKey,
        ) => ({
          componentKey,
          kind: "harness",
          actualVersion: "1.0",
          installOwner: "bakery",
          adapterVersion: "1.0",
          observedAt: OBSERVED,
          capabilities: ["git"],
          maintenanceSupport: { remoteLogin: "device" },
        })),
        checks: [],
      },
      {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    assertEquals(inventory.status, 200);
    const components = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/components?limit=25`,
      undefined,
      { method: "GET" },
    );
    assertEquals(components.status, 200);
    const methods = Object.fromEntries(
      (contractSchemas["Page<WorkerComponent>"].parse(
        await components.json(),
      ) as unknown as {
        items: { componentKey: string; paymentMethods: string[] }[];
      }).items.map((item) => [item.componentKey, item.paymentMethods]),
    );
    assertEquals(methods, {
      "harness.bakery": [],
      "harness.claude": ["subscription", "api_metered"],
      "harness.pi": ["api_metered", "local"],
    });

    const bind = (billingRoute: string) =>
      adminRequest(
        fixture,
        `/v1/workers/${hostId}/provider-bindings`,
        {
          componentKey: "harness.pi",
          provider: "openrouter",
          billingRoute,
          enabled: true,
          authMode: "host_native",
          credentialLocation: "harness_host",
        },
        { idempotencyKey: crypto.randomUUID() },
      );
    // Pi takes no subscription: a new binding on it is refused, with the reason.
    const refused = await bind("subscription");
    assertEquals(refused.status, 422);
    const refusedBody = await refused.json() as Record<string, unknown>;
    assertEquals(refusedBody.code, "VALIDATION_FAILED");
    assertEquals(refusedBody.issues, [{
      path: ["billingRoute"],
      message: "This coding agent does not accept this way of paying.",
      code: "payment_method_unsupported",
    }]);

    const accepted = await bind("api_metered");
    assertEquals(accepted.status, 201);
    const binding = contractSchemas.WorkerProviderBinding.parse(
      await accepted.json(),
    ) as unknown as { id: string; paymentMethodSupported: boolean };
    assertEquals(binding.paymentMethodSupported, true);

    // Changing the route to one Pi does not take is refused too.
    const rerouted = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}`,
      { billingRoute: "subscription" },
      {
        method: "PATCH",
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": '"1"' },
      },
    );
    assertEquals(rerouted.status, 422);
    assertEquals(
      (await rerouted.json() as { issues: { code: string }[] }).issues[0]
        .code,
      "payment_method_unsupported",
    );

    // A binding saved before the rule still reads, flagged as needing attention.
    await fixture.pgDatabase.query(
      `update bakery.worker_provider_bindings set billing_route = 'subscription'
        where id = $1`,
      [binding.id],
    );
    const list = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings?limit=25`,
      undefined,
      { method: "GET" },
    );
    assertEquals(list.status, 200);
    const [legacy] = (contractSchemas["Page<WorkerProviderBinding>"].parse(
      await list.json(),
    ) as unknown as {
      items: { billingRoute: string; paymentMethodSupported: boolean }[];
    }).items;
    assertEquals(legacy.billingRoute, "subscription");
    assertEquals(legacy.paymentMethodSupported, false);

    // Re-sending its own unchanged route is no change: a full-body save of the
    // older binding succeeds (#68 ruling).
    const resaved = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}`,
      { billingRoute: "subscription", enabled: false },
      {
        method: "PATCH",
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": '"1"' },
      },
    );
    assertEquals(resaved.status, 200, await resaved.clone().text());
    // Re-sending only the unchanged route changes nothing: the version holds,
    // so another editor's If-Match stays valid.
    const versionOf = async () =>
      (await fixture.pgDatabase.query<{ version: number }>(
        `select version from bakery.worker_provider_bindings where id = $1`,
        [binding.id],
      )).rows[0].version;
    const before = await versionOf();
    const trail = async () =>
      (await fixture.pgDatabase.query<{ events: number; audits: number }>(
        `select
           (select count(*)::int from bakery.domain_events
             where aggregate_id = $1) as events,
           (select count(*)::int from bakery.audit_events
             where resource_id = $1::text) as audits`,
        [binding.id],
      )).rows[0];
    const trailBefore = await trail();
    const noop = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings/${binding.id}`,
      { billingRoute: "subscription" },
      {
        method: "PATCH",
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": `"${before}"` },
      },
    );
    assertEquals(noop.status, 200, await noop.clone().text());
    assertEquals(await versionOf(), before);
    // ...and records nothing: no event, no audit row.
    assertEquals(await trail(), trailBefore);

    // A component the table does not know supports no route: refused on bind
    // (fail closed), and an older binding on it reads as needing attention.
    const unknown = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings`,
      {
        componentKey: "harness.bakery",
        provider: "anthropic",
        billingRoute: "api_metered",
        enabled: true,
        authMode: "host_native",
        credentialLocation: "harness_host",
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(unknown.status, 422);
    assertEquals(
      (await unknown.json() as { issues: { code: string }[] }).issues[0].code,
      "payment_method_unsupported",
    );
    await fixture.pgDatabase.query(
      `update bakery.worker_provider_bindings set component_key = 'harness.bakery'
        where id = $1`,
      [binding.id],
    );
    const unknownList = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/provider-bindings?limit=25`,
      undefined,
      { method: "GET" },
    );
    assertEquals(unknownList.status, 200);
    assertEquals(
      (contractSchemas["Page<WorkerProviderBinding>"].parse(
        await unknownList.json(),
      ) as unknown as { items: { paymentMethodSupported: boolean }[] }).items[0]
        .paymentMethodSupported,
      false,
    );
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
          componentKey: "harness.claude",
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
        componentKey: "harness.claude",
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
