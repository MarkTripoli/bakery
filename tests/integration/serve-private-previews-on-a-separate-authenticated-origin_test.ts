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
  stoppedByName: string | null;
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
      // Each preview has its own origin: its route key under the preview host.
      assertEquals(
        body.exchangeUrl,
        "http://preview-0123456789.localhost:8789/_bakery/preview/exchange",
      );
      assertEquals(
        body.previewUrl,
        "http://preview-0123456789.localhost:8789/",
      );
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
    // The name is the stopper's display name as the organization has it now.
    const named = await fixture.pgDatabase.query<{ display_name: string }>(
      "select display_name from bakery.principals where id = $1",
      [fixture.principalId],
    );
    assertEquals(body.stoppedByName, named.rows[0].display_name);
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

// ---------------------------------------------------------------------------
// A2: the preview's own origin, the one-use exchange and the proxy.
// ---------------------------------------------------------------------------

type Seen = {
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

/** A stand-in for the app a worker runs: a real server on a local port. */
function startApp(
  respond: (request: Request, seen: Seen[]) => Response | Promise<Response>,
) {
  const seen: Seen[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body: await request.clone().text(),
    });
    return await respond(request, seen);
  });
  return {
    port: (server.addr as Deno.NetAddr).port,
    seen,
    close: () => server.shutdown(),
  };
}

const ROUTE = "preview-0123456789";
const previewHost = `${ROUTE}.localhost:8789`;

function atPreview(
  fixture: WorkerFixture,
  path: string,
  init: RequestInit = {},
  host = previewHost,
) {
  return fixture.app.fetch(
    new Request(`http://${host}${path}`, init),
  );
}

/** What the person's browser does: grant from the app, posted to the preview. */
async function openOrigin(
  fixture: WorkerFixture,
  previewId: string,
  sessionSeconds?: number,
) {
  const granted = await person(fixture, `/v1/previews/${previewId}/access`, {
    method: "POST",
    body: JSON.stringify(sessionSeconds ? { sessionSeconds } : {}),
  });
  assertEquals(granted.status, 201, await granted.clone().text());
  const grant = await granted.json();
  const exchanged = await fixture.app.fetch(
    new Request(grant.exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: fixture.config.publicBaseUrl,
      },
      body: new URLSearchParams({ grant: grant.grant }).toString(),
    }),
  );
  const setCookie = exchanged.headers.get("set-cookie") ?? "";
  await exchanged.body?.cancel();
  return {
    grant,
    exchanged,
    setCookie,
    cookie: setCookie.split(";", 1)[0],
  };
}

async function registerAt(
  fixture: WorkerFixture,
  name: string,
  port: number,
) {
  const live = await liveAttempt(fixture, name);
  const registered = await register(fixture, live.worker, live.assignment, {
    upstreamPort: port,
  });
  assertEquals(registered.status, 201, await registered.clone().text());
  return { ...live, preview: await registered.json() as PreviewBody };
}

Deno.test("a grant posted to the preview's own origin opens a session that proxies to the registered app", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp((request) => {
      const url = new URL(request.url);
      return new Response(`app:${request.method}:${url.pathname}`, {
        headers: { "content-type": "text/plain" },
      });
    });
    try {
      const { preview } = await registerAt(fixture, "host-open", app.port);
      const opened = await openOrigin(fixture, preview.id);
      assertEquals(opened.exchanged.status, 303);
      assertEquals(opened.exchanged.headers.get("location"), "/");
      const cookie = opened.setCookie;
      assert(cookie.startsWith("bakery_running_preview="), cookie);
      assert(cookie.includes("HttpOnly"));
      assert(cookie.includes("SameSite=Lax"));
      assert(cookie.includes("Path=/"));
      assert(cookie.includes("Max-Age=3600"));
      assertEquals(cookie.toLowerCase().includes("domain="), false);
      assertEquals(opened.exchanged.headers.get("cache-control"), "no-store");
      const view = await atPreview(fixture, "/hello?x=1", {
        headers: { cookie: opened.cookie },
      });
      assertEquals(view.status, 200);
      assertEquals(await view.text(), "app:GET:/hello");
      assertEquals(view.headers.get("referrer-policy"), "no-referrer");
      assertEquals(view.headers.get("x-content-type-options"), "nosniff");
      assertEquals(app.seen.length, 1);
      assertEquals(app.seen[0].path, "/hello?x=1");
      // The app sees none of Bakery's: no preview cookie, no forwarding hints.
      assertEquals(app.seen[0].headers.get("cookie"), null);
      assertEquals(
        app.seen[0].headers.get("host"),
        `127.0.0.1:${app.port}`,
      );
      // A POST body reaches the app too.
      const post = await atPreview(fixture, "/save", {
        method: "POST",
        headers: { cookie: opened.cookie, "content-type": "text/plain" },
        body: "payload",
      });
      assertEquals(await post.text(), "app:POST:/save");
      assertEquals(app.seen[1].body, "payload");
    } finally {
      await app.close();
    }
  }, options));

