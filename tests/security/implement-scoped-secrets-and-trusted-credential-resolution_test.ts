import { assert, assertEquals, assertRejects } from "@std/assert";
import { openSecretsFixture } from "../helpers/secrets.ts";

Deno.test("denied scope key provider canary and changed live authority fail closed without facts", async () => {
  const f = await openSecretsFixture();
  try {
    const value = crypto.randomUUID();
    const input = {
      applicationId: f.applicationId,
      name: "Safe credential",
      provider: "github",
      value,
    };
    const noScope = await f.request("/v1/secrets", {
      ...input,
      applicationId: f.foreignApplication,
    });
    assertEquals(noScope.status, 404);
    await noScope.arrayBuffer();
    assertEquals(f.calls(), 0);
    const missing = await f.request("/v1/secrets", {
      ...input,
      applicationId: undefined,
    });
    assertEquals(missing.status, 400);
    await missing.arrayBuffer();
    assertEquals(f.calls(), 0);
    for (
      const candidate of [{ ...input, value: f.applicationId }, {
        ...input,
        value: f.principalId,
        allowedPrincipalIds: [f.principalId],
      }, {
        ...input,
        value: "2099-01-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
      }]
    ) {
      const rejected = await f.request("/v1/secrets", candidate);
      assertEquals(rejected.status, 422);
      assert(!(await rejected.text()).includes(candidate.value));
      assertEquals(f.calls(), 0);
    }
    const original = await Deno.readFile(f.key.file);
    await Deno.remove(f.key.file);
    const keyFailure = await f.request("/v1/secrets", input);
    assertEquals(keyFailure.status, 409);
    await keyFailure.arrayBuffer();
    assertEquals(f.calls(), 0);
    await Deno.writeFile(f.key.file, original);
    original.fill(0);
    const malicious = await f.request("/v1/secrets", { ...input, name: value });
    assertEquals(malicious.status, 422);
    assert(!(await malicious.text()).includes(value));
    assertEquals(f.calls(), 0);
    f.setProvider(() => Promise.resolve(new Response(value, { status: 401 })));
    const providerFailure = await f.request("/v1/secrets", input);
    assertEquals(providerFailure.status, 422);
    assert(!(await providerFailure.text()).includes(value));
    f.setProvider(() =>
      Promise.resolve(Response.json({ id: 1, login: value }))
    );
    const echoed = await f.request("/v1/secrets", input);
    assertEquals(echoed.status, 422);
    assert(!(await echoed.text()).includes(value));
    f.setProvider(async () => {
      await f.fixture.pgDatabase.query(
        `update bakery.organization_memberships set role='developer' where organization_id=$1 and principal_id=$2`,
        [f.organizationId, f.principalId],
      );
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const lost = await f.request("/v1/secrets", input);
    assertEquals(lost.status, 403);
    await lost.arrayBuffer();
    const before = f.calls();
    const denied = await f.request("/v1/secrets", input);
    assertEquals(denied.status, 403);
    await denied.arrayBuffer();
    assertEquals(f.calls(), before);
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.secret_versions",
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.idempotency_records where operation='secrets.create'",
      )).rows[0].count,
      "0",
    );
    await f.fixture.pgDatabase.query(
      `update bakery.organization_memberships set role='admin' where organization_id=$1 and principal_id=$2`,
      [f.organizationId, f.principalId],
    );
    f.setProvider(async () => {
      await f.fixture.pgDatabase.query(
        "update bakery.applications set archived_at=now() where id=$1",
        [f.applicationId],
      );
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const lostApplication = await f.request("/v1/secrets", input);
    assertEquals(lostApplication.status, 404);
    await lostApplication.arrayBuffer();
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=null where id=$1",
      [f.applicationId],
    );
    f.setProvider(() =>
      Promise.resolve(
        Response.json({ id: 12345, login: "fixture-user", extra: value }),
      )
    );
    await f.fixture.pgDatabase.query(
      "revoke insert on bakery.domain_events from bakery_app",
    );
    const failedFact = await f.request("/v1/secrets", input);
    assertEquals(failedFact.status, 500);
    assert(!(await failedFact.text()).includes(value));
    await f.fixture.pgDatabase.query(
      "grant insert on bakery.domain_events to bakery_app",
    );
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.secret_versions",
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.audit_events where operation='secrets.create'",
      )).rows[0].count,
      "0",
    );
    const key = crypto.randomUUID();
    const created = await f.request("/v1/secrets", input, key);
    assertEquals(created.status, 201);
    const metadata = await created.json();
    await assertRejects(() =>
      f.fixture.runtimePgDatabase.query(
        "update bakery.secret_versions set revision=2 where secret_id=$1",
        [metadata.id],
      )
    );
    await Deno.remove(f.key.file);
    const replay = await f.request("/v1/secrets", input, key);
    assertEquals(replay.status, 201);
    assert(!(await replay.text()).includes(value));
    const get = await f.request(
      `/v1/secrets/${metadata.id}?applicationId=${f.applicationId}`,
    );
    assertEquals(get.status, 200);
    assert(!(await get.text()).includes(value));
    // Completed replay still requires current Admin and a live application.
    await f.fixture.pgDatabase.query(
      `update bakery.applications set archived_at=now() where id=$1`,
      [f.applicationId],
    );
    const archived = await f.request("/v1/secrets", input, key);
    assertEquals(archived.status, 404);
    await archived.arrayBuffer();
    await f.fixture.pgDatabase.query(
      `update bakery.applications set archived_at=null where id=$1`,
      [f.applicationId],
    );
    const providerCount = f.calls();
    await f.fixture.pgDatabase.query(
      `update bakery.idempotency_records set response_headers='{"authorization":"untrusted"}'::jsonb where operation='secrets.create'`,
    );
    const corrupt = await f.request("/v1/secrets", input, key);
    assertEquals(corrupt.status, 500);
    assert(!(await corrupt.text()).includes(value));
    assertEquals(f.calls(), providerCount);
    for (
      const patch of [
        { status: 200, body: JSON.stringify(metadata) },
        {
          status: 201,
          body: "invalid-json",
        },
        {
          status: 201,
          body: JSON.stringify({
            ...metadata,
            rawProviderPayload: "untrusted",
          }),
        },
        { status: 201, body: JSON.stringify({ ...metadata, name: value }) },
        {
          status: 201,
          body: JSON.stringify({ ...metadata, applicationId: f.applicationB }),
        },
      ]
    ) {
      await f.fixture.pgDatabase.query(
        "update bakery.idempotency_records set response_headers='{}'::jsonb,response_status=$1,response_body=$2 where operation='secrets.create'",
        [patch.status, patch.body],
      );
      const invalidEnvelope = await f.request("/v1/secrets", input, key);
      assertEquals(invalidEnvelope.status, 500);
      assert(!(await invalidEnvelope.text()).includes(value));
      assertEquals(f.calls(), providerCount);
    }
    await f.fixture.pgDatabase.query(
      "update bakery.idempotency_records set response_body=$1,response_status=201,response_headers='{}'::jsonb where operation='secrets.create'",
      [JSON.stringify(metadata)],
    );
    const captures = await f.fixture.pgDatabase.query<{ safe: boolean }>(
      `select not exists(select 1 from bakery.audit_events where details::text like '%' || $1 || '%') and not exists(select 1 from bakery.domain_events where payload::text like '%' || $1 || '%') and not exists(select 1 from bakery.idempotency_records where response_body like '%' || $1 || '%') as safe`,
      [value],
    );
    assert(captures.rows[0].safe);
    // Null application/installation legacy ownership never becomes project fallback.
    await f.fixture.pgDatabase.query(
      `insert into bakery.secrets(id,organization_id,name) values($1,$2,'Legacy credential')`,
      [crypto.randomUUID(), f.organizationId],
    );
    const page = await f.request(
      `/v1/secrets?applicationId=${f.applicationId}`,
    );
    assertEquals((await page.json()).items.length, 1);
  } finally {
    await f.cleanup();
  }
});

