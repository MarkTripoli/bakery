import { assertEquals } from "@std/assert";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  enrollTotp,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";

function get(path: string, cookie: string): Request {
  return new Request(`${authTestOrigin}${path}`, { headers: { cookie } });
}

Deno.test("revoking a browser session rejects a missing or foreign Origin before touching the session", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `session-origin-${suffix}@example.test`;
  const password = `SessionOrigin-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Session Origin Admin", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const list = await fixture.app.fetch(get("/v1/me/sessions", cookie));
    const { items } = await list.json() as {
      items: Array<{ id: string }>;
    };
    const [{ id }] = items;

    for (const origin of [undefined, "https://attacker.example.test"]) {
      const headers = new Headers({ cookie });
      if (origin) headers.set("origin", origin);
      const response = await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/me/sessions/${id}`, {
          method: "DELETE",
          headers,
        }),
      );
      assertEquals(response.status, 403);
      assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
    }

    const stillListed = await fixture.app.fetch(get("/v1/me/sessions", cookie));
    assertEquals(
      (await stillListed.json() as { items: unknown[] }).items.length,
      1,
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a session with no recorded factor evidence cannot list or revoke browser sessions", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `session-pending-${suffix}@example.test`;
  const password = `SessionPending-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Session Pending Admin", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const unenrolledIdentity = await fixture.app.fetch(
      get("/v1/me", sessionCookie(signIn)),
    );
    assertEquals(unenrolledIdentity.status, 200);
    const unenrolled = await unenrolledIdentity.json();
    assertEquals(unenrolled.twoFactorEnabled, false);
    assertEquals(unenrolled.backupCodesRemaining, null);
    assertEquals(unenrolled.email, email);

    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const enrolledIdentity = await fixture.app.fetch(
      get("/v1/me", enrolled.cookie),
    );
    assertEquals(enrolledIdentity.status, 200);
    const identity = await enrolledIdentity.json();
    assertEquals(identity.twoFactorEnabled, true);
    assertEquals(identity.backupCodesRemaining, enrolled.backupCodes.length);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const token = `session-pending-token-${suffix}`;
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        token,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const pendingCookie = await signSessionCookie(
      token,
      fixture.config.auth!.secret,
    );

    const list = await fixture.app.fetch(get("/v1/me/sessions", pendingCookie));
    assertEquals(list.status, 401);
    assertEquals((await list.json()).code, AuthProblemCode.FactorRequired);

    const revoke = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/me/sessions/${crypto.randomUUID()}`,
        {
          method: "DELETE",
          headers: { cookie: pendingCookie, origin: authTestOrigin },
        },
      ),
    );
    assertEquals(revoke.status, 401);
    assertEquals((await revoke.json()).code, AuthProblemCode.FactorRequired);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