Deno.test("the session lasts the length that was asked for, separate from the grant", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    try {
      const { preview } = await registerAt(fixture, "host-session", app.port);
      const opened = await openOrigin(fixture, preview.id, 120);
      assert(opened.setCookie.includes("Max-Age=120"), opened.setCookie);
      const row = await fixture.pgDatabase.query(
        `select extract(epoch from (s.expires_at - s.created_at))::int as ttl
           from bakery.preview_sessions s where s.grant_id = $1`,
        [opened.grant.grantId],
      );
      assertEquals(row.rows[0].ttl, 120);
      // An expired session no longer reaches the app.
      await fixture.pgDatabase.query(
        "update bakery.preview_sessions set expires_at = now() - interval '1 second' where grant_id = $1",
        [opened.grant.grantId],
      );
      const view = await atPreview(fixture, "/", {
        headers: { cookie: opened.cookie },
      });
      assertEquals(view.status, 404);
      assertEquals(app.seen.length, 0);
    } finally {
      await app.close();
    }
  }, options));

Deno.test("a grant is consumed once and an expired, foreign or mis-posted grant opens nothing", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    try {
      const { preview } = await registerAt(fixture, "host-grant", app.port);
      const grantFor = async () =>
        await (await person(fixture, `/v1/previews/${preview.id}/access`, {
          method: "POST",
          body: "{}",
        })).json();
      const post = (
        grant: string,
        init: { host?: string; origin?: string | null; path?: string } = {},
      ) => {
        const headers = new Headers({
          "content-type": "application/x-www-form-urlencoded",
        });
        if (init.origin !== null) {
          headers.set("origin", init.origin ?? fixture.config.publicBaseUrl);
        }
        return atPreview(
          fixture,
          init.path ?? "/_bakery/preview/exchange",
          {
            method: "POST",
            headers,
            body: new URLSearchParams({ grant }).toString(),
          },
          init.host,
        );
      };
      const first = await grantFor();
      assertEquals((await post(first.grant)).status, 303);
      const replay = await post(first.grant);
      assertEquals(replay.status, 404);
      assertEquals(replay.headers.get("set-cookie"), null);
      const sessions = await fixture.pgDatabase.query(
        "select count(*)::int as n from bakery.preview_sessions where grant_id = $1",
        [first.grantId],
      );
      assertEquals(sessions.rows[0].n, 1);

      const expired = await grantFor();
      await fixture.pgDatabase.query(
        "update bakery.preview_grants set expires_at = now() - interval '1 second' where id = $1",
        [expired.grantId],
      );
      assertEquals((await post(expired.grant)).status, 404);

      // A grant for this preview posted to another preview's origin is
      // refused and stays unspent.
      const spare = await grantFor();
      const wrongHost = await post(spare.grant, {
        host: "preview-other-key1.localhost:8789",
      });
      assertEquals(wrongHost.status, 404);
      const unspent = await fixture.pgDatabase.query(
        "select consumed_at is null as unspent from bakery.preview_grants where id = $1",
        [spare.grantId],
      );
      assertEquals(unspent.rows[0].unspent, true);
      // Only the Bakery page may post it; other origins and no origin do not.
      assertEquals(
        (await post(spare.grant, { origin: "http://evil.example" })).status,
        404,
      );
      assertEquals((await post(spare.grant, { origin: "null" })).status, 404);
      assertEquals((await post(spare.grant, { origin: null })).status, 404);
      // Never in a URL, never as JSON.
      const inUrl = await atPreview(
        fixture,
        `/_bakery/preview/exchange?grant=${spare.grant}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: fixture.config.publicBaseUrl,
          },
          body: new URLSearchParams({ grant: spare.grant }).toString(),
        },
      );
      assertEquals(inUrl.status, 404);
      const json = await atPreview(fixture, "/_bakery/preview/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.config.publicBaseUrl,
        },
        body: JSON.stringify({ grant: spare.grant }),
      });
      assertEquals(json.status, 404);
      const stillUnspent = await fixture.pgDatabase.query(
        "select consumed_at is null as unspent from bakery.preview_grants where id = $1",
        [spare.grantId],
      );
      assertEquals(stillUnspent.rows[0].unspent, true);
      // And the exchange does not exist on the application host.
      const onApp = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/_bakery/preview/exchange`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: fixture.config.publicBaseUrl,
            },
            body: new URLSearchParams({ grant: spare.grant }).toString(),
          },
        ),
      );
      assertEquals(onApp.status >= 400, true);
      assertEquals(app.seen.length, 0);
    } finally {
      await app.close();
    }
  }, options));

