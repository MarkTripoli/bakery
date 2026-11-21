import { assert, assertEquals } from "@std/assert";
import {
  call,
  CHECKLIST_HTML,
  type Fixture,
  install,
  pagesManifest,
  publishWithPages,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  problemCode,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import type { BrokerClaims } from "../../apps/server/src/modules/catalog/plugin-broker.ts";

/**
 * The worker's relay to the plugin broker (#29, B14.02): a contained job has no
 * network, so its worker relays each request. The install the request acts for
 * comes from the job the server wrote, never from the worker, and the lease
 * and fence decide whether the worker may speak for the attempt at all.
 */

const PAGE = { id: "checklist", title: "Checklist", file: "checklist.html" };
const CAPS = [...workerFixtureCapabilities, "plugin.job.contained"];

function recorder() {
  const seen: { claims: BrokerClaims; key: string }[] = [];
  return {
    seen,
    operation: {
      name: "state.read",
      run: (claims: BrokerClaims, args: Readonly<Record<string, unknown>>) => {
        seen.push({ claims, key: String(args.key) });
        return Promise.resolve({ value: "stored" });
      },
    },
  };
}

async function setup(
  fixture: Fixture,
  store: Parameters<typeof publishWithPages>[1],
) {
  const published = await publishWithPages(
    fixture,
    store,
    pagesManifest([PAGE]),
    { "checklist.html": CHECKLIST_HTML },
  );
  const installId = await install(fixture, published);
  const worker = await registeredWorker(fixture, { capabilities: CAPS });
  await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "plugin.job",
      capabilities: ["plugin.job.contained"],
      input: {
        installId,
        versionId: published.versionId,
        entry: "jobs/nightly.js",
      },
    },
  );
  const assignment = await claimAssignment(fixture, worker, {
    capabilities: CAPS,
    supportedActions: ["plugin.job"],
  });
  assertEquals(assignment.action, "plugin.job");
  return { installId, worker, assignment };
}

async function relay(
  fixture: Fixture,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  assignment: Awaited<ReturnType<typeof claimAssignment>>,
  body: unknown,
  over: Record<string, string> = {},
) {
  // A real worker sends its protocol version on every request.
  const host = await fixture.pgDatabase.query<{ version: number }>(
    `select protocol_version as version from bakery.worker_hosts where id = $1`,
    [worker.registration.workerHostId],
  );
  return await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/plugin-broker`,
    body,
    {
      headers: {
        "X-Bakery-Worker-Protocol-Version": String(host.rows[0].version),
        "X-Worker-Lease-Token": String(assignment.leaseToken),
        "X-Worker-Fence": String(assignment.fence),
        "X-Worker-Session-Id": worker.registration.workerSessionId,
        "X-Worker-Session-Generation":
          worker.registration.workerSessionGeneration,
        ...over,
      },
    },
  );
}

const request = (sequence: number, over: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  sequence,
  operation: "state.read",
  args: { key: "a" },
  ...over,
});

Deno.test("a leased job's request reaches the broker as the install its job names", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment } = await setup(fixture, store);
    // The body tries to name another install and organization. It cannot.
    const response = await relay(
      fixture,
      worker,
      assignment,
      request(1, {
        installId: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
        args: { key: "a", installId: crypto.randomUUID() },
      }),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const outcome = await response.json();
    assertEquals(outcome.ok, true);
    assertEquals(rec.seen.length, 1);
    assertEquals(rec.seen[0].claims.installId, installId);
    assertEquals(rec.seen[0].claims.organizationId, fixture.organizationId);
    assertEquals(rec.seen[0].claims.jobId, assignment.jobId);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("a worker without the lease, or with the wrong fence, speaks for nothing", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    for (
      const over of <Record<string, string>[]> [
        { "X-Worker-Lease-Token": "not-the-lease-token" },
        { "X-Worker-Fence": String(BigInt(assignment.fence) + 1n) },
        { "X-Worker-Session-Id": crypto.randomUUID() },
      ]
    ) {
      const response = await relay(
        fixture,
        worker,
        assignment,
        request(1),
        over,
      );
      assertEquals(response.status, 409, JSON.stringify(over));
      assertEquals(await problemCode(response), "LEASE_FENCED");
    }
    // Without the headers at all.
    const bare = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/plugin-broker`,
      request(1),
    );
    assertEquals(bare.status, 400);
    assertEquals(await problemCode(bare), "MALFORMED_REQUEST");
    assertEquals(rec.seen, []);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("another worker cannot use an attempt it was not given", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { assignment } = await setup(fixture, store);
    const other = await registeredWorker(fixture, { capabilities: CAPS });
    const response = await relay(fixture, other, assignment, request(1));
    assertEquals(response.status, 409);
    assertEquals(await problemCode(response), "LEASE_FENCED");
    assertEquals(rec.seen, []);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("an attempt whose job is not a plugin job cannot reach the broker", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    // The claim guard only hands out well-formed work, so the job is changed
    // after the claim: its input still names a real install, and only its
    // action can be what refuses the relay.
    await fixture.pgDatabase.query(
      `update bakery.jobs set action = 'mcp.discover' where id = $1`,
      [assignment.jobId],
    );
    const response = await relay(fixture, worker, assignment, request(1));
    assertEquals(response.status, 409);
    assertEquals(await problemCode(response), "STATE_CONFLICT");
    assertEquals(rec.seen, []);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("turning the install off stops the very next relayed call", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment } = await setup(fixture, store);
    const first = await relay(fixture, worker, assignment, request(1));
    assertEquals((await first.json()).ok, true);
    const off = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(off.status, 200, await off.clone().text());
    const second = await relay(fixture, worker, assignment, request(2));
    assertEquals(second.status, 200);
    assertEquals(await second.json(), {
      ok: false,
      result: null,
      replayed: null,
      denial: "install_off",
    });
    assertEquals(rec.seen.length, 1);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("sequence and replay hold across a job's calls, and an oversized body is refused", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    const body = request(1);
    assertEquals(
      (await (await relay(fixture, worker, assignment, body)).json()).ok,
      true,
    );
    // The same request id again: the recorded result, no second effect.
    const again =
      await (await relay(fixture, worker, assignment, { ...body, sequence: 2 }))
        .json();
    assertEquals(again.replayed, true);
    // A reused sequence number is refused.
    assertEquals(
      await (await relay(fixture, worker, assignment, request(1))).json(),
      { ok: false, result: null, replayed: null, denial: "sequence_replayed" },
    );
    assertEquals(rec.seen.length, 1);
    const huge = await relay(
      fixture,
      worker,
      assignment,
      request(3, { args: { key: "x".repeat(70 * 1024) } }),
    );
    assertEquals(huge.status, 413);
    await huge.body?.cancel();
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("with no operations registered every request is refused as unknown", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    assertEquals(
      await (await relay(fixture, worker, assignment, request(1))).json(),
      { ok: false, result: null, replayed: null, denial: "unknown_operation" },
    );
  }));

Deno.test("a chunked body with no declared length is cut off at the cap, not buffered whole", () => {
  const rec = recorder();
  return withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    const host = await fixture.pgDatabase.query<{ version: number }>(
      `select protocol_version as version from bakery.worker_hosts where id = $1`,
      [worker.registration.workerHostId],
    );
    // A producer that would send 100 MiB if asked, and counts what was asked.
    const CHUNK = 16 * 1024;
    const TOTAL_CHUNKS = 6_400;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
      },
    });
    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/plugin-broker`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${worker.credential}`,
            "Content-Type": "application/json",
            "X-Bakery-Worker-Protocol-Version": String(host.rows[0].version),
            "X-Worker-Lease-Token": String(assignment.leaseToken),
            "X-Worker-Fence": String(assignment.fence),
            "X-Worker-Session-Id": worker.registration.workerSessionId,
            "X-Worker-Session-Generation":
              worker.registration.workerSessionGeneration,
          },
          body,
          // A streamed request body must say it is half-duplex.
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      ),
    );
    assertEquals(response.status, 413);
    assertEquals(await problemCode(response), "BODY_TOO_LARGE");
    // 64 KiB is four chunks; a few more may be in flight. Nowhere near 100 MiB.
    assert(pulled <= 16, `the server pulled ${pulled} chunks before refusing`);
    assertEquals(rec.seen, []);
  }, { pluginBrokerOperations: [rec.operation] });
});

