// One-paste machine link (#70), end to end through the real routes: the code
// in the command (enroll, inspect, register with the link code, which mints
// the worker's own credential) and the code a terminal prints for an Admin
// (create, look up, approve or decline, poll, register).
import { assert, assertEquals, assertMatch } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import type { DesktopFixture } from "../helpers/desktop-sign-in.ts";
import {
  adminRequest,
  workerCredential,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";

/** One terminal: every public call comes from the same peer address. */
const ONE_MACHINE = {
  remoteAddr: { transport: "tcp" as const, hostname: "203.0.113.70", port: 1 },
};

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

async function publicPost(
  fixture: Fixture,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  // The fixture app takes the peer address as its env, as a real server does.
  const app = fixture.app as unknown as DesktopFixture["app"];
  return await app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ONE_MACHINE,
  );
}

async function clearLinkRateLimits(fixture: Fixture): Promise<void> {
  await fixture.pgDatabase.query(
    `delete from public."rateLimit" where key like 'bakery:worker-link:%'`,
  );
}

const MACHINE = {
  os: "linux",
  architecture: "aarch64",
  hostname: "build-box-01",
};

async function enrollForLink(
  fixture: Fixture,
  body: Record<string, unknown> = {},
  scope?: WorkerScope,
): Promise<{ enrollmentId: string; linkCode: string; command: string }> {
  const response = await adminRequest(
    fixture,
    "/v1/worker-enrollments",
    { capabilities: ["git"], slots: 2, ...body },
    { idempotencyKey: crypto.randomUUID(), scope },
  );
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json();
}

function inspect(
  fixture: Fixture,
  linkCode: string,
  machine: Partial<typeof MACHINE> = {},
): Promise<Response> {
  return publicPost(fixture, "/v1/worker/link-code-inspection", {
    linkCode,
    ...MACHINE,
    ...machine,
  });
}

function registerWithLinkCode(
  fixture: Fixture,
  linkCode: string,
  credential: string,
  options: {
    name?: string;
    os?: string;
    architecture?: string;
    slots?: number;
    capabilities?: string[];
  } = {},
): Promise<Response> {
  return publicPost(fixture, "/v1/worker/registration", {
    linkCode,
    workerCredential: credential,
    name: options.name ?? MACHINE.hostname,
    os: options.os ?? "linux",
    architecture: options.architecture ?? "arm64",
    capabilities: options.capabilities ?? ["git"],
    toolchainVersions: { deno: "2.x" },
    slots: options.slots ?? 2,
  }, { "Idempotency-Key": crypto.randomUUID() });
}

async function createRequest(fixture: Fixture) {
  const response = await publicPost(
    fixture,
    "/v1/worker/link-requests",
    MACHINE,
  );
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as {
    requestId: string;
    userCode: string;
    deviceSecret: string;
    expiresAt: string;
    pollIntervalSeconds: number;
  };
}

async function poll(fixture: Fixture, requestId: string, deviceSecret: string) {
  return await publicPost(
    fixture,
    `/v1/worker/link-requests/${requestId}/polls`,
    { deviceSecret },
  );
}

async function problem(response: Response) {
  return await response.json() as { code?: string; reason?: string };
}

const CODE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;

