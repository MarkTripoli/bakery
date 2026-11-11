import { assert, assertEquals } from "@std/assert";
import { catalogVersion } from "../../packages/i18n/src/index.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { AuthErrorCode } from "../../apps/server/src/modules/auth/domain/errors.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

Deno.test("createSuperuser and existing-user sign-in stay exempt from closed installation registration", async () => {
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "closed",
      organizationCreationPolicy: "installation_admins",
    },
  });
  const suffix = crypto.randomUUID();
  const email = `step7-admin-${suffix}@example.test`;
  const password = `Step7-${suffix}`;
  try {
    const result = await createSuperuser(
      { pgDatabase: fixture.pgDatabase, config: fixture.config.auth! },
      { email, displayName: "Step 7 Admin", password },
    );
    assertEquals(result.status, "completed");

    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200, await signIn.clone().text());
    const cookie = sessionCookie(signIn);

    const principal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [email],
    );
    const principalId = principal.rows[0].id;

    const identity = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, { headers: { cookie } }),
    );
    assertEquals(identity.status, 200);
    assertEquals(await identity.json(), {
      principalId,
      principalType: "human",
      displayName: "Step 7 Admin",
      locale: "en",
      direction: "ltr",
      catalogVersion,
      twoFactorEnabled: false,
      timeZone: null,
      email,
      backupCodesRemaining: null,
    });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("installation registration gates invited sign-up and changes live within one running process", async () => {
  const providerLogs: string[] = [];
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "closed",
      organizationCreationPolicy: "installation_admins",
    },
    log: (code) => providerLogs.push(code),
  });
  const suffix = crypto.randomUUID();
  const founderEmail = `step7-founder-${suffix}@example.test`;
  const password = `Step7-${suffix}`;
  const firstInvitedEmail = `step7-first-invited-${suffix}@example.test`;
  const secondInvitedEmail = `step7-second-invited-${suffix}@example.test`;
  try {
    await createSuperuser(
      { pgDatabase: fixture.pgDatabase, config: fixture.config.auth! },
      { email: founderEmail, displayName: "Step 7 Founder", password },
    );
    const bootstrap = await createPostgresAuthPersistence(fixture.pgDatabase)
      .withBootstrapLock((transaction) => transaction.inspect());
    const organizationId = bootstrap.organizations[0].id;

    const founderSignIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: founderEmail, password },
    ));
    assertEquals(founderSignIn.status, 200, await founderSignIn.clone().text());
    const founderCookie = sessionCookie(founderSignIn);

    const invitationHeaders = {
      cookie: founderCookie,
      origin: authTestOrigin,
      "content-type": "application/json",
      "Bakery-Organization-Id": organizationId,
    };
    const invitationPath =
      `${authTestOrigin}/v1/organizations/${organizationId}/invitations`;
    const userCount = async (email: string) =>
      (await fixture.pgDatabase.query<{ count: number }>(
        'select count(*)::int as count from public."user" where email = $1',
        [email],
      )).rows[0].count;

    const firstInvitation = await fixture.app.fetch(
      new Request(invitationPath, {
        method: "POST",
        headers: invitationHeaders,
        body: JSON.stringify({ email: firstInvitedEmail, role: "developer" }),
      }),
    );
    assertEquals(
      firstInvitation.status,
      201,
      await firstInvitation.clone().text(),
    );

    const deniedSignUp = await fixture.auth.handler(authRequest(
      "/api/auth/sign-up/email",
      { email: firstInvitedEmail, password, name: "First Invited" },
    ));
    assertEquals(deniedSignUp.status, 200);
    assertEquals((await deniedSignUp.json()).token, null);
    assertEquals(await userCount(firstInvitedEmail), 0);

    await fixture.pgDatabase.query(
      "update bakery.installation_settings set registration_mode = 'invitation', version = version + 1 where id = true",
    );
    const allowedSignUp = await fixture.auth.handler(authRequest(
      "/api/auth/sign-up/email",
      { email: firstInvitedEmail, password, name: "First Invited" },
    ));
    assertEquals(
      allowedSignUp.status,
      200,
      await allowedSignUp.clone().text(),
    );
    assertEquals(await userCount(firstInvitedEmail), 1);

    await fixture.pgDatabase.query(
      "update bakery.installation_settings set registration_mode = 'closed', version = version + 1 where id = true",
    );
    const secondInvitation = await fixture.app.fetch(
      new Request(invitationPath, {
        method: "POST",
        headers: invitationHeaders,
        body: JSON.stringify({
          email: secondInvitedEmail,
          role: "developer",
        }),
      }),
    );
    assertEquals(
      secondInvitation.status,
      201,
      await secondInvitation.clone().text(),
    );
    const secondDeniedSignUp = await fixture.auth.handler(authRequest(
      "/api/auth/sign-up/email",
      { email: secondInvitedEmail, password, name: "Second Invited" },
    ));
    assertEquals(secondDeniedSignUp.status, 200);
    assertEquals((await secondDeniedSignUp.json()).token, null);
    assertEquals(await userCount(secondInvitedEmail), 0);

    assertEquals(
      providerLogs.filter((code) => code === AuthErrorCode.SignupsDisabled)
        .length,
      2,
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      founderEmail,
      firstInvitedEmail,
      secondInvitedEmail,
    ]);
    await fixture.close();
  }
});