Deno.test("every refusal shows the same page, whatever the reason", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("secret app"));
    try {
      const { preview, assignment, job } = await registerAt(
        fixture,
        "host-refusals",
        app.port,
      );
      const bodies = new Map<string, string>();
      const refuse = async (label: string, response: Response) => {
        assertEquals(response.status, 404, label);
        bodies.set(label, await response.text());
      };
      const opened = await openOrigin(fixture, preview.id);
      const view = (cookie?: string, host = previewHost, path = "/") =>
        atPreview(
          fixture,
          path,
          { headers: cookie ? { cookie } : {} },
          host,
        );
      assertEquals((await view(opened.cookie)).status, 200);

      await refuse("no cookie", await view());
      await refuse(
        "garbage cookie",
        await view("bakery_running_preview=" + "x".repeat(43)),
      );
      await refuse("malformed cookie", await view("bakery_running_preview=a"));
      await refuse(
        "unknown label",
        await view(opened.cookie, "preview-nothing-here.localhost:8789"),
      );
      await refuse(
        "invalid label",
        await view(opened.cookie, "Bad_Label.localhost:8789"),
      );
      await refuse(
        "nested label",
        await view(opened.cookie, `a.${previewHost}`),
      );
      await refuse(
        "reserved path",
        await view(opened.cookie, previewHost, "/_bakery/preview/anything"),
      );
      await refuse(
        "exchange by GET",
        await view(opened.cookie, previewHost, "/_bakery/preview/exchange"),
      );
      await refuse(
        "websocket upgrade",
        await atPreview(fixture, "/", {
          headers: { cookie: opened.cookie, upgrade: "websocket" },
        }),
      );

      // Time limit, lost machine, cancelled run, stopped, revoked access.
      const state = async (label: string, sql: string, args: unknown[]) => {
        await fixture.pgDatabase.query(sql, args);
        await refuse(label, await view(opened.cookie));
      };
      await state(
        "time limit",
        "update bakery.previews set expires_at = now() - interval '1 second' where id = $1",
        [preview.id],
      );
      await fixture.pgDatabase.query(
        "update bakery.previews set expires_at = now() + interval '1 hour' where id = $1",
        [preview.id],
      );
      assertEquals((await view(opened.cookie)).status, 200);
      await state(
        "machine lost",
        "update bakery.job_attempts set lease_expires_at = now() - interval '1 minute' where id = $1",
        [assignment.attemptId],
      );
      await fixture.pgDatabase.query(
        "update bakery.job_attempts set lease_expires_at = now() + interval '5 minutes' where id = $1",
        [assignment.attemptId],
      );
      assertEquals((await view(opened.cookie)).status, 200);
      await state(
        "run cancelled",
        "update bakery.jobs set cancel_requested_at = now() where id = $1",
        [job.jobId],
      );
      await fixture.pgDatabase.query(
        "update bakery.jobs set cancel_requested_at = null where id = $1",
        [job.jobId],
      );
      assertEquals((await view(opened.cookie)).status, 200);

      const ended = await person(
        fixture,
        `/v1/preview-grants/${opened.grant.grantId}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      );
      assertEquals(ended.status, 204);
      await refuse("access revoked", await view(opened.cookie));

      const again = await openOrigin(fixture, preview.id);
      assertEquals((await view(again.cookie)).status, 200);
      const stopped = await person(fixture, `/v1/previews/${preview.id}/stop`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      assertEquals(stopped.status, 201);
      await refuse("stopped", await view(again.cookie));

      const distinct = new Set(bodies.values());
      assertEquals(distinct.size, 1, JSON.stringify([...bodies.keys()]));
      const html = [...distinct][0];
      assert(html.includes("This preview has ended"));
      // The page is a card on a grey page, in light and dark, with the button's
      // name in bold, and its one stylesheet fetches nothing.
      assert(html.includes("<main>") && html.includes("</main>"));
      assert(html.includes("<strong>Open preview</strong>"));
      assert(html.includes("color-scheme:light dark"));
      assert(html.includes("prefers-color-scheme:dark"));
      for (const fetches of ["url(", "@import", "@font-face", "<link"]) {
        assertEquals(html.includes(fetches), false, fetches);
      }
      assert(html.includes("Bakery preview"));
      // No script, no outbound link or resource, no id, no route key, no port.
      for (
        const forbidden of [
          "<script",
          "<a ",
          "href",
          "src=",
          "http",
          ROUTE,
          preview.id,
          String(app.port),
          "secret app",
        ]
      ) {
        assertEquals(html.includes(forbidden), false, forbidden);
      }
      // The app was only ever reached while the preview was running.
      assertEquals(app.seen.every((item) => item.path === "/"), true);
    } finally {
      await app.close();
    }
  }, options));

Deno.test("nothing in a request chooses the upstream host, port or path off the origin", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    const other = startApp(() => new Response("wrong app"));
    try {
      const { preview } = await registerAt(fixture, "host-ssrf", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const headers = {
        cookie: opened.cookie,
        "x-forwarded-host": "169.254.169.254",
        "x-forwarded-for": "10.0.0.1",
        "x-forwarded-port": String(other.port),
        forwarded: `host=169.254.169.254:${other.port}`,
        "x-real-ip": "10.0.0.1",
        "accept-encoding": "br",
      };
      for (
        const path of [
          `/?host=169.254.169.254&port=${other.port}`,
          `//169.254.169.254/latest/meta-data`,
          `//127.0.0.1:${other.port}/x`,
          `/..%2f..%2fetc/passwd`,
          `/%2e%2e/%2e%2e/x`,
          `/\\169.254.169.254/x`,
        ]
      ) {
        const response = await atPreview(fixture, path, { headers });
        await response.body?.cancel();
        assertEquals(response.status, 200, path);
      }
      assertEquals(other.seen.length, 0);
      assertEquals(app.seen.length, 6);
      for (const item of app.seen) {
        assertEquals(item.headers.get("host"), `127.0.0.1:${app.port}`);
        for (
          const name of [
            "x-forwarded-host",
            "x-forwarded-for",
            "x-forwarded-port",
            "forwarded",
            "x-real-ip",
            "cookie",
          ]
        ) assertEquals(item.headers.get(name), null, name);
        assertEquals(item.headers.get("accept-encoding"), "identity");
      }
      // A request that names another host is a different (unregistered) origin.
      const foreign = await atPreview(fixture, "/", {
        headers: { cookie: opened.cookie },
      }, `127.0.0.1:${other.port}`);
      assertNotEquals(foreign.status, 200);
      await foreign.body?.cancel();
      assertEquals(other.seen.length, 0);
    } finally {
      await app.close();
      await other.close();
    }
  }, options));

