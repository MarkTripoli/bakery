import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { signSessionCookie } from "../helpers/auth.ts";
import {
  claimAssignment,
  type RegisteredWorker,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import {
  createWorkerScope,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerRequest,
  type WorkerScope,
} from "../helpers/worker-execution.ts";

const previewOrigin = "http://localhost:8789";
const options = { env: { BAKERY_ARTIFACT_PREVIEW_ORIGIN: previewOrigin } };
const HEAD = "a".repeat(40);

type PreviewBody = {
  id: string;
  runId: string;
  attemptId: string;
  headSha: string;
  status: string;
  stopReason: string | null;
  stoppedBy: string | null;
  stoppedAt: string | null;
  expiresAt: string;
  routeKey?: unknown;
  upstreamPort?: unknown;
};

/** Another active developer in the same organization, with a live session. */
async function addDeveloper(
  fixture: WorkerFixture,
): Promise<WorkerScope & { remove(): Promise<void> }> {
  const db = fixture.pgDatabase;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `preview-dev-${crypto.randomUUID()}`;
  const now = new Date();
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'Preview developer', $2, true, $3, $3)`,
    [providerUserId, `preview-dev-${providerUserId}@example.test`, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, 'Preview developer', 'human')`,
    [principalId, providerUserId],
  );
  await db.query(
    `insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version)
     values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, now],
  );
  await db.query(
    `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      providerUserId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    email: "",
    organizationId: fixture.organizationId,
    principalId,
    adminCookie: await signSessionCookie(token, fixture.config.auth!.secret),
    ownsAuthIdentity: false,
    async remove() {
      await db.query('delete from public.session where "userId" = $1', [
        providerUserId,
      ]);
      await db.query(
        "delete from bakery.organization_memberships where principal_id = $1",
        [principalId],
      );
      await db.query("delete from bakery.principals where id = $1", [
        principalId,
      ]);
      await db.query('delete from public."user" where id = $1', [
        providerUserId,
      ]);
    },
  };
}

async function liveAttempt(fixture: WorkerFixture, name: string) {
  const worker = await registeredWorker(fixture, { name });
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, job.jobId);
  return { worker, job, assignment };
}

