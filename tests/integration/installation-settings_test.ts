import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  authRequest,
  call,
  createSuperuser,
  grant,
  openInstallationFixture,
  readSettings,
  updateSettings,
} from "../helpers/installation-settings.ts";
import { initializeInstallationSettings } from "../../apps/server/src/modules/auth/migrations/data/0077_initialize_installation_settings.ts";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";

Deno.test("fresh installation bootstrap grants one administrator and exposes explicit policy projections", async () => {
  const f = await openInstallationFixture();
  try {
    const settings = await readSettings(f);
    assertEquals(settings.registrationMode, "invitation");
    assertEquals(settings.organizationCreationPolicy, "installation_admins");
    assertEquals(Object.keys(settings).sort(), [
      "organizationCreationPolicy",
      "registrationMode",
      "updatedAt",
      "updatedByPrincipalId",
      "version",
    ]);
    const administrators = await call(
      f,
      "GET",
      "/v1/installation/administrators",
      f.adminCookie,
    );
    assertEquals(administrators.status, 200);
    const page = await administrators.json();
    assertEquals(page.items.length, 1);
    assertEquals(page.items[0].principalId, f.adminId);
    assertEquals(page.items[0].grantedByPrincipalId, f.adminId);
    assertEquals(page.items[0].bootstrap, true);
    assertEquals(page.items[0].revokedAt, null);
    const team = await call(f, "POST", "/v1/organizations", f.adminCookie, {
      body: {
        name: "Installation Team",
        slug: `installation-team-${crypto.randomUUID()}`,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    assertEquals(team.status, 201, await team.clone().text());
    const changed = await updateSettings(f, settings.version, {
      registrationMode: "invitation",
      organizationCreationPolicy: "any_user",
    });
    assertEquals(changed.status, 200, await changed.clone().text());
    assertEquals((await changed.json()).version, settings.version + 1);
    const publicResponse = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/capabilities`),
    );
    assertEquals(publicResponse.status, 200);
    assertEquals(await publicResponse.json(), {
      registration: "invitation",
      organizationCreation: "any_user",
      ssoAvailable: false,
    });
    assert(
      f.developerCookie,
      "invited user completed registration and sign-in",
    );
    await f.pgDatabase.query("delete from bakery.organizations where id = $1", [
      (await team.json()).id,
    ]);
  } finally {
    await f.finish();
  }
});

Deno.test("CAS concurrent writes have one winner and replay increments settings once", async () => {
  const f = await openInstallationFixture(false);
  try {
    const initial = await readSettings(f);
    const key = crypto.randomUUID();
    const results = await Promise.all([
      updateSettings(
        f,
        initial.version,
        {
          registrationMode: "closed",
          organizationCreationPolicy: "installation_admins",
        },
        f.adminCookie,
        key,
      ),
      updateSettings(f, initial.version, {
        registrationMode: "invitation",
        organizationCreationPolicy: "any_user",
      }),
    ]);
    assertEquals(results.map((result) => result.status).sort(), [200, 409]);
    assertEquals(
      (await results.find((result) => result.status === 409)!.json()).code,
      "VERSION_CONFLICT",
    );
    const winner = results.findIndex((result) => result.status === 200);
    const stored = await readSettings(f);
    assertEquals(stored.version, initial.version + 1);
    if (winner === 0) {
      const replay = await updateSettings(
        f,
        initial.version,
        {
          registrationMode: "closed",
          organizationCreationPolicy: "installation_admins",
        },
        f.adminCookie,
        key,
      );
      assertEquals(replay.status, 200);
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      assertEquals((await readSettings(f)).version, stored.version);
    } else {
      const stableKey = crypto.randomUUID();
      const response = await updateSettings(
        f,
        stored.version,
        {
          registrationMode: "invitation",
          organizationCreationPolicy: "any_user",
        },
        f.adminCookie,
        stableKey,
      );
      assertEquals(response.status, 200);
      assertEquals(
        (await updateSettings(
          f,
          stored.version,
          {
            registrationMode: "invitation",
            organizationCreationPolicy: "any_user",
          },
          f.adminCookie,
          stableKey,
        )).headers.get("Idempotent-Replayed"),
        "true",
      );
      assertEquals((await readSettings(f)).version, stored.version + 1);
    }
  } finally {
    await f.finish();
  }
});

Deno.test("bootstrap repair supports legacy completion and marked rerun after installation growth", async () => {
  const f = await openInstallationFixture(false);
  try {
    await f.pgDatabase.query(
      "update bakery.installation_settings set bootstrap_principal_id = null, bootstrap_repair_version = null where id = true",
    );
    await f.pgDatabase.query(
      "delete from bakery.installation_administrators where principal_id = $1",
      [f.adminId],
    );
    const dependencies = { pgDatabase: f.pgDatabase, config: f.config.auth! };
    const input = {
      email: f.adminEmail,
      displayName: "Settings Admin",
      password: f.password,
    };
    await assertRejects(() =>
      createSuperuser(dependencies, { ...input, password: "wrong-password" })
    );
    assertEquals(
      (await f.pgDatabase.query(
        "select * from bakery.installation_administrators",
      )).rows.length,
      0,
    );
    assertEquals(
      (await createSuperuser(dependencies, input)).status,
      "completed",
    );
    const now = new Date();
    const extraUser = crypto.randomUUID();
    await f.pgDatabase.query(
      'insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, $3, true, $4, $4)',
      [extraUser, "Later user", `later-${extraUser}@example.test`, now],
    );
    try {
      assertEquals(
        (await createSuperuser(dependencies, input)).status,
        "already-complete",
      );
      const grants = await f.pgDatabase.query(
        "select principal_id from bakery.installation_administrators",
      );
      assertEquals(grants.rows, [{ principal_id: f.adminId }]);
      const marker = await f.pgDatabase.query(
        "select bootstrap_principal_id, bootstrap_repair_version from bakery.installation_settings where id = true",
      );
      assertEquals(marker.rows, [{
        bootstrap_principal_id: f.adminId,
        bootstrap_repair_version: 1,
      }]);
    } finally {
      await f.pgDatabase.query('delete from public."user" where id = $1', [
        extraUser,
      ]);
    }
  } finally {
    await f.finish();
  }
});

Deno.test("versioned initialization preserves operator policy and rolls back interruption or malformed singleton", async () => {
  const f = await openInstallationFixture(false);
  const connection = await f.database.reserve();
  try {
    const initial = await readSettings(f);
    assertEquals(
      (await updateSettings(f, initial.version, {
        registrationMode: "closed",
        organizationCreationPolicy: "any_user",
      })).status,
      200,
    );
    const before = await readSettings(f);
    assertEquals(
      await initializeInstallationSettings.run(connection, { maxBatches: 1 }),
      true,
    );
    assertEquals(await readSettings(f), before);
    await assertRejects(
      () =>
        initializeInstallationSettings.run(connection, {
          maxBatches: 1,
          beforeCommit: () => Promise.reject(new Error("interrupted")),
        }),
      Error,
      "interrupted",
    );
    assertEquals(await readSettings(f), before);
    await f.pgDatabase.query(
      "insert into bakery.installation_settings (id, registration_mode, organization_creation_policy, version, updated_at) values (false, 'invitation', 'installation_admins', 1, $1)",
      [new Date()],
    );
    try {
      await assertRejects(
        () => initializeInstallationSettings.run(connection, { maxBatches: 1 }),
        Error,
        "INSTALLATION_SETTINGS_SINGLETON_INVALID",
      );
    } finally {
      await f.pgDatabase.query(
        "delete from bakery.installation_settings where id = false",
      );
    }
    assertEquals(await readSettings(f), before);
  } finally {
    await connection.release();
    await f.finish();
  }
});

async function policyProcess() {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      "deno.json",
      "-A",
      "tests/helpers/installation-policy-server.child.ts",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  let text = "";
  const started = Date.now();
  const ready = async () => {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("INSTALLATION_POLICY_PROCESS_EXITED");
      text += new TextDecoder().decode(next.value);
    }
    return (JSON.parse(text.split("\n")[0]!) as { url: string }).url;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      ready(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("INSTALLATION_POLICY_PROCESS_TIMEOUT")),
          30_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    return {
      url,
      elapsed: Date.now() - started,
      close: async () => {
        await child.stdin.close();
        await reader.cancel();
        reader.releaseLock();
        assertEquals((await child.status).code, 0);
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    await child.status;
    await reader.cancel();
    reader.releaseLock();
    throw error;
  }
}

Deno.test("two actual server processes observe closed registration on next request without blocking sign-in or bootstrap", async () => {
  const f = await openInstallationFixture(true);
  const processes: Awaited<ReturnType<typeof policyProcess>>[] = [];
  const invitedEmails: string[] = [];
  const warmEmails: string[] = [];
  try {
    processes.push(await policyProcess());
    processes.push(await policyProcess());
    for (let index = 0; index < 2; index++) {
      const warmEmail =
        `process-warm-${index}-${crypto.randomUUID()}@example.test`;
      warmEmails.push(warmEmail);
      const warmInvite = await call(
        f,
        "POST",
        `/v1/organizations/${f.organizationId}/invitations`,
        f.adminCookie,
        {
          body: { email: warmEmail, role: "developer" },
          headers: {
            "Bakery-Organization-Id": f.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
      assertEquals(warmInvite.status, 201, await warmInvite.clone().text());
      const warmRequest = authRequest("/api/auth/sign-up/email", {
        email: warmEmail,
        name: "Invited before closure",
        password: f.password,
      });
      const registered = await fetch(
        `${processes[index].url}/api/auth/sign-up/email`,
        {
          method: warmRequest.method,
          headers: warmRequest.headers,
          body: await warmRequest.text(),
        },
      );
      assertEquals(registered.status, 200, await registered.clone().text());
      await registered.body?.cancel();
      const email = `process-${index}-${crypto.randomUUID()}@example.test`;
      invitedEmails.push(email);
      const invite = await call(
        f,
        "POST",
        `/v1/organizations/${f.organizationId}/invitations`,
        f.adminCookie,
        {
          body: { email, role: "developer" },
          headers: {
            "Bakery-Organization-Id": f.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
      assertEquals(invite.status, 201, await invite.clone().text());
    }
    assertEquals(
      (await f.pgDatabase.query(
        'select id from public."user" where email = any($1::text[])',
        [warmEmails],
      )).rows.length,
      2,
      "each unchanged server process first registers an invited user under invitation mode",
    );
    // Real loopback clients share the provider's three-signup, ten-second window.
    // Let warm-up expire before changing policy; post-change requests remain immediate.
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    const before = await readSettings(f);
    assertEquals(
      (await updateSettings(f, before.version, {
        registrationMode: "closed",
        organizationCreationPolicy: "installation_admins",
      })).status,
      200,
    );
    for (const [index, process] of processes.entries()) {
      const request = authRequest("/api/auth/sign-up/email", {
        email: invitedEmails[index],
        name: "Invited",
        password: f.password,
      });
      const denied = await fetch(`${process.url}/api/auth/sign-up/email`, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      assertEquals(denied.status, 200, await denied.clone().text());
      assertEquals((await denied.json()).token, null);
      const signIn = authRequest("/api/auth/sign-in/email", {
        email: f.adminEmail,
        password: f.password,
      });
      const signed = await fetch(`${process.url}/api/auth/sign-in/email`, {
        method: signIn.method,
        headers: signIn.headers,
        body: await signIn.text(),
      });
      assertEquals(signed.status, 200, await signed.clone().text());
      await signed.body?.cancel();
    }
    assertEquals(
      (await f.pgDatabase.query(
        'select id from public."user" where email = any($1::text[])',
        [invitedEmails],
      )).rows.length,
      0,
    );
    assertEquals(
      (await createSuperuser({
        pgDatabase: f.pgDatabase,
        config: f.config.auth!,
      }, {
        email: f.adminEmail,
        displayName: "Settings Admin",
        password: f.password,
      })).status,
      "already-complete",
    );
    assertEquals((await readSettings(f)).registrationMode, "closed");
    assertEquals((await grant(f)).status, 201);
  } finally {
    try {
      const closed = await Promise.allSettled(
        processes.map((process) => process.close()),
      );
      assertEquals(
        closed.map((result) => result.status),
        processes.map(() => "fulfilled"),
        "every owned server process closes successfully",
      );
    } finally {
      try {
        await cleanupAuthFixture(f.pgDatabase, warmEmails);
      } finally {
        await f.finish();
      }
    }
  }
});