Deno.test("a redirect is never followed and may only lead back into the same origin", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp((request) => {
      const path = new URL(request.url).pathname;
      const to = (location: string) =>
        new Response(null, { status: 302, headers: { location } });
      if (path === "/self") {
        return to(`http://127.0.0.1:${app.port}/landed?a=1#h`);
      }
      if (path === "/relative") return to("/relative-target");
      if (path === "/other-port") return to("http://127.0.0.1:9/x");
      if (path === "/metadata") return to("http://169.254.169.254/latest");
      if (path === "/scheme") return to("https://evil.example/");
      if (path === "/landed") return new Response("landed");
      return new Response("ok");
    });
    try {
      const { preview } = await registerAt(fixture, "host-redirect", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const get = (path: string) =>
        atPreview(fixture, path, {
          headers: { cookie: opened.cookie },
          redirect: "manual",
        });
      const self = await get("/self");
      assertEquals(self.status, 302);
      assertEquals(self.headers.get("location"), "/landed?a=1#h");
      const relative = await get("/relative");
      assertEquals(relative.headers.get("location"), "/relative-target");
      await self.body?.cancel();
      await relative.body?.cancel();
      for (const path of ["/other-port", "/metadata", "/scheme"]) {
        const refused = await get(path);
        assertEquals(refused.status, 502, path);
        assertEquals(refused.headers.get("location"), null, path);
        const body = await refused.text();
        assert(body.includes("The app is not answering"));
        assertEquals(body.includes("169.254"), false);
        assertEquals(body.includes("evil.example"), false);
      }
      // The server never followed any of them.
      assertEquals(
        app.seen.map((item) => item.path),
        ["/self", "/relative", "/other-port", "/metadata", "/scheme"],
      );
    } finally {
      await app.close();
    }
  }, options));