function register(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  assignment: WorkerAssignment,
  body: Record<string, unknown> = {},
  key = crypto.randomUUID(),
) {
  return workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/previews`,
    {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      routeKey: "preview-0123456789",
      upstreamPort: 5173,
      headSha: HEAD,
      ...body,
    },
    { idempotencyKey: key },
  );
}

function person(
  fixture: WorkerFixture,
  path: string,
  init: RequestInit = {},
  scope: WorkerScope = fixture,
) {
  const headers = new Headers(init.headers);
  headers.set("cookie", scope.adminCookie);
  headers.set("bakery-organization-id", scope.organizationId);
  if (init.method && init.method !== "GET") {
    headers.set("origin", fixture.config.publicBaseUrl);
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
  }
  return fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, { ...init, headers }),
  );
}

async function listRun(fixture: WorkerFixture, runId: string) {
  const response = await person(fixture, `/v1/previews?runId=${runId}`);
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()).items as PreviewBody[];
}

async function openPreview(fixture: WorkerFixture, name: string) {
  const live = await liveAttempt(fixture, name);
  const registered = await register(fixture, live.worker, live.assignment);
  assertEquals(registered.status, 201, await registered.clone().text());
  return { ...live, preview: await registered.json() as PreviewBody };
}

Deno.test("a worker of a live attempt registers a preview that never exposes its route key or port", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment, job, preview } = await openPreview(
      fixture,
      "preview-register",
    );
    assertEquals(preview.status, "ready");
    assertEquals(preview.headSha, HEAD);
    assertEquals(preview.runId, job.runId);
    assertEquals(preview.attemptId, assignment.attemptId);
    assertEquals(preview.stopReason, null);
    assertEquals("routeKey" in preview, false);
    assertEquals("upstreamPort" in preview, false);
    const items = await listRun(fixture, job.runId);
    assertEquals(items.map((item) => item.id), [preview.id]);
    assertEquals("routeKey" in items[0], false);
    assertEquals("upstreamPort" in items[0], false);
    assertEquals(
      JSON.stringify(items).includes("preview-0123456789"),
      false,
    );
    // The same registration replays; the route key is never taken by another.
    const replay = await register(fixture, worker, assignment);
    assertEquals(replay.status, 200);
    assertEquals((await replay.json()).id, preview.id);
    const otherPort = await register(fixture, worker, assignment, {
      upstreamPort: 5174,
    });
    assertEquals(otherPort.status, 409);
  }, options));

Deno.test("a route key is a short label, never a host, a path or a port", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment } = await liveAttempt(fixture, "preview-key");
    for (
      const routeKey of [
        "evil.example.com",
        "127.0.0.1:8080",
        "../../etc/passwd",
        "http://169.254.169.254/",
        "UPPERCASE-LABEL",
        "short",
        "a/b/c/d/e/f/g/h",
        "-leading-hyphen-1",
      ]
    ) {
      const refused = await register(fixture, worker, assignment, { routeKey });
      assertEquals(refused.status, 422, routeKey);
    }
    const lowPort = await register(fixture, worker, assignment, {
      upstreamPort: 80,
    });
    assertEquals(lowPort.status >= 400 && lowPort.status < 500, true);
    const count = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.previews where organization_id = $1",
      [fixture.organizationId],
    );
    assertEquals(count.rows[0].n, 0);
  }, options));

Deno.test("a fenced, expired or foreign lease cannot register a preview", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment, job } = await liveAttempt(
      fixture,
      "preview-lease",
    );
    const wrongToken = await register(fixture, worker, {
      ...assignment,
      leaseToken: "x".repeat(40),
    });
    assertEquals(wrongToken.status, 409);
    assertEquals((await wrongToken.json()).code, "LEASE_FENCED");
    const wrongFence = await register(fixture, worker, {
      ...assignment,
      fence: String(BigInt(assignment.fence) + 1n),
    });
    assertEquals(wrongFence.status, 409);
    await fixture.pgDatabase.query(
      "update bakery.job_attempts set lease_expires_at = now() - interval '1 second' where id = $1",
      [assignment.attemptId],
    );
    const expired = await register(fixture, worker, assignment);
    assertNotEquals(expired.status, 201);
    assertEquals((await expired.json()).code, "LEASE_EXPIRED");
    const none = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.previews where run_id = $1",
      [job.runId],
    );
    assertEquals(none.rows[0].n, 0);
  }, options));

Deno.test("a route key held by another attempt is a conflict, not a takeover", () =>
  withWorkerFixture(async (fixture) => {
    const first = await openPreview(fixture, "preview-key-a");
    const second = await liveAttempt(fixture, "preview-key-b");
    const taken = await register(fixture, second.worker, second.assignment);
    assertEquals(taken.status, 409);
    assertEquals(
      (await listRun(fixture, first.job.runId)).map((item) => item.id),
      [first.preview.id],
    );
    assertEquals((await listRun(fixture, second.job.runId)).length, 0);
  }, options));

Deno.test("the access grant is exchangeable for seconds while the session length is separate", () =>
  withWorkerFixture(async (fixture) => {
    const { preview } = await openPreview(fixture, "preview-grant");
    const issued: {
      grantId: string;
      secret: string;
      sessionSeconds: number;
    }[] = [];
    for (const sessionSeconds of [undefined, 60, 86_400]) {
      const before = Date.now();
      const response = await person(
        fixture,
        `/v1/previews/${preview.id}/access`,
        {
          method: "POST",
          body: JSON.stringify(
            sessionSeconds === undefined ? {} : { sessionSeconds },
          ),
        },
      );
      assertEquals(response.status, 201, await response.clone().text());
      assertEquals(
        response.headers.get("cache-control")?.includes("no-store"),
        true,
      );
      const body = await response.json();
      assertEquals(body.grant.length, 43);
      assertEquals(body.sessionSeconds, sessionSeconds ?? 3600);
      issued.push({
        grantId: body.grantId,
        secret: body.grant,
        sessionSeconds: body.sessionSeconds,
      });
      assertEquals(
        body.exchangeUrl,
        `${previewOrigin}/running-preview/exchange`,
      );
      assertEquals(body.previewUrl.startsWith(`${previewOrigin}/`), true);
      // Seconds, never the session length: 30 seconds from issue, whatever
      // session was asked for.
      const lifetime = Date.parse(body.expiresAt) - before;
      assert(lifetime > 0 && lifetime <= 31_000, `grant lifetime ${lifetime}`);
      const row = await fixture.pgDatabase.query(
        `select session_seconds,
                extract(epoch from (expires_at - created_at))::int as ttl,
                token_hash <> $2 as hashed
           from bakery.preview_grants where id = $1`,
        [body.grantId, body.grant],
      );
      assertEquals(row.rows[0].session_seconds, sessionSeconds ?? 3600);
      assertEquals(row.rows[0].ttl, 30);
      assertEquals(row.rows[0].hashed, true);
    }
    const tooShort = await person(
      fixture,
      `/v1/previews/${preview.id}/access`,
      {
        method: "POST",
        body: JSON.stringify({ sessionSeconds: 59 }),
      },
    );
    assertEquals(tooShort.status >= 400 && tooShort.status < 500, true);
    const tooLong = await person(fixture, `/v1/previews/${preview.id}/access`, {
      method: "POST",
      body: JSON.stringify({ sessionSeconds: 86_401 }),
    });
    assertEquals(tooLong.status >= 400 && tooLong.status < 500, true);
    // Exactly one audit row per issued grant, naming the grant id, session
    // length and nothing secret: the one-use secret is never written down.
    const audit = await fixture.pgDatabase.query<
      { resource_id: string; details: Record<string, unknown> }
    >(
      `select resource_id, details from bakery.audit_events
        where organization_id = $1 and operation = 'previews.access'
        order by created_at`,
      [fixture.organizationId],
    );
    assertEquals(audit.rows.length, issued.length);
    for (const grant of issued) {
      const rows = audit.rows.filter((row) =>
        row.details.grantId === grant.grantId
      );
      assertEquals(rows.length, 1, grant.grantId);
      assertEquals(rows[0].resource_id, preview.id);
      assertEquals(rows[0].details.sessionSeconds, grant.sessionSeconds);
      assertEquals(
        JSON.stringify(rows[0].details).includes(grant.secret),
        false,
      );
    }
    // And nowhere else in any audit row either.
    const leaked = await fixture.pgDatabase.query(
      `select count(*)::int as n from bakery.audit_events
        where organization_id = $1 and details::text like '%' || $2 || '%'`,
      [fixture.organizationId, issued[0].secret],
    );
    assertEquals(leaked.rows[0].n, 0);
  }, options));

Deno.test("the preview is read as what it is now, not as what it was registered as", () =>
  withWorkerFixture(async (fixture) => {
    const { preview, assignment, job } = await openPreview(
      fixture,
      "preview-state",
    );
    const read = async () => (await listRun(fixture, job.runId))[0];
    const reset = async () => {
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set status = 'leased', lease_expires_at = now() + interval '5 minutes',
                ended_at = null where id = $1`,
        [assignment.attemptId],
      );
      await fixture.pgDatabase.query(
        `update bakery.jobs set cancel_requested_at = null,
                current_fence = $2::bigint where id = $1`,
        [job.jobId, assignment.fence],
      );
      await fixture.pgDatabase.query(
        "update bakery.previews set expires_at = now() + interval '1 hour' where id = $1",
        [preview.id],
      );
    };
    const expectState = async (
      status: string,
      stopReason: string | null,
    ) => {
      const item = await read();
      assertEquals([item.status, item.stopReason], [status, stopReason]);
      if (status !== "ready") assert(item.stoppedAt !== null);
      const access = await person(
        fixture,
        `/v1/previews/${preview.id}/access`,
        { method: "POST", body: "{}" },
      );
      assertEquals(
        access.status,
        status === "ready" ? 201 : 409,
        `${status}/${stopReason}`,
      );
      await access.body?.cancel();
    };
    await expectState("ready", null);

    await fixture.pgDatabase.query(
      "update bakery.jobs set cancel_requested_at = now() where id = $1",
      [job.jobId],
    );
    await expectState("stopped", "run_cancelled");
    await reset();

    await fixture.pgDatabase.query(
      "update bakery.job_attempts set lease_expires_at = now() - interval '1 minute' where id = $1",
      [assignment.attemptId],
    );
    await expectState("stopped", "machine_lost");
    await reset();

    await fixture.pgDatabase.query(
      "update bakery.job_attempts set status = 'lost' where id = $1",
      [assignment.attemptId],
    );
    await expectState("stopped", "machine_lost");
    await reset();

    await fixture.pgDatabase.query(
      "update bakery.job_attempts set status = 'completed', ended_at = now() where id = $1",
      [assignment.attemptId],
    );
    await expectState("stopped", "run_ended");
    await reset();

    await fixture.pgDatabase.query(
      "update bakery.jobs set current_fence = current_fence + 1 where id = $1",
      [job.jobId],
    );
    await expectState("stopped", "replaced");
    await reset();

    await fixture.pgDatabase.query(
      "update bakery.previews set expires_at = now() - interval '1 second' where id = $1",
      [preview.id],
    );
    await expectState("expired", "time_limit");
    await reset();
    await expectState("ready", null);

    const filtered = await person(fixture, "/v1/previews?status=stopped");
    assertEquals((await filtered.json()).items, []);
  }, options));