Deno.test("rotation replay rechecks live application authority in both passes", async () => {
  const f = await openSecretsFixture();
  try {
    const secret = await f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name: "Rotation authority fixture",
      provider: "github",
      value: crypto.randomUUID(),
    }, { idempotencyKey: crypto.randomUUID() });
    const path = `/v1/secrets/${secret.id}/versions`;
    const firstKey = crypto.randomUUID();
    const firstValue = crypto.randomUUID();
    const first = await f.client.actions["secrets.rotate"]({
      id: secret.id,
      applicationId: f.applicationId,
      value: firstValue,
    }, { idempotencyKey: firstKey, ifMatch: '"v1"' });
    assertEquals(first.activeVersionRevision, 2);
    const callsAfterFirst = f.calls();
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=now() where id=$1",
      [f.applicationId],
    );
    const archivedReplay = await f.request(
      path,
      { applicationId: f.applicationId, value: firstValue },
      firstKey,
      f.organizationId,
      { ifMatch: '"v1"' },
    );
    assertEquals(archivedReplay.status, 404);
    await archivedReplay.arrayBuffer();
    assertEquals(f.calls(), callsAfterFirst);
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=null where id=$1",
      [f.applicationId],
    );

    let providerCalls = 0;
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const firstCommitted = Promise.withResolvers<void>();
    f.setProvider(async () => {
      providerCalls++;
      if (providerCalls === 1) {
        firstReady.resolve();
        await firstRelease.promise;
      } else if (providerCalls === 2) {
        secondReady.resolve();
        await firstCommitted.promise;
        await f.fixture.pgDatabase.query(
          "update bakery.applications set archived_at=now() where id=$1",
          [f.applicationId],
        );
        secondRelease.resolve();
        await secondRelease.promise;
      }
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const secondKey = crypto.randomUUID();
    const secondValue = crypto.randomUUID();
    const firstRequest = f.request(
      path,
      { applicationId: f.applicationId, value: secondValue },
      secondKey,
      f.organizationId,
      { ifMatch: '"v2"' },
    );
    await firstReady.promise;
    const replayRequest = f.request(
      path,
      { applicationId: f.applicationId, value: secondValue },
      secondKey,
      f.organizationId,
      { ifMatch: '"v2"' },
    );
    await secondReady.promise;
    firstRelease.resolve();
    const committed = await firstRequest;
    assertEquals(committed.status, 201);
    await committed.arrayBuffer();
    firstCommitted.resolve();
    const second = await replayRequest;
    assertEquals(second.status, 404);
    await second.arrayBuffer();
    assertEquals(providerCalls, 2);
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=null where id=$1",
      [f.applicationId],
    );
    const counts = await f.fixture.pgDatabase.query<{
      versions: string;
      audits: string;
      events: string;
      replays: string;
    }>(
      "select (select count(*) from bakery.secret_versions where secret_id=$1) as versions,(select count(*) from bakery.audit_events where resource_id=$1::text and operation='secrets.rotate') as audits,(select count(*) from bakery.domain_events where aggregate_id=$1::uuid and event_type='secret.rotated') as events,(select count(*) from bakery.idempotency_records where operation='secrets.rotate' and key in ($2,$3)) as replays",
      [secret.id, firstKey, secondKey],
    );
    assertEquals(counts.rows[0], {
      versions: "3",
      audits: "2",
      events: "2",
      replays: "2",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("revoke denies scope and lost authority before replay, rolls back failed facts and leaks no material", async () => {
  const f = await openSecretsFixture();
  try {
    const value = crypto.randomUUID();
    const secret = await f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name: "Safe revoke",
      provider: "github",
      value,
    }, { idempotencyKey: crypto.randomUUID() });
    const path = `/v1/secrets/${secret.id}`, key = crypto.randomUUID();
    const send = (
      app = f.applicationId,
      org = f.organizationId,
      target = path,
    ) =>
      f.request(target, { applicationId: app }, key, org, {
        method: "DELETE",
        ifMatch: '"v1"',
      });
    const state = () =>
      f.client.actions["secrets.get"]({
        id: secret.id,
        applicationId: f.applicationId,
      });
    const facts = async () =>
      (await f.fixture.pgDatabase.query<{ safe: string }>(
        "select jsonb_build_object('audit',(select count(*) from bakery.audit_events where operation='secrets.revoke'),'event',(select count(*) from bakery.domain_events where event_type='secret.revoked'),'replay',(select count(*) from bakery.idempotency_records where operation='secrets.revoke'))::text as safe",
      )).rows[0].safe;
    const before = await facts();
    const denied = async (response: Response, status: number) => {
      assertEquals(response.status, status);
      assert(!(await response.text()).includes(value));
    };
    for (
      const [app, org] of [[f.applicationB, f.organizationId], [
        f.foreignApplication,
        f.organizationId,
      ], [f.applicationId, f.organizationB]]
    ) await denied(await send(app, org), 404);
    const legacy = crypto.randomUUID();
    await f.fixture.pgDatabase.query(
      "insert into bakery.secrets(id,organization_id,name) values($1,$2,'Legacy')",
      [legacy, f.organizationId],
    );
    await denied(
      await send(f.applicationId, f.organizationId, `/v1/secrets/${legacy}`),
      404,
    );
    await denied(
      await f.fixture.app.fetch(
        new Request(`${f.fixture.config.publicBaseUrl}${path}`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "If-Match": '"v1"',
            origin: f.fixture.config.publicBaseUrl,
          },
          body: JSON.stringify({ applicationId: f.applicationId }),
        }),
      ),
      401,
    );
    for (
      const [column, changed, restored, status] of [[
        "role",
        "developer",
        "admin",
        403,
      ], ["status", "inactive", "active", 404]] as const
    ) {
      await f.fixture.pgDatabase.query(
        `update bakery.organization_memberships set ${column}=$1 where principal_id=$2 and organization_id=$3`,
        [changed, f.principalId, f.organizationId],
      );
      await denied(await send(), status);
      await f.fixture.pgDatabase.query(
        `update bakery.organization_memberships set ${column}=$1 where principal_id=$2 and organization_id=$3`,
        [restored, f.principalId, f.organizationId],
      );
    }
    const installation = crypto.randomUUID();
    await f.fixture.pgDatabase.query(
      "insert into bakery.secrets(id,organization_id,application_id,integration_installation_id,name) values($1,$2,$3,$4,'Installation fixture')",
      [installation, f.organizationId, f.applicationId, crypto.randomUUID()],
    );
    await denied(
      await send(
        f.applicationId,
        f.organizationId,
        `/v1/secrets/${installation}`,
      ),
      404,
    );
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=now() where id=$1",
      [f.applicationId],
    );
    await denied(await send(), 404);
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=null where id=$1",
      [f.applicationId],
    );
    assertEquals(await state(), secret);
    assertEquals(await facts(), before);
    await f.fixture.pgDatabase.query(
      "revoke insert on bakery.domain_events from bakery_app",
    );
    try {
      await denied(await send(), 500);
    } finally {
      await f.fixture.pgDatabase.query(
        "grant insert on bakery.domain_events to bakery_app",
      );
    }
    assertEquals(await state(), secret);
    assertEquals(await facts(), before);
    await Deno.remove(f.key.file);
    const calls = f.calls();
    f.setProvider(() => {
      throw new Error("NO_PROVIDER_ON_REVOKE");
    });
    await denied(await send(), 204);
    assertEquals(f.calls(), calls);
    const revoked = await state();
    const committed = await facts();
    await f.fixture.pgDatabase.query(
      "update bakery.organization_memberships set role='developer' where principal_id=$1 and organization_id=$2",
      [f.principalId, f.organizationId],
    );
    await denied(await send(), 403);
    await f.fixture.pgDatabase.query(
      "update bakery.organization_memberships set role='admin' where principal_id=$1 and organization_id=$2",
      [f.principalId, f.organizationId],
    );
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=now() where id=$1",
      [f.applicationId],
    );
    await denied(await send(), 404);
    await f.fixture.pgDatabase.query(
      "update bakery.applications set archived_at=null where id=$1",
      [f.applicationId],
    );
    assertEquals(await state(), revoked);
    assertEquals(await facts(), committed);
    await assertRejects(() =>
      f.fixture.runtimePgDatabase.query(
        "delete from bakery.secret_versions where secret_id=$1",
        [secret.id],
      )
    );
    await assertRejects(() =>
      f.fixture.runtimePgDatabase.query(
        "update bakery.secret_versions set revision=2 where secret_id=$1",
        [secret.id],
      )
    );
    await assertRejects(() =>
      f.fixture.runtimePgDatabase.query(
        "update bakery.secrets set name='tampered' where id=$1",
        [secret.id],
      )
    );
    await f.fixture.pgDatabase.query(
      "update bakery.principals set disabled_at=now() where id=$1",
      [f.principalId],
    );
    await denied(await send(), 403);
    await f.fixture.pgDatabase.query(
      "update bakery.principals set disabled_at=null where id=$1",
      [f.principalId],
    );
    assertEquals(await state(), revoked);
    assertEquals(await facts(), committed);
    const safe = await f.fixture.pgDatabase.query<{ projection: string }>(
      "select jsonb_build_object('audit',(select jsonb_agg(details) from bakery.audit_events),'event',(select jsonb_agg(payload) from bakery.domain_events),'replay',(select jsonb_agg(jsonb_build_object('body',response_body,'headers',response_headers)) from bakery.idempotency_records))::text as projection",
    );
    const projection = JSON.stringify(revoked) + safe.rows[0].projection;
    for (
      const canary of [
        value,
        btoa(value),
        encodeURIComponent(value),
        "ciphertext",
        "key_id",
        "authorization",
        "cookie",
        "request_digest",
      ]
    ) assert(!projection.toLowerCase().includes(canary.toLowerCase()));
  } finally {
    await f.cleanup();
  }
});