Deno.test("a link code in the command adds one machine and mints its own credential", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const enrollment = await enrollForLink(fixture);
    assertMatch(enrollment.linkCode, CODE);
    const origin = new URL(fixture.config.publicBaseUrl).origin;
    assertEquals(
      enrollment.command,
      `npx -y ${origin}/v1/worker/link.tgz link --server ${origin} --code ${enrollment.linkCode}`,
    );
    const stored = await fixture.pgDatabase.query<
      { link_code_hash: string; name: string | null; os: string | null }
    >(
      `select link_code_hash, name, os from bakery.worker_enrollments where id = $1`,
      [enrollment.enrollmentId],
    );
    assert(stored.rows[0]!.link_code_hash !== enrollment.linkCode);
    assertEquals(stored.rows[0]!.name, null);
    assertEquals(stored.rows[0]!.os, null);

    // Capitals and the dash do not matter.
    const typed = enrollment.linkCode.toLowerCase().replace("-", "");
    const inspection = await inspect(fixture, typed);
    assertEquals(inspection.status, 200, await inspection.clone().text());
    assertEquals(inspection.headers.get("cache-control"), "no-store");
    const preview = await inspection.json();
    const organization = await fixture.pgDatabase.query<{ name: string }>(
      "select name from bakery.organizations where id = $1",
      [fixture.organizationId],
    );
    assertEquals(preview, {
      organizationName: organization.rows[0]!.name,
      name: "build-box-01",
      slots: 2,
      capabilities: ["git"],
      supported: true,
      supportedSystems: [
        { os: "linux", architecture: "arm64" },
        { os: "linux", architecture: "x64" },
      ],
      expiresAt: preview.expiresAt,
      repairsWorkerHostId: null,
    });

    const credential = workerCredential();
    const registered = await registerWithLinkCode(
      fixture,
      enrollment.linkCode,
      credential,
    );
    assertEquals(registered.status, 200, await registered.clone().text());
    const registration = await registered.json() as {
      workerHostId: string;
      status: string;
    };
    assertEquals(registration.status, "registered");
    fixture.workerHostIds.push(registration.workerHostId);
    const host = await fixture.pgDatabase.query<{
      name: string;
      architecture: string;
      slots: number;
      credential_hash: string;
    }>(
      `select name, architecture, slots, credential_hash from bakery.worker_hosts where id = $1`,
      [registration.workerHostId],
    );
    assertEquals(host.rows[0]!.name, "build-box-01");
    assertEquals(host.rows[0]!.architecture, "arm64");
    assertEquals(host.rows[0]!.credential_hash, await sha256Hex(credential));

    // The existing status watch sees the machine.
    const status = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/worker-enrollments/${enrollment.enrollmentId}`,
        {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    const statusBody = await status.json() as {
      state: string;
      workerHostId: string;
    };
    assertEquals(statusBody.state, "consumed");
    assertEquals(statusBody.workerHostId, registration.workerHostId);

    const again = await inspect(fixture, enrollment.linkCode);
    assertEquals(again.status, 409);
    assertEquals((await problem(again)).reason, "used");

    const audits = await fixture.pgDatabase.query<{ operation: string }>(
      `select operation from bakery.audit_events
       where organization_id = $1
         and operation in ('workers.enroll', 'worker.inspectLinkCode', 'workers.register')
       order by id`,
      [fixture.organizationId],
    );
    assertEquals(audits.rows.map((row) => row.operation).sort(), [
      "worker.inspectLinkCode",
      "workers.enroll",
      "workers.register",
    ]);
  }));

Deno.test("an enroll retry replays the same link code", () =>
  withWorkerFixture(async (fixture) => {
    const key = crypto.randomUUID();
    const body = {
      name: "replayed",
      os: "linux",
      architecture: "arm64",
      capabilities: ["git"],
      slots: 1,
    };
    const first = await adminRequest(fixture, "/v1/worker-enrollments", body, {
      idempotencyKey: key,
    });
    const second = await adminRequest(fixture, "/v1/worker-enrollments", body, {
      idempotencyKey: key,
    });
    const [a, b] = [await first.json(), await second.json()];
    assertEquals(a.linkCode, b.linkCode);
    assertEquals(a.command, b.command);
  }));

Deno.test("a machine with no code is approved in the browser, then links", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const request = await createRequest(fixture);
    assertMatch(request.userCode, CODE);
    assertEquals(request.pollIntervalSeconds, 5);
    const pending = await poll(
      fixture,
      request.requestId,
      request.deviceSecret,
    );
    assertEquals(await pending.json(), { state: "pending" });

    const found = await adminRequest(
      fixture,
      "/v1/worker-link-requests/lookups",
      {
        userCode: request.userCode.toLowerCase(),
      },
    );
    assertEquals(found.status, 200, await found.clone().text());
    const waiting = await found.json();
    assertEquals(waiting.userCode, request.userCode);
    assertEquals(waiting.hostname, "build-box-01");
    assertEquals(waiting.os, "linux");
    assertEquals(waiting.architecture, "arm64");
    assertEquals(waiting.supported, true);
    assertEquals(waiting.state, "pending");
    assertEquals(waiting.enrollmentId, null);

    const key = crypto.randomUUID();
    const approved = await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/approvals`,
      { slots: 2, capabilities: ["git"] },
      { idempotencyKey: key },
    );
    assertEquals(approved.status, 200, await approved.clone().text());
    const approval = await approved.json();
    assertEquals(approval.state, "approved");
    assertEquals(approval.decidedBy, fixture.principalId);
    assert(approval.enrollmentId);
    const replay = await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/approvals`,
      { slots: 2, capabilities: ["git"] },
      { idempotencyKey: key },
    );
    assertEquals(replay.status, 200);
    assertEquals((await replay.json()).enrollmentId, approval.enrollmentId);

    const answer =
      await (await poll(fixture, request.requestId, request.deviceSecret))
        .json();
    assertEquals(answer.state, "approved");
    assertMatch(answer.linkCode, CODE);
    const preview = await (await inspect(fixture, answer.linkCode)).json();
    assertEquals(preview.name, "build-box-01");
    assertEquals(preview.slots, 2);

    const registered = await registerWithLinkCode(
      fixture,
      answer.linkCode,
      workerCredential(),
    );
    assertEquals(registered.status, 200, await registered.clone().text());
    const { workerHostId } = await registered.json();
    fixture.workerHostIds.push(workerHostId);

    assertEquals(
      await (await poll(fixture, request.requestId, request.deviceSecret))
        .json(),
      { state: "approved" },
    );
    const after =
      await (await adminRequest(fixture, "/v1/worker-link-requests/lookups", {
        userCode: request.userCode,
      })).json();
    assertEquals(after.workerHostId, workerHostId);
    const audits = await fixture.pgDatabase.query<{ operation: string }>(
      `select operation from bakery.audit_events
       where organization_id = $1 and operation like 'worker%Link%'
       order by id`,
      [fixture.organizationId],
    );
    assertEquals(audits.rows.map((row) => row.operation).sort(), [
      "worker.inspectLinkCode",
      "worker.pollLinkRequest",
      "workerLinkRequests.approve",
    ]);
  }));

Deno.test("a declined machine stops and can no longer be approved", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const request = await createRequest(fixture);
    const declined = await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/declines`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(declined.status, 200, await declined.clone().text());
    assertEquals((await declined.json()).state, "declined");
    assertEquals(
      await (await poll(fixture, request.requestId, request.deviceSecret))
        .json(),
      { state: "declined" },
    );
    const approve = await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/approvals`,
      { slots: 1, capabilities: ["git"] },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(approve.status, 409);
    assertEquals((await problem(approve)).reason, "declined");
  }));

Deno.test("set up again returns the same one command for the machine", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const enrollment = await enrollForLink(fixture, {
      name: "repair-me",
      os: "linux",
      architecture: "arm64",
    });
    const registered = await registerWithLinkCode(
      fixture,
      enrollment.linkCode,
      workerCredential(),
      { name: "repair-me" },
    );
    const { workerHostId } = await registered.json();
    fixture.workerHostIds.push(workerHostId);
    const revoked = await adminRequest(
      fixture,
      `/v1/workers/${workerHostId}/revocations`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(revoked.status, 200, await revoked.clone().text());
    const repair = await adminRequest(
      fixture,
      `/v1/workers/${workerHostId}/enrollments`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(repair.status, 201, await repair.clone().text());
    const body = await repair.json();
    assertMatch(body.linkCode, CODE);
    assert(body.command.endsWith(`--code ${body.linkCode}`));
    const repairInspection = await inspect(fixture, body.linkCode, {
      architecture: "arm64",
    });
    assertEquals(repairInspection.status, 200);
    assertEquals(
      (await repairInspection.json()).repairsWorkerHostId,
      workerHostId,
    );
    const again = await registerWithLinkCode(
      fixture,
      body.linkCode,
      workerCredential(),
      { name: "repair-me" },
    );
    assertEquals(again.status, 200, await again.clone().text());
    assertEquals((await again.json()).status, "updated");
  }));

Deno.test("the Bakery origin serves the link command as an npm tarball", () =>
  withWorkerFixture(async (fixture) => {
    const response = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/worker/link.tgz`),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "application/gzip");
    assertEquals(response.headers.get("cache-control"), "public, max-age=300");
    const etag = response.headers.get("etag");
    assert(etag);
    const gzipped = new Uint8Array(await response.arrayBuffer());
    const tar = new Uint8Array(
      await new Response(
        new Blob([gzipped]).stream().pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );
    const files = new Map<string, { mode: number; text: string }>();
    for (let at = 0; at + 512 <= tar.byteLength;) {
      const header = tar.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start: number, length: number) =>
        new TextDecoder().decode(header.subarray(start, start + length))
          .replace(/\0.*$/s, "");
      const size = parseInt(field(124, 12), 8);
      files.set(field(0, 100), {
        mode: parseInt(field(100, 8), 8),
        text: new TextDecoder().decode(
          tar.subarray(at + 512, at + 512 + size),
        ),
      });
      at += 512 + Math.ceil(size / 512) * 512;
    }
    assertEquals([...files.keys()], [
      "package/package.json",
      "package/bin/bakery-worker.mjs",
    ]);
    const manifest = JSON.parse(files.get("package/package.json")!.text);
    assertEquals(manifest.name, "@bakery/worker");
    assertEquals(manifest.bin, { "bakery-worker": "bin/bakery-worker.mjs" });
    assertEquals(manifest.type, "module");
    const bin = files.get("package/bin/bakery-worker.mjs")!;
    assert(bin.text.startsWith("#!/usr/bin/env node\n"));
    assertEquals(bin.mode, 0o755);
    // The same build serves the same bytes; a matching ETag answers 304.
    const again = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/worker/link.tgz`, {
        headers: { "if-none-match": etag },
      }),
    );
    assertEquals(again.status, 304);
  }));