Deno.test("a newer attempt's registration replaces the older attempt's preview", () =>
  withWorkerFixture(async (fixture) => {
    const first = await openPreview(fixture, "preview-replace");
    // The first attempt is lost and the job is claimed again by a new attempt.
    await fixture.pgDatabase.query(
      "update bakery.job_attempts set status = 'lost', lease_expires_at = now() - interval '1 minute' where id = $1",
      [first.assignment.attemptId],
    );
    await fixture.pgDatabase.query(
      "update bakery.jobs set current_fence = current_fence + 1, status = 'queued', available_at = now() where id = $1",
      [first.job.jobId],
    );
    const next = await claimAssignment(fixture, first.worker);
    assertEquals(next.jobId, first.job.jobId);
    assertNotEquals(next.attemptId, first.assignment.attemptId);
    // The old attempt can no longer register; the new one can.
    const stale = await register(fixture, first.worker, first.assignment, {
      routeKey: "preview-stale-attempt",
    });
    assertEquals(stale.status >= 400, true);
    const created = await register(fixture, first.worker, next, {
      routeKey: "preview-new-attempt",
    });
    assertEquals(created.status, 201, await created.clone().text());
    const items = await listRun(fixture, first.job.runId);
    assertEquals(items.length, 2);
    const [newest, oldest] = items;
    assertEquals(newest.attemptId, next.attemptId);
    assertEquals([newest.status, newest.stopReason], ["ready", null]);
    assertEquals(oldest.id, first.preview.id);
    assertEquals([oldest.status, oldest.stopReason], ["stopped", "replaced"]);
  }, options));

