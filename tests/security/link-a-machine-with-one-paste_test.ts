// Hostile probes for the one-paste machine link (#70): replay and reuse after
// registration, an expired code, another organization's Admin, slot and
// capability escalation at registration, brute force against the rate
// limits, a wrong device secret, and an unsupported system that must not use
// the code up.
import { assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import type { DesktopFixture } from "../helpers/desktop-sign-in.ts";
import {
  adminRequest,
  createWorkerScope,
  workerCredential,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

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

Deno.test("a link code cannot register a second machine after the first", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const { linkCode } = await enrollForLink(fixture);
    const first = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
    );
    assertEquals(first.status, 200, await first.clone().text());
    fixture.workerHostIds.push((await first.json()).workerHostId);
    const replay = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
    );
    assertEquals(replay.status, 409);
    const hosts = await fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.worker_hosts where organization_id = $1",
      [fixture.organizationId],
    );
    assertEquals(hosts.rows[0]!.count, 1);
    const inspection = await inspect(fixture, linkCode);
    assertEquals(inspection.status, 409);
    const body = await problem(inspection);
    assertEquals(body.reason, "used");
    assertEquals(JSON.stringify(body).includes("organization"), false);
  }));

Deno.test("an approved request hands out no code once its machine registered", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const request = await createRequest(fixture);
    await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/approvals`,
      { slots: 1, capabilities: ["git"] },
      { idempotencyKey: crypto.randomUUID() },
    );
    const { linkCode } =
      await (await poll(fixture, request.requestId, request.deviceSecret))
        .json();
    const registered = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      { slots: 1 },
    );
    assertEquals(registered.status, 200, await registered.clone().text());
    fixture.workerHostIds.push((await registered.json()).workerHostId);
    const after =
      await (await poll(fixture, request.requestId, request.deviceSecret))
        .json();
    assertEquals(after, { state: "approved" });
    const reuse = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      { slots: 1 },
    );
    assertEquals(reuse.status, 409);
  }));

Deno.test("an expired link code says expired and registers nothing", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const { enrollmentId, linkCode } = await enrollForLink(fixture);
    await fixture.pgDatabase.query(
      "update bakery.worker_enrollments set expires_at = now() - interval '1 second' where id = $1",
      [enrollmentId],
    );
    const inspection = await inspect(fixture, linkCode);
    assertEquals(inspection.status, 409);
    assertEquals((await problem(inspection)).reason, "expired");
    const registered = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
    );
    assertEquals(registered.status, 404);
  }));

Deno.test("another organization's Admin cannot see or decide a request this one decided", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const other = await createWorkerScope(
      fixture,
      "issue70-other-org",
      fixture,
    );
    const request = await createRequest(fixture);
    const approved = await adminRequest(
      fixture,
      `/v1/worker-link-requests/${request.requestId}/approvals`,
      { slots: 1, capabilities: ["git"] },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(approved.status, 200, await approved.clone().text());
    const lookup = await adminRequest(
      fixture,
      "/v1/worker-link-requests/lookups",
      { userCode: request.userCode },
      { scope: other },
    );
    assertEquals(lookup.status, 404);
    assertEquals((await problem(lookup)).reason, "not_found");
    for (const verb of ["approvals", "declines"]) {
      const decided = await adminRequest(
        fixture,
        `/v1/worker-link-requests/${request.requestId}/${verb}`,
        verb === "approvals"
          ? { slots: 100, capabilities: ["git", "shell"] }
          : {},
        { idempotencyKey: crypto.randomUUID(), scope: other },
      );
      assertEquals(decided.status, 404);
    }
    const enrollments = await fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.worker_enrollments where organization_id = $1",
      [other.organizationId],
    );
    assertEquals(enrollments.rows[0]!.count, 0);
  }));

Deno.test("registration cannot raise the slots or capabilities a link code binds", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const { enrollmentId, linkCode } = await enrollForLink(fixture, {
      slots: 1,
      capabilities: ["git"],
    });
    const moreSlots = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      { slots: 5 },
    );
    assertEquals(moreSlots.status, 422);
    const moreCapabilities = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      {
        slots: 1,
        capabilities: ["git", "shell"],
      },
    );
    assertEquals(moreCapabilities.status, 422);
    const row = await fixture.pgDatabase.query<{ consumed: boolean }>(
      "select consumed_at is not null as consumed from bakery.worker_enrollments where id = $1",
      [enrollmentId],
    );
    assertEquals(row.rows[0]!.consumed, false);
  }));

Deno.test("guessing codes hits RATE_LIMITED", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    // One code tried over and over: the per-code limit.
    const { linkCode } = await enrollForLink(fixture);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await inspect(fixture, linkCode)).status);
    }
    assertEquals(statuses.slice(0, 10).every((status) => status === 200), true);
    const limited = await inspect(fixture, linkCode);
    assertEquals(limited.status, 429);
    assertEquals((await problem(limited)).code, "RATE_LIMITED");
    // Many codes from one source: the per-source limit.
    await clearLinkRateLimits(fixture);
    let last = 0;
    for (let attempt = 0; attempt < 31 && last !== 429; attempt += 1) {
      last = (await inspect(
        fixture,
        `ZZZZ-${String(attempt).padStart(4, "2").replace(/[01]/g, "3")}`,
      )).status;
    }
    assertEquals(last, 429);
    // Registration with guessed codes is limited too.
    await clearLinkRateLimits(fixture);
    let registration = 0;
    for (let attempt = 0; attempt < 21 && registration !== 429; attempt += 1) {
      registration =
        (await registerWithLinkCode(fixture, "ZZZZ-ZZZZ", workerCredential()))
          .status;
    }
    assertEquals(registration, 429);
    // And an Admin looking up user codes.
    await clearLinkRateLimits(fixture);
    let lookup = 0;
    for (let attempt = 0; attempt < 31 && lookup !== 429; attempt += 1) {
      lookup =
        (await adminRequest(fixture, "/v1/worker-link-requests/lookups", {
          userCode: "ZZZZ-ZZZZ",
        })).status;
    }
    assertEquals(lookup, 429);
  }));

Deno.test("a poll with the wrong device secret learns nothing", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const mine = await createRequest(fixture);
    const theirs = await createRequest(fixture);
    await adminRequest(
      fixture,
      `/v1/worker-link-requests/${mine.requestId}/approvals`,
      { slots: 1, capabilities: ["git"] },
      { idempotencyKey: crypto.randomUUID() },
    );
    for (
      const secret of [
        theirs.deviceSecret,
        "not-the-secret",
        mine.deviceSecret + "x",
      ]
    ) {
      const response = await poll(fixture, mine.requestId, secret);
      assertEquals(response.status, 404);
      const body = await response.text();
      assertEquals(body.includes("linkCode"), false);
    }
    const right = await (await poll(fixture, mine.requestId, mine.deviceSecret))
      .json();
    assertEquals(right.state, "approved");
  }));

Deno.test("an unsupported system does not use the code up", () =>
  withWorkerFixture(async (fixture) => {
    await clearLinkRateLimits(fixture);
    const { enrollmentId, linkCode } = await enrollForLink(fixture);
    const inspection = await inspect(fixture, linkCode, {
      os: "darwin",
      architecture: "arm64",
    });
    assertEquals(inspection.status, 200);
    assertEquals((await inspection.json()).supported, false);
    const refused = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      {
        os: "macos",
        architecture: "arm64",
      },
    );
    assertEquals(refused.status, 422);
    const x64 = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
      {
        architecture: "x86_64",
      },
    );
    assertEquals(x64.status, 422);
    const row = await fixture.pgDatabase.query<{ consumed: boolean }>(
      "select consumed_at is not null as consumed from bakery.worker_enrollments where id = $1",
      [enrollmentId],
    );
    assertEquals(row.rows[0]!.consumed, false);
    const supported = await registerWithLinkCode(
      fixture,
      linkCode,
      workerCredential(),
    );
    assertEquals(supported.status, 200, await supported.clone().text());
    fixture.workerHostIds.push((await supported.json()).workerHostId);
  }));