Deno.test("an app's cookie stays on its own origin and cannot reach sibling previews", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp((request) => {
      if (new URL(request.url).pathname === "/login") {
        const headers = new Headers();
        headers.append("set-cookie", "mine=1; Path=/; HttpOnly");
        headers.append("set-cookie", "toss=1; Domain=localhost; Path=/");
        // The same attribute spelled the ways a browser still reads as Domain.
        headers.append("set-cookie", "toss2=1; Domain =localhost; Path=/");
        headers.append("set-cookie", "toss3=1; DOMAIN\t=localhost; Path=/");
        headers.append("set-cookie", "toss4=1;  domain= localhost");
        headers.append("set-cookie", "toss5=1; Domain");
        headers.append(
          "set-cookie",
          "bakery_running_preview=evil; Domain=localhost; Path=/",
        );
        return new Response("ok", { headers });
      }
      return new Response("ok");
    });
    try {
      const { preview } = await registerAt(fixture, "host-cookies", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const login = await atPreview(fixture, "/login", {
        headers: { cookie: opened.cookie },
      });
      await login.body?.cancel();
      const cookies = login.headers.getSetCookie();
      assertEquals(cookies, ["mine=1; Path=/; HttpOnly"]);
      // The app's own cookie reaches it; the preview's session cookie does not.
      const next = await atPreview(fixture, "/next", {
        headers: { cookie: `${opened.cookie}; mine=1` },
      });
      await next.body?.cancel();
      assertEquals(app.seen.at(-1)?.headers.get("cookie"), "mine=1");
    } finally {
      await app.close();
    }
  }, options));

Deno.test("a silent app reads as not answering, never as the refusal and never with its address", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    const { preview } = await registerAt(fixture, "host-silent", app.port);
    const opened = await openOrigin(fixture, preview.id);
    await app.close();
    const view = await atPreview(fixture, "/", {
      headers: { cookie: opened.cookie },
    });
    assertEquals(view.status, 502);
    const body = await view.text();
    assert(body.includes("The app is not answering"));
    assertEquals(body.includes(String(app.port)), false);
    assertEquals(body.includes("127.0.0.1"), false);
  }, options));

Deno.test("a grantor who is no longer an active developer cannot keep using the preview", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    const colleague = await addDeveloper(fixture);
    try {
      const { preview } = await registerAt(fixture, "host-member", app.port);
      // The colleague opens it through their own session.
      const granted = await person(
        fixture,
        `/v1/previews/${preview.id}/access`,
        { method: "POST", body: "{}" },
        colleague,
      );
      assertEquals(granted.status, 201, await granted.clone().text());
      const grant = await granted.json();
      const exchanged = await fixture.app.fetch(
        new Request(grant.exchangeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: fixture.config.publicBaseUrl,
          },
          body: new URLSearchParams({ grant: grant.grant }).toString(),
        }),
      );
      const cookie =
        (exchanged.headers.get("set-cookie") ?? "").split(";", 1)[0];
      const ok = await atPreview(fixture, "/", { headers: { cookie } });
      assertEquals(ok.status, 200);
      await ok.body?.cancel();
      await fixture.pgDatabase.query(
        "update bakery.organization_memberships set status = 'inactive' where principal_id = $1",
        [colleague.principalId],
      );
      const refused = await atPreview(fixture, "/", { headers: { cookie } });
      assertEquals(refused.status, 404);
      assertEquals(app.seen.length, 1);
    } finally {
      await colleague.remove();
      await app.close();
    }
  }, options));

Deno.test("a revoked grant ends its session even if the session row was not touched", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    try {
      const { preview } = await registerAt(
        fixture,
        "host-grant-revoked",
        app.port,
      );
      const opened = await openOrigin(fixture, preview.id);
      const before = await atPreview(fixture, "/", {
        headers: { cookie: opened.cookie },
      });
      assertEquals(before.status, 200);
      await before.body?.cancel();
      await fixture.pgDatabase.query(
        "update bakery.preview_grants set revoked_at = now() where id = $1",
        [opened.grant.grantId],
      );
      const after = await atPreview(fixture, "/", {
        headers: { cookie: opened.cookie },
      });
      assertEquals(after.status, 404);
      assertEquals(app.seen.length, 1);
    } finally {
      await app.close();
    }
  }, options));