Deno.test("stopping a preview ends it for everyone and every open session", () =>
  withWorkerFixture(async (fixture) => {
    const { preview, job } = await openPreview(fixture, "preview-stop");
    const granted = await person(fixture, `/v1/previews/${preview.id}/access`, {
      method: "POST",
      body: "{}",
    });
    const grant = await granted.json();
    // A session the grant opened (the exchange is the preview host's).
    const sessionId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.preview_sessions
         (id, organization_id, grant_id, session_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour')`,
      [sessionId, fixture.organizationId, grant.grantId, "h".repeat(64)],
    );
    const key = crypto.randomUUID();
    const stopped = await person(fixture, `/v1/previews/${preview.id}/stop`, {
      method: "POST",
      headers: { "idempotency-key": key },
    });
    assertEquals(stopped.status, 201, await stopped.clone().text());
    const body = await stopped.json() as PreviewBody;
    assertEquals([body.status, body.stopReason], ["stopped", "person"]);
    assertEquals(body.stoppedBy, fixture.principalId);
    assert(body.stoppedAt !== null);
    const revoked = await fixture.pgDatabase.query(
      `select (select revoked_at is not null from bakery.preview_grants where id = $1) as grant,
              (select revoked_at is not null from bakery.preview_sessions where id = $2) as session`,
      [grant.grantId, sessionId],
    );
    assertEquals(revoked.rows[0], { grant: true, session: true });
    // Stopping again changes nothing and still reports the truth.
    const again = await person(fixture, `/v1/previews/${preview.id}/stop`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    const repeated = await again.json() as PreviewBody;
    assertEquals([repeated.status, repeated.stopReason], ["stopped", "person"]);
    assertEquals(repeated.stoppedAt, body.stoppedAt);
    const refused = await person(fixture, `/v1/previews/${preview.id}/access`, {
      method: "POST",
      body: "{}",
    });
    assertEquals(refused.status, 409);
    const items = await listRun(fixture, job.runId);
    assertEquals(items[0].stoppedBy, fixture.principalId);
  }, options));

Deno.test("one person's access can be ended and only by that person", () =>
  withWorkerFixture(async (fixture) => {
    const { preview } = await openPreview(fixture, "preview-revoke");
    const grant = await (await person(
      fixture,
      `/v1/previews/${preview.id}/access`,
      { method: "POST", body: "{}" },
    )).json();
    const colleague = await addDeveloper(fixture);
    try {
      const foreign = await person(
        fixture,
        `/v1/preview-grants/${grant.grantId}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": crypto.randomUUID() },
        },
        colleague,
      );
      assertEquals(foreign.status, 404);
    } finally {
      await colleague.remove();
    }
    const unknown = await person(
      fixture,
      `/v1/preview-grants/${crypto.randomUUID()}`,
      { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } },
    );
    assertEquals(unknown.status, 404);
    const ended = await person(
      fixture,
      `/v1/preview-grants/${grant.grantId}`,
      { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } },
    );
    assertEquals(ended.status, 204);
    const row = await fixture.pgDatabase.query(
      "select revoked_at is not null as revoked from bakery.preview_grants where id = $1",
      [grant.grantId],
    );
    assertEquals(row.rows[0].revoked, true);
    // Ending one person's access leaves the preview running.
    const items = await person(fixture, "/v1/previews");
    assertEquals((await items.json()).items[0].status, "ready");
  }, options));

Deno.test("another organization sees, opens and stops nothing of a preview", () =>
  withWorkerFixture(async (fixture) => {
    const { preview } = await openPreview(fixture, "preview-tenant");
    const other = await createWorkerScope(
      fixture,
      "preview-other-org",
      fixture,
    );
    assertEquals(other.organizationId === fixture.organizationId, false);
    const list = await person(fixture, "/v1/previews", {}, other);
    assertEquals((await list.json()).items, []);
    for (
      const [path, method] of [
        [`/v1/previews/${preview.id}/access`, "POST"],
        [`/v1/previews/${preview.id}/stop`, "POST"],
      ] as const
    ) {
      const response = await person(fixture, path, {
        method,
        body: "{}",
        headers: { "idempotency-key": crypto.randomUUID() },
      }, other);
      assertEquals(response.status, 404, path);
      await response.body?.cancel();
    }
    const still = await listRun(fixture, preview.runId);
    assertEquals(still[0].status, "ready");
  }, options));

Deno.test("an unauthenticated caller reaches no preview operation", () =>
  withWorkerFixture(async (fixture) => {
    const { preview } = await openPreview(fixture, "preview-anon");
    for (
      const [path, method] of [
        ["/v1/previews", "GET"],
        [`/v1/previews/${preview.id}/access`, "POST"],
        [`/v1/previews/${preview.id}/stop`, "POST"],
        ["/v1/preview-availability", "GET"],
      ] as const
    ) {
      const response = await fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}${path}`, {
          method,
          headers: { origin: fixture.config.publicBaseUrl },
          body: method === "POST" ? "{}" : undefined,
        }),
      );
      assertEquals(response.status, 401, path);
      await response.body?.cancel();
    }
  }, options));