Deno.test("databaseHooks.user.create.before rejects closed registration and exempts CLI-only calls", async () => {
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "closed",
      organizationCreationPolicy: "installation_admins",
    },
  });
  try {
    const before = fixture.auth.options.databaseHooks?.user?.create?.before;
    assert(before, "expected a user.create.before database hook");
    const user = {
      id: crypto.randomUUID(),
      email: "step7-backstop@example.test",
      name: "Backstop",
    };

    assertEquals(
      await before(user as never, {
        request: new Request(
          "https://bakery.example.test/api/auth/sign-up/email",
        ),
      } as never),
      false,
    );
    assertEquals(
      await before(user as never, { request: undefined } as never),
      undefined,
    );
    // A missing endpoint context is not a CLI claim. `createWithHooks` reads
    // the context from async local storage, where it can be absent, so this
    // input must still clear the flag rather than be waved through.
    assertEquals(await before(user as never, undefined as never), false);
  } finally {
    await fixture.close();
  }
});

Deno.test("persisted preferred_locale outranks Accept-Language, falls through when unsupported, and never leaks a malformed value", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `step7-locale-${suffix}@example.test`;
  const password = `Step7-${suffix}`;
  try {
    await createSuperuser(
      { pgDatabase: fixture.pgDatabase, config: fixture.config.auth! },
      { email, displayName: "Step 7 Locale", password },
    );
    const principal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [email],
    );
    const principalId = principal.rows[0].id;

    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200, await signIn.clone().text());
    const cookie = sessionCookie(signIn);
    const identity = (acceptLanguage: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/me`, {
          headers: { cookie, "accept-language": acceptLanguage },
        }),
      );
    const setPreferredLocale = (value: string) =>
      fixture.pgDatabase.query(
        "update bakery.principals set preferred_locale = $2 where id = $1",
        [principalId, value],
      );

    await setPreferredLocale("ar-XB");
    const preferred = await identity("en");
    assertEquals(preferred.status, 200);
    const preferredBody = await preferred.json();
    assertEquals(preferredBody.locale, "ar-XB");
    assertEquals(preferredBody.direction, "rtl");

    await setPreferredLocale("fr");
    const fallthrough = await identity("en-XA");
    assertEquals(fallthrough.status, 200);
    const fallthroughBody = await fallthrough.json();
    assertEquals(fallthroughBody.locale, "en-XA");
    assertEquals(fallthroughBody.direction, "ltr");

    await setPreferredLocale("not a tag!");
    const malformed = await identity("ar-XB");
    assertEquals(malformed.status, 200);
    const malformedText = await malformed.clone().text();
    assert(!malformedText.includes("not a tag!"), malformedText);
    const malformedBody = await malformed.json();
    assertEquals(malformedBody.locale, "ar-XB");
    assertEquals(malformedBody.direction, "rtl");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("migration 0022 adds the locale columns and 0070 leaves default_locale unset until an Admin chooses one", async () => {
  const fixture = await openAuthFixture();
  const organizationId = crypto.randomUUID();
  try {
    const columns = await fixture.pgDatabase.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'bakery'
         and ((table_name = 'principals' and column_name = 'preferred_locale')
           or (table_name = 'organizations' and column_name = 'default_locale'))`,
    );
    assertEquals(columns.rowCount, 2);

    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values ($1, 'Step 7 Locale Org', $2, '{}'::jsonb, $3, $3, 1)`,
      [organizationId, `step7-locale-org-${organizationId}`, now],
    );
    const inserted = await fixture.pgDatabase.query<
      { default_locale: string | null }
    >(
      "select default_locale from bakery.organizations where id = $1",
      [organizationId],
    );
    assertEquals(inserted.rows[0].default_locale, null);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [organizationId],
    ).catch(() => undefined);
    await fixture.close();
  }
});