Deno.test("the grantor is re-authorized on every use: a demoted grantor cannot exchange a grant or keep a session", () =>
  withWorkerFixture(async (fixture) => {
    const app = startApp(() => new Response("ok"));
    const colleague = await addDeveloper(fixture);
    try {
      const { preview } = await registerAt(fixture, "host-reauth", app.port);
      const issue = async () => {
        const granted = await person(
          fixture,
          `/v1/previews/${preview.id}/access`,
          { method: "POST", body: "{}" },
          colleague,
        );
        assertEquals(granted.status, 201, await granted.clone().text());
        return await granted.json();
      };
      const exchange = (grant: { exchangeUrl: string; grant: string }) =>
        fixture.app.fetch(
          new Request(grant.exchangeUrl, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: fixture.config.publicBaseUrl,
            },
            body: new URLSearchParams({ grant: grant.grant }).toString(),
          }),
        );
      const setRole = (role: string) =>
        fixture.pgDatabase.query(
          "update bakery.organization_memberships set role = $2 where principal_id = $1",
          [colleague.principalId, role],
        );

      // A live session of a developer works...
      const first = await issue();
      const opened = await exchange(first);
      assertEquals(opened.status, 303);
      const cookie = (opened.headers.get("set-cookie") ?? "").split(";", 1)[0];
      const ok = await atPreview(fixture, "/", { headers: { cookie } });
      assertEquals(ok.status, 200);
      await ok.body?.cancel();

      // ...and stops the moment the grantor is only a viewer, with no revoke.
      await setRole("viewer");
      const demoted = await atPreview(fixture, "/", { headers: { cookie } });
      assertEquals(demoted.status, 404);
      assertEquals(app.seen.length, 1);

      // A grant issued while a developer is not spendable once demoted, and it
      // stays unspent, so it is refused for the right reason.
      await setRole("developer");
      const second = await issue();
      await setRole("viewer");
      const refused = await exchange(second);
      assertEquals(refused.status, 404);
      assertEquals(refused.headers.get("set-cookie"), null);
      const unspent = await fixture.pgDatabase.query(
        "select consumed_at is null as unspent from bakery.preview_grants where id = $1",
        [second.grantId],
      );
      assertEquals(unspent.rows[0].unspent, true);

      // Restoring the role restores nothing already refused for good, and a
      // disabled principal is refused too.
      await setRole("developer");
      const third = await issue();
      await fixture.pgDatabase.query(
        "update bakery.principals set disabled_at = now() where id = $1",
        [colleague.principalId],
      );
      assertEquals((await exchange(third)).status, 404);
      await fixture.pgDatabase.query(
        "update bakery.principals set disabled_at = null where id = $1",
        [colleague.principalId],
      );
      assertEquals(app.seen.length, 1);
    } finally {
      await colleague.remove();
      await app.close();
    }
  }, options));

Deno.test("a registration and a person's stop tell the run's task, once each, and nothing else does", () =>
  withWorkerFixture(async (fixture) => {
    const events = async () =>
      (await fixture.pgDatabase.query<
        {
          event_type: string;
          task_id: string | null;
          aggregate_id: string;
          payload: { resourceId: string; resourceVersion: number };
        }
      >(
        `select event_type, task_id, aggregate_id, payload
           from bakery.domain_events
          where organization_id = $1 and event_type like 'preview.%'
          order by organization_sequence`,
        [fixture.organizationId],
      )).rows;
    const { worker, assignment, job, preview } = await openPreview(
      fixture,
      "preview-events",
    );
    // The same registration replays, and a refused one registers nothing:
    // neither tells anyone.
    assertEquals((await register(fixture, worker, assignment)).status, 200);
    assertEquals(
      (await register(fixture, worker, assignment, { upstreamPort: 5174 }))
        .status,
      409,
    );
    const ready = await events();
    assertEquals(ready.length, 1);
    assertEquals(ready[0].event_type, "preview.ready");
    assertEquals(ready[0].task_id, job.taskId);
    assertEquals(ready[0].aggregate_id, preview.id);
    assertEquals(ready[0].payload.resourceId, preview.id);
    // The event names the preview and nothing of it.
    assertEquals(Object.keys(ready[0].payload).sort(), [
      "resourceId",
      "resourceVersion",
    ]);

    // A person's stop tells the task; stopping again, and a preview that ends by
    // itself, do not.
    const stop = () =>
      person(fixture, `/v1/previews/${preview.id}/stop`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
    assertEquals((await stop()).status, 201);
    assertEquals((await stop()).status, 201);
    await fixture.pgDatabase.query(
      "update bakery.jobs set cancel_requested_at = now() where id = $1",
      [job.jobId],
    );
    const all = await events();
    assertEquals(all.map((event) => event.event_type), [
      "preview.ready",
      "preview.stopped",
    ]);
    assertEquals(all[1].task_id, job.taskId);
    assertEquals(all[1].aggregate_id, preview.id);
    assert(all[1].payload.resourceVersion > all[0].payload.resourceVersion);
  }, options));

// ---- WebSocket through the preview's own origin ----------------------------

/** A free port, so the preview origin can name the port a real listener has. */
function freePort(): number {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

type SocketApp = {
  readonly port: number;
  readonly seen: { path: string; headers: Headers }[];
  readonly sockets: WebSocket[];
  close(): Promise<void>;
};

/** A stand-in app whose sockets echo, and say what they were asked with. */
function startSocketApp(protocol?: string): SocketApp {
  const seen: SocketApp["seen"] = [];
  const sockets: WebSocket[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (
    request,
  ) => {
    const url = new URL(request.url);
    // Read before the upgrade: the request is closed once it is answered.
    seen.push({
      path: `${url.pathname}${url.search}`,
      headers: new Headers(request.headers),
    });
    const { socket, response } = Deno.upgradeWebSocket(request, { protocol });
    sockets.push(socket);
    socket.onmessage = (event) => socket.send(event.data);
    return response;
  });
  return {
    port: (server.addr as Deno.NetAddr).port,
    seen,
    sockets,
    close: () => server.shutdown(),
  };
}

/** The open socket, or null when the handshake was refused or failed. */
function connect(
  url: string,
  headers: Record<string, string>,
  protocols: string[] = [],
): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      url,
      { protocols, headers } as unknown as string[],
    );
    socket.onopen = () => resolve(socket);
    socket.onerror = () => resolve(null);
    socket.onclose = () => resolve(null);
  });
}

function nextMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  socket.binaryType = "arraybuffer";
  return new Promise((resolve) => {
    socket.onmessage = (event) => resolve(event.data);
  });
}

function closedWith(socket: WebSocket, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
  });
}

/** Runs a fixture whose preview origin is a real, listening port. */
function withSocketFixture(
  run: (
    fixture: WorkerFixture,
    wsUrl: (path?: string) => string,
    origin: string,
  ) => Promise<void>,
) {
  const port = freePort();
  const previewOriginHere = `http://localhost:${port}`;
  return withWorkerFixture(async (fixture) => {
    const front = Deno.serve({
      hostname: "127.0.0.1",
      port,
      onListen() {},
    }, (request) => fixture.app.fetch(request));
    try {
      await run(
        fixture,
        (path = "/") => `ws://${ROUTE}.localhost:${port}${path}`,
        `http://${ROUTE}.localhost:${port}`,
      );
    } finally {
      await front.shutdown();
    }
  }, { env: { BAKERY_ARTIFACT_PREVIEW_ORIGIN: previewOriginHere } });
}

Deno.test("a socket opens on the preview's own origin, reaches the registered app and carries messages both ways", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const app = startSocketApp("vite-hmr");
    try {
      const { preview } = await registerAt(fixture, "sock-open", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const socket = await connect(
        wsUrl("/hmr?token=1"),
        { cookie: `${opened.cookie}; theme=dark`, origin },
        ["other", "vite-hmr"],
      );
      assert(socket !== null, "the socket did not open");
      // The browser is told the protocol the app chose.
      assertEquals(socket.protocol, "vite-hmr");
      assertEquals(app.seen.length, 1);
      assertEquals(app.seen[0].path, "/hmr?token=1");
      // The app sees its own cookie only, and the port it is registered on.
      assertEquals(app.seen[0].headers.get("cookie"), "theme=dark");
      assertEquals(
        app.seen[0].headers.get("host"),
        `127.0.0.1:${app.port}`,
      );
      const text = nextMessage(socket);
      socket.send("ping");
      assertEquals(await text, "ping");
      const binary = nextMessage(socket);
      socket.send(new Uint8Array([1, 2, 3]));
      assertEquals(
        [...new Uint8Array(await binary as ArrayBuffer)],
        [1, 2, 3],
      );
      // Either side closing ends the other, with the same code.
      const closed = closedWith(socket, 3000);
      app.sockets[0].close(4001, "bye");
      assertEquals(await closed, 4001);
    } finally {
      await app.close();
    }
  }));

Deno.test("an app that greets on open reaches the browser, in order", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const greetings = ["hello-1", "hello-2"];
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const { socket, response } = Deno.upgradeWebSocket(request);
        socket.onopen = () => {
          for (const frame of greetings) socket.send(frame);
        };
        socket.onmessage = (event) => socket.send(event.data);
        return response;
      },
    );
    try {
      const { preview } = await registerAt(
        fixture,
        "sock-greet",
        (server.addr as Deno.NetAddr).port,
      );
      const opened = await openOrigin(fixture, preview.id);
      const socket = new WebSocket(
        wsUrl(),
        { headers: { cookie: opened.cookie, origin } } as unknown as string[],
      );
      const got: string[] = [];
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4000);
        socket.onmessage = (event) => {
          got.push(event.data);
          if (got.length === 3) {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      await new Promise((resolve) => {
        socket.onopen = resolve;
      });
      socket.send("client-1");
      await done;
      assertEquals(got, ["hello-1", "hello-2", "client-1"]);
      socket.close();
    } finally {
      await server.shutdown();
    }
  }));