Deno.test("previews page by a signed cursor that is bound to its filters", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment, job } = await openPreview(
      fixture,
      "preview-page",
    );
    const second = await register(fixture, worker, assignment, {
      routeKey: "preview-second-app",
    });
    assertEquals(second.status, 201);
    const first = await (await person(
      fixture,
      `/v1/previews?runId=${job.runId}&limit=1`,
    )).json();
    assertEquals(first.items.length, 1);
    assert(typeof first.nextCursor === "string");
    const next = await (await person(
      fixture,
      `/v1/previews?runId=${job.runId}&limit=1&cursor=${first.nextCursor}`,
    )).json();
    assertEquals(next.items.length, 1);
    assertNotEquals(next.items[0].id, first.items[0].id);
    assertEquals(next.nextCursor, null);
    const replayed = await person(
      fixture,
      `/v1/previews?limit=1&cursor=${first.nextCursor}`,
    );
    assertEquals(replayed.status, 400);
    const forged = await person(fixture, "/v1/previews?cursor=not-a-cursor");
    assertEquals(forged.status, 400);
  }, options));

Deno.test("availability reports whether the deployment has a preview origin", async () => {
  await withWorkerFixture(async (fixture) => {
    const response = await person(fixture, "/v1/preview-availability");
    assertEquals(await response.json(), { available: true });
  }, options);
  await withWorkerFixture(async (fixture) => {
    const response = await person(fixture, "/v1/preview-availability");
    assertEquals(await response.json(), { available: false });
    const { preview } = await openPreview(fixture, "preview-unset");
    const access = await person(fixture, `/v1/previews/${preview.id}/access`, {
      method: "POST",
      body: "{}",
    });
    assertEquals(access.status, 409);
    assertEquals(
      (await access.text()).includes("preview_origin_not_configured"),
      true,
    );
  });
});