Deno.test("a job keeps what its version asked for: a capability added by an update is not its own", () => {
  const read = recorder();
  const wrote: string[] = [];
  const write = {
    name: "state.write",
    run: () => {
      wrote.push("written");
      return Promise.resolve({ ok: true });
    },
  };
  return withPluginFixture(async (fixture, store) => {
    const first = await publishWithPages(
      fixture,
      store,
      { name: "nightly-helper", requestedCapabilities: ["state.read"] },
      { "jobs/nightly.js": "export default () => 1;\n" },
    );
    assertEquals(first.response.status, 201, await first.response.text());
    const installId = await install(fixture, first);
    const second = await publishWithPages(
      fixture,
      store,
      {
        name: "nightly-helper",
        requestedCapabilities: ["state.read", "state.write"],
      },
      { "jobs/nightly.js": "export default () => 2;\n" },
      first.packageId,
    );
    assertEquals(second.response.status, 201, await second.response.text());

    // A job admitted under the first version, which never asked to write.
    const admit = async (versionId: string) => {
      const worker = await registeredWorker(fixture, { capabilities: CAPS });
      await seedEligibleJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
        {
          action: "plugin.job",
          capabilities: ["plugin.job.contained"],
          input: { installId, versionId, entry: "jobs/nightly.js" },
        },
      );
      const assignment = await claimAssignment(fixture, worker, {
        capabilities: CAPS,
        supportedActions: ["plugin.job"],
      });
      return { worker, assignment };
    };
    const before = await admit(first.versionId);
    const update = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: {
        versionId: second.versionId,
        approveCapabilities: ["state.write"],
      },
    });
    assertEquals(update.status, 200, await update.clone().text());
    assertEquals((await update.json()).pluginVersionId, second.versionId);

    // The install holds state.write now; the job admitted before it does not.
    const denied = await relay(
      fixture,
      before.worker,
      before.assignment,
      request(1, { operation: "state.write", args: {} }),
    );
    assertEquals((await denied.json()).denial, "not_granted");
    assertEquals(wrote, []);
    // What its own version asked for still works.
    const allowed = await relay(
      fixture,
      before.worker,
      before.assignment,
      request(2),
    );
    assertEquals((await allowed.json()).ok, true);

    // A job admitted under the new version may write.
    const after = await admit(second.versionId);
    const written = await relay(
      fixture,
      after.worker,
      after.assignment,
      request(1, { operation: "state.write", args: {} }),
    );
    assertEquals((await written.json()).ok, true);
    assertEquals(wrote, ["written"]);
  }, { pluginBrokerOperations: [read.operation, write] });
});