Deno.test("a socket is refused without the session, from another origin, or when it is not a plain upgrade", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const app = startSocketApp();
    try {
      const { preview } = await registerAt(fixture, "sock-refuse", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const refuse = async (
        label: string,
        headers: Record<string, string>,
        url = wsUrl(),
      ) => assertEquals(await connect(url, headers), null, label);
      await refuse("no session", { origin });
      await refuse("a wrong session", {
        cookie: "bakery_running_preview=" + "z".repeat(43),
        origin,
      });
      await refuse("no origin", { cookie: opened.cookie });
      await refuse("the application's origin", {
        cookie: opened.cookie,
        origin: fixture.config.publicBaseUrl,
      });
      await refuse("a stranger's origin", {
        cookie: opened.cookie,
        origin: "https://evil.example",
      });
      await refuse(
        "the reserved path",
        { cookie: opened.cookie, origin },
        wsUrl("/_bakery/preview/x"),
      );
      await refuse("another preview's name", {
        cookie: opened.cookie,
        origin: origin.replace(ROUTE, "preview-9999999999"),
      }, wsUrl().replace(ROUTE, "preview-9999999999"));
      // Nothing reached the app for any of them.
      assertEquals(app.seen.length, 0);
    } finally {
      await app.close();
    }
  }));

Deno.test("a silent app reads as not answering and opens no socket", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const gone = startSocketApp();
    const port = gone.port;
    await gone.close();
    const { preview } = await registerAt(fixture, "sock-silent", port);
    const opened = await openOrigin(fixture, preview.id);
    assertEquals(
      await connect(wsUrl(), { cookie: opened.cookie, origin }),
      null,
    );
  }));

Deno.test("a stopped preview closes its open sockets", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const app = startSocketApp();
    try {
      const { preview } = await registerAt(fixture, "sock-stop", app.port);
      const opened = await openOrigin(fixture, preview.id);
      const socket = await connect(wsUrl(), { cookie: opened.cookie, origin });
      assert(socket !== null);
      const closed = closedWith(socket, 15_000);
      const stopped = await person(fixture, `/v1/previews/${preview.id}/stop`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      assertEquals(stopped.status, 201, await stopped.clone().text());
      // Closed for a rule (policy), within a few seconds.
      assertEquals(await closed, 1008);
      // The app's side of the pair is closed too.
      for (
        let waited = 0;
        app.sockets[0].readyState < WebSocket.CLOSING && waited < 2000;
        waited += 50
      ) await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(app.sockets[0].readyState >= WebSocket.CLOSING, true);
    } finally {
      await app.close();
    }
  }));

Deno.test("a grantor who loses the role ends their open sockets", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const app = startSocketApp();
    const colleague = await addDeveloper(fixture);
    try {
      const { preview } = await registerAt(fixture, "sock-role", app.port);
      const granted = await person(
        fixture,
        `/v1/previews/${preview.id}/access`,
        { method: "POST", body: "{}" },
        colleague,
      );
      const grant = await granted.json();
      const exchanged = await fixture.app.fetch(
        new Request(grant.exchangeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: fixture.config.publicBaseUrl,
          },
          body: new URLSearchParams({ grant: grant.grant }).toString(),
        }),
      );
      const cookie =
        (exchanged.headers.get("set-cookie") ?? "").split(";", 1)[0];
      const socket = await connect(wsUrl(), { cookie, origin });
      assert(socket !== null);
      const closed = closedWith(socket, 15_000);
      await fixture.pgDatabase.query(
        "update bakery.organization_memberships set status = 'inactive' where principal_id = $1",
        [colleague.principalId],
      );
      assertEquals(await closed, 1008);
    } finally {
      await colleague.remove();
      await app.close();
    }
  }));

Deno.test("one preview holds a bounded number of sockets", () =>
  withSocketFixture(async (fixture, wsUrl, origin) => {
    const app = startSocketApp();
    const open: WebSocket[] = [];
    try {
      const { preview } = await registerAt(fixture, "sock-cap", app.port);
      const opened = await openOrigin(fixture, preview.id);
      for (let count = 0; count < 32; count++) {
        const socket = await connect(wsUrl(), {
          cookie: opened.cookie,
          origin,
        });
        assert(socket !== null, `socket ${count + 1} should open`);
        open.push(socket);
      }
      assertEquals(
        await connect(wsUrl(), { cookie: opened.cookie, origin }),
        null,
      );
      // Closing one frees a place.
      const closed = closedWith(open[0], 3000);
      open[0].close();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = await connect(wsUrl(), { cookie: opened.cookie, origin });
      assert(again !== null);
      open.push(again);
    } finally {
      for (const socket of open) socket.close();
      await app.close();
    }
  }));
