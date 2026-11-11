import { assert, assertEquals } from "@std/assert";
import { openSecretsFixture } from "../helpers/secrets.ts";
import {
  decryptSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";

Deno.test("authenticated project credential create/read client encrypted storage replay and races", async () => {
  const f = await openSecretsFixture();
  try {
    const value = crypto.randomUUID();
    const input = {
      applicationId: f.applicationId,
      name: "Fixture credential",
      provider: "github" as const,
      value,
    };
    const key = crypto.randomUUID();
    const first = await f.request("/v1/secrets", input, key);
    assertEquals(first.status, 201);
    const body = await first.text();
    const metadata = JSON.parse(body);
    assert(!body.includes(value));
    assertEquals(metadata.allowedPrincipals, []);
    assertEquals(metadata.allowedActions, []);
    assertEquals(metadata.version, 1);
    assertEquals(metadata.activeVersionRevision, 1);
    const stored = await f.fixture.pgDatabase.query<
      { ciphertext: Uint8Array; nonce: Uint8Array; key_id: string }
    >(
      `select ciphertext,nonce,key_id from bakery.secret_versions where secret_id=$1`,
      [metadata.id],
    );
    assertEquals(stored.rows.length, 1);
    const row = stored.rows[0];
    const plaintext = await decryptSecret(await loadSecretKey(f.key), {
      organizationId: f.organizationId,
      applicationId: f.applicationId,
      secretId: metadata.id,
      revision: 1,
      keyId: row.key_id,
    }, {
      ciphertext: new Uint8Array(row.ciphertext),
      nonce: new Uint8Array(row.nonce),
    });
    assert(new TextDecoder().decode(plaintext) === value);
    plaintext.fill(0);
    const repeat = await f.request("/v1/secrets", {
      ...input,
      allowedActions: [],
      allowedPrincipalIds: [],
      applicationId: f.applicationId.toUpperCase(),
    }, key);
    assertEquals(repeat.status, 201);
    assertEquals(await repeat.text(), body);
    assertEquals(repeat.headers.get("etag"), first.headers.get("etag"));
    assertEquals(f.calls(), 1);
    const mismatch = await f.request("/v1/secrets", {
      ...input,
      name: "Different",
    }, key);
    assertEquals(mismatch.status, 422);
    assertEquals((await mismatch.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(f.calls(), 1);
    const get = await f.client.actions["secrets.get"]({
      applicationId: f.applicationId,
      id: metadata.id,
    });
    assertEquals(get, metadata);
    const list = await f.client.actions["secrets.list"]({
      applicationId: f.applicationId,
    });
    assertEquals(list.items.length, 1);
    assertEquals(list.items[0], metadata);
    const other = await f.request(
      `/v1/secrets?applicationId=${f.applicationB}`,
    );
    assertEquals((await other.json()).items, []);
    assertEquals(
      (await f.request(
        `/v1/secrets/${metadata.id}?applicationId=${f.applicationB}`,
      )).status,
      404,
    );
    assertEquals(
      (await f.request(`/v1/secrets?applicationId=${f.foreignApplication}`))
        .status,
      404,
    );
    assertEquals(
      (await f.request(
        `/v1/secrets/${metadata.id}?applicationId=${f.applicationId}`,
        undefined,
        undefined,
        f.organizationB,
      )).status,
      404,
    );
    assertEquals((await f.request("/v1/secrets")).status, 400);
    const clientCreate = await f.client.actions["secrets.create"]({
      ...input,
      name: "Client credential",
    }, { idempotencyKey: crypto.randomUUID() });
    assertEquals(clientCreate.applicationId, f.applicationId);
    assertEquals(f.calls(), 2);
    const page = await f.request(
      `/v1/secrets?applicationId=${f.applicationId}&limit=1`,
    );
    const pageBody = await page.json();
    assert(pageBody.nextCursor);
    const cursor = encodeURIComponent(pageBody.nextCursor);
    assertEquals(
      (await f.request(
        `/v1/secrets?applicationId=${f.applicationB}&cursor=${cursor}`,
      )).status,
      400,
    );
    const next = await f.request(
      `/v1/secrets?applicationId=${f.applicationId}&limit=1&cursor=${cursor}`,
    );
    assertEquals((await next.json()).items.length, 1);
    const counts = await f.fixture.pgDatabase.query<
      {
        versions: string;
        audits: string;
        events: string;
        receipts: string;
        outbox: string;
      }
    >(`select (select count(*) from bakery.secret_versions) as versions,(select count(*) from bakery.audit_events where operation='secrets.create') as audits,(select count(*) from bakery.domain_events where event_type='secret.created') as events,(select count(*) from bakery.idempotency_records where operation='secrets.create') as receipts,(select count(*) from bakery.outbox) as outbox`);
    assertEquals(counts.rows[0], {
      versions: "2",
      audits: "2",
      events: "2",
      receipts: "2",
      outbox: "0",
    });
    // Both first-pass transactions must finish to reach this two-party provider barrier.
    let arrivals = 0;
    const firstReady = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setProvider(async () => {
      if (++arrivals === 1) firstReady.resolve();
      if (arrivals === 2) ready.resolve();
      await release.promise;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const raceKey = crypto.randomUUID();
    const firstMiss = f.request("/v1/secrets", input, raceKey);
    await firstReady.promise;
    const requests = [firstMiss, f.request("/v1/secrets", input, raceKey)];
    await ready.promise;
    release.resolve();
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status).sort();
    assert(statuses[0] === 201);
    assert(statuses[1] === 201 || statuses[1] === 409);
    for (const response of responses) await response.arrayBuffer();
    const winner = await f.request("/v1/secrets", input, raceKey);
    assertEquals(winner.status, 201);
    await winner.arrayBuffer();
    assertEquals(f.calls(), 4);
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.secret_versions",
      )).rows[0].count,
      "3",
    );
    const committed = await f.fixture.pgDatabase.query<
      { audits: string; events: string; receipts: string }
    >("select (select count(*) from bakery.audit_events where operation='secrets.create') as audits,(select count(*) from bakery.domain_events where event_type='secret.created') as events,(select count(*) from bakery.idempotency_records where operation='secrets.create') as receipts");
    assertEquals(committed.rows[0], {
      audits: "3",
      events: "3",
      receipts: "3",
    });
    arrivals = 0;
    const conflictingFirstReady = Promise.withResolvers<void>();
    const conflictingReady = Promise.withResolvers<void>();
    const conflictingRelease = Promise.withResolvers<void>();
    f.setProvider(async () => {
      if (++arrivals === 1) conflictingFirstReady.resolve();
      if (arrivals === 2) conflictingReady.resolve();
      await conflictingRelease.promise;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const conflictKey = crypto.randomUUID();
    const conflictMiss = f.request("/v1/secrets", input, conflictKey);
    await conflictingFirstReady.promise;
    const conflicts = [
      conflictMiss,
      f.request(
        "/v1/secrets",
        { ...input, name: "Conflicting credential" },
        conflictKey,
      ),
    ];
    await conflictingReady.promise;
    conflictingRelease.resolve();
    const conflictingResponses = await Promise.all(conflicts);
    const conflictStatuses = conflictingResponses.map((r) => r.status).sort();
    assertEquals(conflictStatuses[0], 201);
    assert(conflictStatuses[1] === 422 || conflictStatuses[1] === 409);
    for (const response of conflictingResponses) await response.arrayBuffer();
    assertEquals(
      (await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.secret_versions",
      )).rows[0].count,
      "4",
    );
    assertEquals(f.calls(), 6);
  } finally {
    await f.cleanup();
  }
});

Deno.test("generated DELETE revokes once, preserves history and serializes replay and version races", async () => {
  const { withPgTransaction } = await import("@bakery/persistence");
  const f = await openSecretsFixture();
  try {
    const create = () =>
      f.client.actions["secrets.create"]({
        applicationId: f.applicationId,
        name: "Revoke fixture",
        provider: "github",
        value: crypto.randomUUID(),
      }, { idempotencyKey: crypto.randomUUID() });
    const original = await create();
    const input = { applicationId: f.applicationId, id: original.id };
    const path = `/v1/secrets/${original.id}`;
    const revoke = (
      version: string | undefined,
      key?: string,
      body: unknown = input,
      target = path,
    ) =>
      f.request(target, body, key, f.organizationId, {
        method: "DELETE",
        ifMatch: version,
      });
    const history = async () =>
      (await f.fixture.pgDatabase.query<{ digest: string }>(
        "select md5(row_to_json(v)::text) as digest from bakery.secret_versions v where secret_id=$1 order by revision",
        [original.id],
      )).rows;
    const before = await history();
    for (
      const [body, header, status, target] of [
        [{}, '"v1"', 400, `${path}?applicationId=${f.applicationId}`],
        [input, undefined, 428, path],
        [input, 'W/"v1"', 428, path],
        [input, "*", 428, path],
        [input, "1", 428, path],
        [{ ...input, id: crypto.randomUUID() }, '"v1"', 400, path],
        [input, '"v2"', 412, path],
      ] as const
    ) {
      const response = await revoke(header, crypto.randomUUID(), body, target);
      assertEquals(response.status, status);
      await response.arrayBuffer();
    }
    const media = await f.request(
      path,
      { applicationId: f.applicationId },
      crypto.randomUUID(),
      f.organizationId,
      { method: "DELETE", ifMatch: '"v1"', contentType: "text/plain" },
    );
    assertEquals(media.status, 415);
    await media.arrayBuffer();
    assertEquals(await f.client.actions["secrets.get"](input), original);
    const calls = f.calls();
    f.setProvider(() => {
      throw new Error("REVOKE_MUST_NOT_VERIFY");
    });
    await Deno.remove(f.key.file);
    assertEquals(
      await f.client.actions["secrets.revoke"](input, { ifMatch: '"v1"' }),
      undefined,
    );
    assertEquals(f.clientTrace.at(-1), {
      method: "DELETE",
      path,
      bodyKeys: ["applicationId", "id"],
      ifMatch: '"v1"',
    });
    const after = await f.client.actions["secrets.get"](input);
    assert(after.revokedAt !== null);
    assertEquals(after.version, 2);
    assertEquals(after.invalidationGeneration, 2);
    assertEquals({
      ...after,
      revokedAt: original.revokedAt,
      version: 1,
      invalidationGeneration: 1,
      updatedAt: original.updatedAt,
    }, original);
    assertEquals(await history(), before);
    assertEquals(f.calls(), calls);
    const repeat = await revoke('"v1"', undefined, {
      id: original.id.toUpperCase(),
      applicationId: f.applicationId.toUpperCase(),
    }, `/v1/secrets/${original.id.toUpperCase()}`);
    assertEquals(repeat.status, 204);
    assertEquals(await repeat.text(), "");
    for (
      const [header, key, body, status] of [
        ['"v2"', undefined, input, 422],
        ['"v1"', undefined, { ...input, applicationId: f.applicationB }, 422],
        ['"v1"', crypto.randomUUID(), input, 412],
        ['"v2"', crypto.randomUUID(), input, 204],
      ] as const
    ) {
      const r = await revoke(header, key, body);
      assertEquals(r.status, status);
      await r.arrayBuffer();
    }
    assertEquals(await f.client.actions["secrets.get"](input), after);
    const facts = (await f.fixture.pgDatabase.query<
      { audits: string; events: string; outbox: string }
    >("select (select count(*) from bakery.audit_events where operation='secrets.revoke') as audits,(select count(*) from bakery.domain_events where event_type='secret.revoked') as events,(select count(*) from bakery.outbox) as outbox"))
      .rows[0];
    assertEquals(facts, { audits: "1", events: "1", outbox: "0" });
    // Restore fixture key only for creation of independent race targets.
    await Deno.writeFile(
      f.key.file,
      crypto.getRandomValues(new Uint8Array(32)),
    );
    f.setProvider(() =>
      Promise.resolve(Response.json({ id: 12345, login: "fixture-user" }))
    );
    for (const sameKey of [true, false]) {
      const secret = await create();
      const key = crypto.randomUUID();
      const send = (k: string) =>
        f.request(
          `/v1/secrets/${secret.id}`,
          { applicationId: f.applicationId },
          k,
          f.organizationId,
          { method: "DELETE", ifMatch: '"v1"' },
        );
      const locked = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = withPgTransaction(f.fixture.pgDatabase, async (tx) => {
        await tx.query("select id from bakery.secrets where id=$1 for update", [
          secret.id,
        ]);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const pending: Promise<Response>[] = [];
      try {
        const waiters = async (count: number) => {
          for (let i = 0; i < 2000; i++) {
            const observed = await f.adminPgDatabase.query<
              { count: string }
            >("select count(*) from pg_stat_activity where datname=current_database() and cardinality(pg_blocking_pids(pid))>0");
            if (Number(observed.rows[0].count) >= count) return;
          }
          throw new Error("REVOKE_LOCK_BARRIER_NOT_OBSERVED");
        };
        pending.push(Promise.resolve(send(key)));
        await waiters(1);
        pending.push(
          Promise.resolve(send(sameKey ? key : crypto.randomUUID())),
        );
        if (sameKey) {
          const busy = await pending[1];
          assertEquals(busy.status, 409);
          await busy.arrayBuffer();
        } else await waiters(2);
      } finally {
        release.resolve();
        await blocker;
      }
      const responses = await Promise.all(pending);
      assertEquals(
        responses.map((r) => r.status).sort(),
        sameKey ? [204, 409] : [204, 412],
      );
      for (const r of responses) if (!r.bodyUsed) await r.arrayBuffer();
      const replay = await send(key);
      assertEquals(replay.status, 204);
      await replay.arrayBuffer();
      const state = await f.client.actions["secrets.get"]({
        id: secret.id,
        applicationId: f.applicationId,
      });
      assertEquals(state.version, 2);
      assertEquals(state.invalidationGeneration, 2);
      const count = await f.fixture.pgDatabase.query<{ count: string }>(
        "select count(*) from bakery.domain_events where event_type='secret.revoked' and aggregate_id=$1",
        [secret.id],
      );
      assertEquals(count.rows[0].count, "1");
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("rotates encrypted history and replaces policy under live authority", async () => {
  const f = await openSecretsFixture();
  try {
    const create = await f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name: "Rotation fixture",
      provider: "github",
      value: crypto.randomUUID(),
    }, { idempotencyKey: crypto.randomUUID() });
    const path = `/v1/secrets/${create.id}`;
    const historyBefore = await f.fixture.pgDatabase.query<{ digest: string }>(
      "select md5(row_to_json(secret_versions)::text) as digest from bakery.secret_versions where secret_id=$1 order by revision",
      [create.id],
    );
    const providerCalls = f.calls();
    const rotatedValue = crypto.randomUUID();
    const rotatedBody = await f.client.actions["secrets.rotate"]({
      id: create.id,
      applicationId: f.applicationId,
      value: rotatedValue,
    }, { idempotencyKey: "rotation-replay", ifMatch: '"v1"' });
    assertEquals(rotatedBody.activeVersionRevision, 2);
    assertEquals(rotatedBody.version, 2);
    assertEquals(f.calls(), providerCalls + 1);
    const replay = await f.client.actions["secrets.rotate"]({
      id: create.id,
      applicationId: f.applicationId,
      value: rotatedValue,
    }, { idempotencyKey: "rotation-replay", ifMatch: '"v1"' });
    assertEquals(replay, rotatedBody);
    assertEquals(f.calls(), providerCalls + 1);
    const historyAfter = await f.fixture.pgDatabase.query<{ digest: string }>(
      "select md5(row_to_json(secret_versions)::text) as digest from bakery.secret_versions where secret_id=$1 order by revision",
      [create.id],
    );
    assertEquals(historyAfter.rows[0], historyBefore.rows[0]);
    assertEquals(historyAfter.rows.length, 2);
    assert(!JSON.stringify(rotatedBody).includes(rotatedValue));

    const policy = await f.request(
      path,
      {
        applicationId: f.applicationId,
        allowedPrincipalIds: [f.principalId],
        allowedActions: ["identity.read"],
      },
      crypto.randomUUID(),
      f.organizationId,
      { method: "PATCH", ifMatch: '"v2"' },
    );
    const policyText = await policy.text();
    assertEquals(policy.status, 200, policyText);
    const policyBody = JSON.parse(policyText);
    assertEquals(policyBody.allowedPrincipals, [f.principalId]);
    assertEquals(policyBody.allowedActions, ["identity.read"]);
    assertEquals(policyBody.policyRevision, 2);
    assertEquals(policyBody.invalidationGeneration, 3);
    assertEquals(policyBody.version, 3);

    for (
      const allowedActions of [["*"], ["identity.read", "identity.read"], [
        "unknown.action",
      ]]
    ) {
      const invalid = await f.request(
        path,
        {
          applicationId: f.applicationId,
          allowedPrincipalIds: [],
          allowedActions,
        },
        crypto.randomUUID(),
        f.organizationId,
        { method: "PATCH", ifMatch: '"v3"' },
      );
      assert([400, 422].includes(invalid.status));
      await invalid.arrayBuffer();
    }
    const stale = await f.request(
      path,
      {
        applicationId: f.applicationId,
        allowedPrincipalIds: [],
        allowedActions: [],
      },
      crypto.randomUUID(),
      f.organizationId,
      { method: "PATCH", ifMatch: '"v2"' },
    );
    assertEquals(stale.status, 412);
    await stale.arrayBuffer();
    const unchanged = await f.client.actions["secrets.get"]({
      applicationId: f.applicationId,
      id: create.id,
    });
    assertEquals(unchanged.version, 3);
    assertEquals(unchanged.allowedPrincipals, [f.principalId]);
    assertEquals(unchanged.allowedActions, ["identity.read"]);
  } finally {
    await f.cleanup();
  }
});

Deno.test("controlled secret lifecycle races preserve one exact committed snapshot", async () => {
  const f = await openSecretsFixture();
  type Snapshot = {
    activeVersionId: string | null;
    activeVersionRevision: number;
    generation: number;
    policyRevision: number;
    invalidationGeneration: number;
    version: number;
    allowedPrincipals: string[];
    allowedActions: string[];
    revoked: boolean;
    history: { id: string; revision: number; digest: string }[];
    facts: {
      rotateAudits: number;
      policyAudits: number;
      revokeAudits: number;
      rotateEvents: number;
      policyEvents: number;
      revokeEvents: number;
      rotateReplays: number;
      policyReplays: number;
      revokeReplays: number;
    };
  };
  const readSnapshot = async (
    id: string,
    replayKeys: string[] = [],
  ): Promise<Snapshot> => {
    const state = await f.fixture.pgDatabase.query<{
      active_version_id: string | null;
      active_version_revision: number;
      generation: number;
      policy_revision: number;
      invalidation_generation: number;
      version: number;
      allowed_principals: string[];
      allowed_actions: string[];
      revoked: boolean;
    }>(
      "select active_version_id,active_version_revision,generation,policy_revision,invalidation_generation,version,allowed_principals,allowed_actions,revoked_at is not null as revoked from bakery.secrets where id=$1",
      [id],
    );
    const history = await f.fixture.pgDatabase.query<
      { id: string; revision: number; digest: string }
    >(
      "select id,revision,md5(row_to_json(secret_versions)::text) as digest from bakery.secret_versions where secret_id=$1 order by revision",
      [id],
    );
    const facts = await f.fixture.pgDatabase.query<Snapshot["facts"]>(
      "select (select count(*) from bakery.audit_events where resource_id=$1::text and operation='secrets.rotate')::int as \"rotateAudits\",(select count(*) from bakery.audit_events where resource_id=$1::text and operation='secrets.updatePolicy')::int as \"policyAudits\",(select count(*) from bakery.audit_events where resource_id=$1::text and operation='secrets.revoke')::int as \"revokeAudits\",(select count(*) from bakery.domain_events where aggregate_id=$1::uuid and event_type='secret.rotated')::int as \"rotateEvents\",(select count(*) from bakery.domain_events where aggregate_id=$1::uuid and event_type='secret.policy_updated')::int as \"policyEvents\",(select count(*) from bakery.domain_events where aggregate_id=$1::uuid and event_type='secret.revoked')::int as \"revokeEvents\",(select count(*) from bakery.idempotency_records where operation='secrets.rotate' and key=any($2::text[]))::int as \"rotateReplays\",(select count(*) from bakery.idempotency_records where operation='secrets.updatePolicy' and key=any($2::text[]))::int as \"policyReplays\",(select count(*) from bakery.idempotency_records where operation='secrets.revoke' and key=any($2::text[]))::int as \"revokeReplays\"",
      [id, replayKeys],
    );
    const row = state.rows[0];
    if (!row) throw new Error("SECRET_SNAPSHOT_MISSING");
    return {
      activeVersionId: row.active_version_id,
      activeVersionRevision: row.active_version_revision,
      generation: row.generation,
      policyRevision: row.policy_revision,
      invalidationGeneration: row.invalidation_generation,
      version: row.version,
      allowedPrincipals: row.allowed_principals,
      allowedActions: row.allowed_actions,
      revoked: row.revoked,
      history: history.rows,
      facts: facts.rows[0],
    };
  };
  const assertHistory = (before: Snapshot, after: Snapshot, count: number) => {
    assertEquals(after.history.length, count);
    assertEquals(
      after.history.slice(0, before.history.length),
      before.history,
    );
    assertEquals(
      after.activeVersionId,
      after.history[after.history.length - 1].id,
    );
    assertEquals(
      after.activeVersionRevision,
      after.history[after.history.length - 1].revision,
    );
  };
  const create = (name: string) =>
    f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name,
      provider: "github",
      value: crypto.randomUUID(),
    }, { idempotencyKey: crypto.randomUUID() });
  const policy = (id: string, version: number, key: string) =>
    f.request(
      `/v1/secrets/${id}`,
      {
        applicationId: f.applicationId,
        allowedPrincipalIds: [f.principalId],
        allowedActions: ["identity.read"],
      },
      key,
      f.organizationId,
      { method: "PATCH", ifMatch: `"v${version}"` },
    );
  const rotate = (id: string, key: string, version: number) =>
    f.request(
      `/v1/secrets/${id}/versions`,
      { applicationId: f.applicationId, value: crypto.randomUUID() },
      key,
      f.organizationId,
      { ifMatch: `"v${version}"` },
    );
  const revoke = (id: string, version: number, key: string) =>
    f.request(
      `/v1/secrets/${id}`,
      { applicationId: f.applicationId },
      key,
      f.organizationId,
      { method: "DELETE", ifMatch: `"v${version}"` },
    );
  try {
    f.setProvider(() =>
      Promise.resolve(Response.json({ id: 12345, login: "fixture-user" }))
    );

    const policyFirst = await create("Policy before rotation");
    const policyFirstBefore = await readSnapshot(policyFirst.id);
    const providerReady = Promise.withResolvers<void>();
    const providerRelease = Promise.withResolvers<void>();
    f.setProvider(async () => {
      providerReady.resolve();
      await providerRelease.promise;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const policyFirstRotationKey = crypto.randomUUID();
    const policyFirstPolicyKey = crypto.randomUUID();
    const pendingRotation = rotate(
      policyFirst.id,
      policyFirstRotationKey,
      1,
    );
    await providerReady.promise;
    const policyResult = await policy(
      policyFirst.id,
      1,
      policyFirstPolicyKey,
    );
    assertEquals(policyResult.status, 200);
    await policyResult.arrayBuffer();
    providerRelease.resolve();
    const rotationResult = await pendingRotation;
    assertEquals(rotationResult.status, 201);
    await rotationResult.arrayBuffer();
    const policyFirstAfter = await readSnapshot(policyFirst.id, [
      policyFirstRotationKey,
      policyFirstPolicyKey,
    ]);
    assertEquals({
      activeVersionRevision: policyFirstAfter.activeVersionRevision,
      generation: policyFirstAfter.generation,
      policyRevision: policyFirstAfter.policyRevision,
      invalidationGeneration: policyFirstAfter.invalidationGeneration,
      version: policyFirstAfter.version,
      allowedPrincipals: policyFirstAfter.allowedPrincipals,
      allowedActions: policyFirstAfter.allowedActions,
      revoked: policyFirstAfter.revoked,
      facts: policyFirstAfter.facts,
    }, {
      activeVersionRevision: 2,
      generation: 2,
      policyRevision: 2,
      invalidationGeneration: 3,
      version: 3,
      allowedPrincipals: [f.principalId],
      allowedActions: ["identity.read"],
      revoked: false,
      facts: {
        rotateAudits: 1,
        policyAudits: 1,
        revokeAudits: 0,
        rotateEvents: 1,
        policyEvents: 1,
        revokeEvents: 0,
        rotateReplays: 1,
        policyReplays: 1,
        revokeReplays: 0,
      },
    });
    assertHistory(policyFirstBefore, policyFirstAfter, 2);

    const rotateFirst = await create("Rotation before policy");
    const rotateFirstBefore = await readSnapshot(rotateFirst.id);
    const rotateFirstRotationKey = crypto.randomUUID();
    const rotateFirstPolicyKey = crypto.randomUUID();
    const rotateFirstResult = await rotate(
      rotateFirst.id,
      rotateFirstRotationKey,
      1,
    );
    assertEquals(rotateFirstResult.status, 201);
    await rotateFirstResult.arrayBuffer();
    const rotateFirstCommitted = await readSnapshot(rotateFirst.id, [
      rotateFirstRotationKey,
      rotateFirstPolicyKey,
    ]);
    assertHistory(rotateFirstBefore, rotateFirstCommitted, 2);
    const policyAfterRotate = await policy(
      rotateFirst.id,
      2,
      rotateFirstPolicyKey,
    );
    assertEquals(policyAfterRotate.status, 200);
    await policyAfterRotate.arrayBuffer();
    const rotateFirstAfter = await readSnapshot(rotateFirst.id, [
      rotateFirstRotationKey,
      rotateFirstPolicyKey,
    ]);
    assertEquals({
      activeVersionRevision: rotateFirstAfter.activeVersionRevision,
      generation: rotateFirstAfter.generation,
      policyRevision: rotateFirstAfter.policyRevision,
      invalidationGeneration: rotateFirstAfter.invalidationGeneration,
      version: rotateFirstAfter.version,
      allowedPrincipals: rotateFirstAfter.allowedPrincipals,
      allowedActions: rotateFirstAfter.allowedActions,
      revoked: rotateFirstAfter.revoked,
      facts: rotateFirstAfter.facts,
    }, {
      activeVersionRevision: 2,
      generation: 2,
      policyRevision: 2,
      invalidationGeneration: 3,
      version: 3,
      allowedPrincipals: [f.principalId],
      allowedActions: ["identity.read"],
      revoked: false,
      facts: {
        rotateAudits: 1,
        policyAudits: 1,
        revokeAudits: 0,
        rotateEvents: 1,
        policyEvents: 1,
        revokeEvents: 0,
        rotateReplays: 1,
        policyReplays: 1,
        revokeReplays: 0,
      },
    });
    assertHistory(rotateFirstCommitted, rotateFirstAfter, 2);

    const revokeFirst = await create("Revoke before rotation");
    const revokeFirstBefore = await readSnapshot(revokeFirst.id);
    const revokeFirstReady = Promise.withResolvers<void>();
    const revokeFirstRelease = Promise.withResolvers<void>();
    f.setProvider(async () => {
      revokeFirstReady.resolve();
      await revokeFirstRelease.promise;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const revokeFirstRotationKey = crypto.randomUUID();
    const revokeFirstRevokeKey = crypto.randomUUID();
    const blockedRotation = rotate(
      revokeFirst.id,
      revokeFirstRotationKey,
      1,
    );
    await revokeFirstReady.promise;
    const revokeFirstResult = await revoke(
      revokeFirst.id,
      1,
      revokeFirstRevokeKey,
    );
    assertEquals(revokeFirstResult.status, 204);
    await revokeFirstResult.arrayBuffer();
    revokeFirstRelease.resolve();
    const rejectedRotation = await blockedRotation;
    assertEquals(rejectedRotation.status, 404);
    await rejectedRotation.arrayBuffer();
    const revokeFirstAfter = await readSnapshot(revokeFirst.id, [
      revokeFirstRotationKey,
      revokeFirstRevokeKey,
    ]);
    assertEquals(revokeFirstAfter.revoked, true);
    assertEquals(revokeFirstAfter.version, 2);
    assertEquals(revokeFirstAfter.generation, 1);
    assertEquals(revokeFirstAfter.policyRevision, 1);
    assertEquals(revokeFirstAfter.invalidationGeneration, 2);
    assertEquals(revokeFirstAfter.allowedPrincipals, []);
    assertEquals(revokeFirstAfter.allowedActions, []);
    assertHistory(revokeFirstBefore, revokeFirstAfter, 1);
    assertEquals(revokeFirstAfter.facts, {
      rotateAudits: 0,
      policyAudits: 0,
      revokeAudits: 1,
      rotateEvents: 0,
      policyEvents: 0,
      revokeEvents: 1,
      rotateReplays: 0,
      policyReplays: 0,
      revokeReplays: 1,
    });

    const revokeAfter = await create("Rotation before revoke");
    const revokeAfterBefore = await readSnapshot(revokeAfter.id);
    const revokeAfterReady = Promise.withResolvers<void>();
    const revokeAfterRelease = Promise.withResolvers<void>();
    f.setProvider(async () => {
      revokeAfterReady.resolve();
      await revokeAfterRelease.promise;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const revokeAfterRotationKey = crypto.randomUUID();
    const revokeAfterRevokeKey = crypto.randomUUID();
    const rotationBeforeRevoke = rotate(
      revokeAfter.id,
      revokeAfterRotationKey,
      1,
    );
    await revokeAfterReady.promise;
    revokeAfterRelease.resolve();
    const rotationBeforeRevokeResult = await rotationBeforeRevoke;
    assertEquals(rotationBeforeRevokeResult.status, 201);
    await rotationBeforeRevokeResult.arrayBuffer();
    const revokeAfterRotation = await readSnapshot(revokeAfter.id, [
      revokeAfterRotationKey,
      revokeAfterRevokeKey,
    ]);
    assertHistory(revokeAfterBefore, revokeAfterRotation, 2);
    const revokeAfterResult = await revoke(
      revokeAfter.id,
      2,
      revokeAfterRevokeKey,
    );
    assertEquals(revokeAfterResult.status, 204);
    await revokeAfterResult.arrayBuffer();
    const revokeAfterState = await readSnapshot(revokeAfter.id, [
      revokeAfterRotationKey,
      revokeAfterRevokeKey,
    ]);
    assertEquals(revokeAfterState.revoked, true);
    assertEquals(revokeAfterState.version, 3);
    assertEquals(revokeAfterState.generation, 2);
    assertEquals(revokeAfterState.policyRevision, 1);
    assertEquals(revokeAfterState.invalidationGeneration, 3);
    assertEquals(revokeAfterState.allowedPrincipals, []);
    assertEquals(revokeAfterState.allowedActions, []);
    assertHistory(revokeAfterRotation, revokeAfterState, 2);
    assertEquals(revokeAfterState.facts, {
      rotateAudits: 1,
      policyAudits: 0,
      revokeAudits: 1,
      rotateEvents: 1,
      policyEvents: 0,
      revokeEvents: 1,
      rotateReplays: 1,
      policyReplays: 0,
      revokeReplays: 1,
    });

    const competing = await create("Competing rotations");
    const competingBefore = await readSnapshot(competing.id);
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    let competingCalls = 0;
    f.setProvider(async () => {
      competingCalls++;
      if (competingCalls === 1) {
        firstReady.resolve();
        await firstRelease.promise;
      } else {
        secondReady.resolve();
        await secondRelease.promise;
      }
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const firstRotationKey = crypto.randomUUID();
    const secondRotationKey = crypto.randomUUID();
    const firstRotation = rotate(
      competing.id,
      firstRotationKey,
      1,
    );
    await firstReady.promise;
    const secondRotation = rotate(
      competing.id,
      secondRotationKey,
      1,
    );
    await secondReady.promise;
    firstRelease.resolve();
    const firstRotationResult = await firstRotation;
    assertEquals(firstRotationResult.status, 201);
    await firstRotationResult.arrayBuffer();
    secondRelease.resolve();
    const secondRotationResult = await secondRotation;
    assertEquals(secondRotationResult.status, 412);
    await secondRotationResult.arrayBuffer();
    assertEquals(competingCalls, 2);
    const competingAfter = await readSnapshot(competing.id, [
      firstRotationKey,
      secondRotationKey,
    ]);
    assertEquals({
      activeVersionRevision: competingAfter.activeVersionRevision,
      generation: competingAfter.generation,
      policyRevision: competingAfter.policyRevision,
      invalidationGeneration: competingAfter.invalidationGeneration,
      version: competingAfter.version,
      allowedPrincipals: competingAfter.allowedPrincipals,
      allowedActions: competingAfter.allowedActions,
      revoked: competingAfter.revoked,
      facts: competingAfter.facts,
    }, {
      activeVersionRevision: 2,
      generation: 2,
      policyRevision: 1,
      invalidationGeneration: 2,
      version: 2,
      allowedPrincipals: [],
      allowedActions: [],
      revoked: false,
      facts: {
        rotateAudits: 1,
        policyAudits: 0,
        revokeAudits: 0,
        rotateEvents: 1,
        policyEvents: 0,
        revokeEvents: 0,
        rotateReplays: 1,
        policyReplays: 0,
        revokeReplays: 0,
      },
    });
    assertHistory(competingBefore, competingAfter, 2);
  } finally {
    await f.cleanup();
  }
});

Deno.test("rotation fails closed when projected metadata echoes the new credential", async () => {
  const f = await openSecretsFixture();
  try {
    // Control: create itself rejects the direct credential echo in a
    // submitted metadata string.
    const credential = crypto.randomUUID();
    const echo = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: credential,
      provider: "github",
      value: credential,
    }, crypto.randomUUID());
    assertEquals(echo.status, 422);

    // Rotation scenario: an existing secret whose immutable name equals the
    // new credential (raw and base64 forms) must be refused before any
    // provider I/O, commit nothing, and store no replayable leaked response.
    const poisonedName = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: credential,
      provider: "github",
      value: crypto.randomUUID(),
    }, crypto.randomUUID());
    assertEquals(poisonedName.status, 201);
    const poisonedId = (await poisonedName.json()).id;

    const callsBefore = f.calls();
    const rawRotation = await f.request(
      `/v1/secrets/${poisonedId}/versions`,
      { applicationId: f.applicationId, value: credential },
      crypto.randomUUID(),
      f.organizationId,
      { method: "POST", ifMatch: '"v1"' },
    );
    assertEquals(rawRotation.status, 422);
    assertEquals(f.calls(), callsBefore);

    const base64 = btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(credential),
      ),
    );
    const base64Named = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: base64,
      provider: "github",
      value: crypto.randomUUID(),
    }, crypto.randomUUID());
    assertEquals(base64Named.status, 201);
    const base64Id = (await base64Named.json()).id;
    const base64Rotation = await f.request(
      `/v1/secrets/${base64Id}/versions`,
      { applicationId: f.applicationId, value: credential },
      crypto.randomUUID(),
      f.organizationId,
      { method: "POST", ifMatch: '"v1"' },
    );
    assertEquals(base64Rotation.status, 422);

    const unchanged = await f.fixture.pgDatabase.query<{
      active_version_revision: number;
      version: number;
      versions: string;
    }>(
      `select s.active_version_revision,s.version,
              (select count(*)::text from bakery.secret_versions v where v.secret_id=s.id) as versions
         from bakery.secrets s where s.id=any($1)`,
      [[poisonedId, base64Id]],
    );
    for (const row of unchanged.rows) {
      assertEquals(
        `${row.active_version_revision}/${row.version}/${row.versions}`,
        "1/1/1",
      );
    }
    const stored = await f.fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.idempotency_records
         where operation='secrets.rotate' and response_body like $1`,
      [`%${credential}%`],
    );
    assertEquals(stored.rows[0].count, "0");

    // Replay fail-closed: a completed rotation record whose stored response
    // metadata was poisoned after the fact must not be served.
    const replayValue = crypto.randomUUID();
    const rotation = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: "Rotation replay fixture",
      provider: "github",
      value: crypto.randomUUID(),
    }, crypto.randomUUID());
    assertEquals(rotation.status, 201);
    const rotationId = (await rotation.json()).id;
    const committed = await f.request(
      `/v1/secrets/${rotationId}/versions`,
      { applicationId: f.applicationId, value: replayValue },
      "poisoned-replay",
      f.organizationId,
      { method: "POST", ifMatch: '"v1"' },
    );
    assertEquals(committed.status, 201);
    await f.fixture.pgDatabase.query(
      `update bakery.idempotency_records
          set response_body = replace(response_body, 'Rotation replay fixture', $1)
        where operation = 'secrets.rotate'
          and response_body like '%Rotation replay fixture%'`,
      [replayValue],
    );
    const replay = await f.request(
      `/v1/secrets/${rotationId}/versions`,
      { applicationId: f.applicationId, value: replayValue },
      "poisoned-replay",
      f.organizationId,
      { method: "POST", ifMatch: '"v1"' },
    );
    assertEquals(replay.status, 500);
    assert(!(await replay.text()).includes(replayValue));
  } finally {
    await f.cleanup();
  }
});
