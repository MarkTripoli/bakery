import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  call,
  createSuperuser,
  grant,
  openInstallationFixture,
  policy,
  readSettings,
  revoke,
  updateSettings,
} from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";

Deno.test("non-admin and ordinary self-grants are denied before persistence", async () => {
  const f = await openInstallationFixture();
  try {
    const before = await readSettings(f);
    for (
      const response of [
        await call(f, "GET", "/v1/installation/settings", f.developerCookie),
        await call(
          f,
          "GET",
          "/v1/installation/administrators",
          f.developerCookie,
        ),
        await updateSettings(f, before.version, policy, f.developerCookie),
        await grant(f, f.developerId!, f.developerCookie),
        await grant(f, f.adminId),
        await revoke(f, f.adminId, 1),
      ]
    ) assertEquals(response.status, 403, await response.clone().text());
    assertEquals(await readSettings(f), before);
    assertEquals(
      (await f.pgDatabase.query(
        "select principal_id from bakery.installation_administrators",
      )).rows,
      [{ principal_id: f.adminId }],
    );
    const anonymous = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/settings`),
    );
    assertEquals(anonymous.status, 401);
  } finally {
    await f.finish();
  }
});

Deno.test("settings reject missing/stale versions and forbidden license or bootstrap payloads", async () => {
  const f = await openInstallationFixture();
  try {
    const before = await readSettings(f);
    const missing = await call(
      f,
      "PATCH",
      "/v1/installation/settings",
      f.adminCookie,
      { body: policy, headers: { "Idempotency-Key": crypto.randomUUID() } },
    );
    assertEquals(missing.status, 428, await missing.clone().text());
    const stale = await updateSettings(f, before.version + 1);
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "VERSION_CONFLICT");
    for (
      const body of [
        { ...policy, registrationMode: "open" },
        { ...policy, unknownField: "secret" },
        { ...policy, bootstrapPrincipalId: f.developerId },
        { ...policy, version: before.version + 10 },
      ]
    ) {
      const response = await updateSettings(f, before.version, body);
      assertEquals(response.status, 400, await response.clone().text());
      assertEquals((await response.json()).code, "MALFORMED_REQUEST");
    }
    const spoofed = await call(
      f,
      "POST",
      "/v1/installation/administrators",
      f.adminCookie,
      {
        body: {
          principalId: f.developerId,
          grantedByPrincipalId: f.developerId,
          bootstrap: true,
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    assertEquals(spoofed.status, 400);
    assertEquals((await spoofed.json()).code, "MALFORMED_REQUEST");
    assertEquals(await readSettings(f), before);
  } finally {
    await f.finish();
  }
});

Deno.test("narrow app grants protect singleton, bootstrap pointer and private license columns", async () => {
  const f = await openInstallationFixture(false);
  try {
    const ownerRole = (await f.pgDatabase.query<{ role: string }>(
      "select current_user as role",
    )).rows[0]!.role;
    for (
      const sql of [
        "insert into bakery.installation_settings (id, registration_mode, organization_creation_policy, version, updated_at) values (false, 'invitation', 'installation_admins', 1, now())",
        "delete from bakery.installation_settings where id = true",
        "update bakery.installation_settings set id = false where id = true",
        "update bakery.installation_settings set bootstrap_principal_id = null where id = true",
        "update bakery.installation_settings set bootstrap_repair_version = 2 where id = true",
        "update bakery.installation_administrators set granted_by_principal_id = principal_id",
        "delete from bakery.installation_administrators",
        `set role "${ownerRole.replaceAll('"', '""')}"`,
        "delete from bakery.data_migrations",
      ]
    ) {
      const rejected = await assertRejects(() =>
        f.runtimePgDatabase.query(sql)
      );
      assertEquals((rejected as { code?: string }).code, "42501", sql);
    }
    const protectedRow = (await f.pgDatabase.query(
      "select id, bootstrap_principal_id, bootstrap_repair_version from bakery.installation_settings",
    )).rows;
    assertEquals(protectedRow, [{
      id: true,
      bootstrap_principal_id: f.adminId,
      bootstrap_repair_version: 1,
    }]);
  } finally {
    await f.finish();
  }
});

Deno.test("grant/revoke preserve provenance and replay cannot restore revoked authority", async () => {
  const f = await openInstallationFixture();
  try {
    const key = crypto.randomUUID();
    const created = await grant(f, f.developerId!, f.adminCookie, key);
    assertEquals(created.status, 201, await created.clone().text());
    const record = await created.json();
    assertEquals(record.grantedByPrincipalId, f.adminId);
    assertEquals(record.bootstrap, false);
    const replay = await grant(f, f.developerId!, f.adminCookie, key);
    assertEquals(replay.status, 201);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals((await grant(f)).status, 409);
    const before = await readSettings(f);
    const mutationKey = crypto.randomUUID();
    const changed = await updateSettings(
      f,
      before.version,
      policy,
      f.developerCookie,
      mutationKey,
    );
    assertEquals(changed.status, 200);
    const missingVersion = await call(
      f,
      "DELETE",
      `/v1/installation/administrators/${f.developerId}`,
      f.adminCookie,
      { headers: { "Idempotency-Key": crypto.randomUUID() } },
    );
    assertEquals(missingVersion.status, 428);
    const staleRevoke = await revoke(f, f.developerId!, record.version + 1);
    assertEquals(staleRevoke.status, 409);
    assertEquals((await staleRevoke.json()).code, "VERSION_CONFLICT");
    const revoked = await revoke(f, f.developerId!, record.version);
    assertEquals(revoked.status, 200, await revoked.clone().text());
    const revokedRecord = await revoked.json();
    assertEquals(revokedRecord.version, record.version + 1);
    assert(revokedRecord.revokedAt);
    assertEquals(revokedRecord.grantedByPrincipalId, f.adminId);
    assertEquals(
      (await updateSettings(
        f,
        before.version,
        policy,
        f.developerCookie,
        mutationKey,
      )).status,
      403,
    );
    assertEquals((await grant(f)).status, 409);
    assertEquals(
      (await call(f, "GET", "/v1/installation/settings", f.developerCookie))
        .status,
      403,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("concurrent same-target grants cannot duplicate or rewrite grant history", async () => {
  const f = await openInstallationFixture();
  try {
    const responses = await Promise.all([grant(f), grant(f)]);
    assertEquals(responses.map((response) => response.status).sort(), [
      201,
      409,
    ]);
    const rows = (await f.pgDatabase.query(
      "select principal_id, granted_by_principal_id, version from bakery.installation_administrators where principal_id = $1",
      [f.developerId],
    )).rows;
    assertEquals(rows, [{
      principal_id: f.developerId,
      granted_by_principal_id: f.adminId,
      version: 1,
    }]);
  } finally {
    await f.finish();
  }
});

Deno.test("mutual administrator revocation serializes live authority with one winner", async () => {
  const f = await openInstallationFixture();
  try {
    assertEquals((await grant(f)).status, 201);
    const results = await Promise.all([
      revoke(f, f.developerId!, 1),
      revoke(f, f.adminId, 1, f.developerCookie),
    ]);
    assertEquals(results.map((response) => response.status).sort(), [200, 403]);
    const live = (await f.pgDatabase.query(
      "select principal_id from bakery.installation_administrators where revoked_at is null",
    )).rows;
    assertEquals(live.length, 1);
    const loserCookie = results[0]!.status === 200
      ? f.developerCookie
      : f.adminCookie;
    const version = (await f.pgDatabase.query<{ version: number }>(
      "select version from bakery.installation_settings where id = true",
    )).rows[0]!.version;
    assertEquals(
      (await updateSettings(f, version, policy, loserCookie)).status,
      403,
    );
    assertEquals(
      (await f.pgDatabase.query(
        "select bootstrap_principal_id from bakery.installation_settings where id = true",
      )).rows[0].bootstrap_principal_id,
      f.adminId,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("principal disable committed while policy writer waits defeats stale authenticated context", async () => {
  const f = await openInstallationFixture();
  const blocker = await f.pgDatabase.connect();
  try {
    assertEquals((await grant(f)).status, 201);
    const before = await readSettings(f);
    await blocker.query("begin");
    await blocker.query(
      "select id from bakery.installation_settings where id = true for update",
    );
    const waiting = updateSettings(
      f,
      before.version,
      policy,
      f.developerCookie,
    );
    await blocker.query(
      "update bakery.principals set disabled_at = $2 where id = $1",
      [f.developerId, new Date()],
    );
    await blocker.query("commit");
    assertEquals((await waiting).status, 403);
    assertEquals(await readSettings(f), before);
    assertEquals((await grant(f)).status, 404);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await f.finish();
  }
});

Deno.test("organization creation uses live installation policy and current enabled human authority", async () => {
  const f = await openInstallationFixture();
  const organizations: string[] = [];
  try {
    const create = () =>
      call(f, "POST", "/v1/organizations", f.developerCookie, {
        body: {
          name: "Developer Team",
          slug: `developer-team-${crypto.randomUUID()}`,
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
    assertEquals((await create()).status, 403);
    const before = await readSettings(f);
    assertEquals(
      (await updateSettings(f, before.version, {
        registrationMode: "invitation",
        organizationCreationPolicy: "any_user",
      })).status,
      200,
    );
    const allowed = await create();
    assertEquals(allowed.status, 201, await allowed.clone().text());
    organizations.push((await allowed.json()).id);
    await f.pgDatabase.query(
      "update bakery.principals set disabled_at = $2 where id = $1",
      [f.developerId, new Date()],
    );
    assertEquals((await create()).status, 403);
  } finally {
    if (organizations.length) {
      await f.pgDatabase.query(
        "delete from bakery.organizations where id = any($1::uuid[])",
        [organizations],
      );
    }
    await f.finish();
  }
});

Deno.test("bootstrap cannot select a second identity or reactivate a revoked original", async () => {
  const f = await openInstallationFixture();
  try {
    const dependencies = { pgDatabase: f.pgDatabase, config: f.config.auth! };
    await assertRejects(() =>
      createSuperuser(dependencies, {
        email: f.developerEmail,
        displayName: "Other",
        password: f.password,
      })
    );
    assertEquals((await grant(f)).status, 201);
    assertEquals(
      (await revoke(f, f.adminId, 1, f.developerCookie)).status,
      200,
    );
    await assertRejects(
      () =>
        createSuperuser(dependencies, {
          email: f.adminEmail,
          displayName: "Settings Admin",
          password: f.password,
        }),
      Error,
      "AUTH_BOOTSTRAP_IDENTITY_UNAVAILABLE",
    );
    const marker = (await f.pgDatabase.query(
      "select bootstrap_principal_id, bootstrap_repair_version from bakery.installation_settings where id = true",
    )).rows;
    assertEquals(marker, [{
      bootstrap_principal_id: f.adminId,
      bootstrap_repair_version: 1,
    }]);
    assertEquals(
      (await f.pgDatabase.query(
        "select principal_id from bakery.installation_administrators where revoked_at is null",
      )).rows,
      [{ principal_id: f.developerId }],
    );
  } finally {
    await f.finish();
  }
});

Deno.test("unmarked multiuser legacy bootstrap fails with explicit recovery diagnostic", async () => {
  const f = await openInstallationFixture();
  try {
    await f.pgDatabase.query(
      "update bakery.installation_settings set bootstrap_principal_id = null, bootstrap_repair_version = null where id = true",
    );
    await f.pgDatabase.query("delete from bakery.installation_administrators");
    await assertRejects(
      () =>
        createSuperuser({ pgDatabase: f.pgDatabase, config: f.config.auth! }, {
          email: f.adminEmail,
          displayName: "Settings Admin",
          password: f.password,
        }),
      Error,
      "AUTH_BOOTSTRAP_LEGACY_IDENTITY_AMBIGUOUS",
    );
    assertEquals(
      (await f.pgDatabase.query(
        "select * from bakery.installation_administrators",
      )).rows,
      [],
    );
  } finally {
    await f.finish();
  }
});
