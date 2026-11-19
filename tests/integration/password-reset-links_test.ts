import { assert, assertEquals, assertMatch } from "@std/assert";
import { createHash } from "node:crypto";
import {
  authRequest,
  call,
  type InstallationFixture,
  openInstallationFixture,
  signIn,
} from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";

/** A distinct client address per test, so the per-address limit never couples tests. */
function client(): { remoteAddr: Deno.NetAddr } {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  return {
    remoteAddr: {
      transport: "tcp",
      hostname: `10.${octet()}.${octet()}.${octet()}`,
      port: 40000,
    },
  };
}

async function issue(f: InstallationFixture, cookie = f.adminCookie) {
  return await call(f, "POST", "/v1/installation/password-resets", cookie, {
    body: { principalId: f.developerId },
  });
}

async function issueUrl(f: InstallationFixture) {
  const response = await issue(f);
  assertEquals(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    id: string;
    url: string;
    expiresAt: string;
  };
  const token = new URL(body.url).searchParams.get("token")!;
  return { ...body, token };
}

async function redeem(
  f: InstallationFixture,
  env: { remoteAddr: Deno.NetAddr },
  token: string,
  newPassword: string,
) {
  return await f.app.fetch(
    authRequest("/v1/password-resets/redemptions", { token, newPassword }, {
      origin: null,
    }),
    env,
  );
}

/** The refusal with its per-request correlation removed. */
async function refusal(response: Response) {
  const { requestId: _r, traceId: _t, instance: _i, ...rest } = await response
    .json();
  return { status: response.status, ...rest };
}

async function withFixture(
  run: (f: InstallationFixture) => Promise<void>,
) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await f.pgDatabase.query(
      `delete from public."rateLimit" where key like 'bakery-password-reset:%'`,
    );
    await f.finish();
  }
}

Deno.test("an installation administrator gets the link once and only its digest is stored", async () => {
  await withFixture(async (f) => {
    const link = await issueUrl(f);
    assertEquals(
      `${new URL(link.url).origin}${new URL(link.url).pathname}`,
      `${new URL(authTestOrigin).origin}/sign-in/reset-password`,
    );
    assertMatch(link.token, /^[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(link.expiresAt) - Date.now();
    assert(ttl > 59 * 60_000 && ttl <= 60 * 60_000, String(ttl));
    const stored = await f.pgDatabase.query<Record<string, unknown>>(
      "select * from bakery.password_reset_links where id = $1",
      [link.id],
    );
    assertEquals(stored.rows.length, 1);
    assertEquals(
      stored.rows[0].token_hash,
      createHash("sha256").update(link.token).digest("hex"),
    );
    assertEquals(stored.rows[0].principal_id, f.developerId);
    assertEquals(stored.rows[0].issued_by_principal_id, f.adminId);
    assert(!JSON.stringify(stored.rows[0]).includes(link.token));
    const audit = await f.pgDatabase.query<{ details: unknown }>(
      `select details from bakery.audit_events
       where operation = 'passwordResetLinks.create' and resource_id = $1`,
      [link.id],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(
      (audit.rows[0].details as { targetPrincipalId: string })
        .targetPrincipalId,
      f.developerId,
    );
    assert(!JSON.stringify(audit.rows[0].details).includes(link.token));
  });
});

Deno.test("a person who is not an installation administrator cannot issue a link", async () => {
  await withFixture(async (f) => {
    const response = await issue(f, f.developerCookie);
    assertEquals(response.status, 403, await response.clone().text());
    const rows = await f.pgDatabase.query(
      "select 1 from bakery.password_reset_links where principal_id = $1",
      [f.developerId],
    );
    assertEquals(rows.rows.length, 0);
  });
});

Deno.test("a link redeems once, changes the password and signs the person out everywhere", async () => {
  await withFixture(async (f) => {
    const env = client();
    const link = await issueUrl(f);
    const me = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: f.developerCookie },
      }),
    );
    assertEquals(me.status, 200);
    const newPassword = `Reset-${crypto.randomUUID()}`;
    const redeemed = await redeem(f, env, link.token, newPassword);
    assertEquals(redeemed.status, 204, await redeemed.clone().text());
    const sessions = await f.pgDatabase.query(
      `select 1 from public.session as session
       join bakery.principals as principal
         on principal.provider_user_id = session."userId"
       where principal.id = $1`,
      [f.developerId],
    );
    assertEquals(sessions.rows.length, 0);
    const after = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: f.developerCookie },
      }),
    );
    assertEquals(after.status, 401);
    await signIn(f, f.developerEmail, newPassword);
    const old = await f.app.fetch(
      authRequest("/api/auth/sign-in/email", {
        email: f.developerEmail,
        password: f.password,
      }),
    );
    assertEquals(old.status, 401);
    const audit = await f.pgDatabase.query<
      { principalId: string; details: { revokedSessionCount: number } }
    >(
      `select principal_id as "principalId", details from bakery.audit_events
       where operation = 'passwordResets.redeem' and resource_id = $1`,
      [link.id],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].principalId, f.developerId);
    assert(audit.rows[0].details.revokedSessionCount >= 1);
    assert(!JSON.stringify(audit.rows[0].details).includes(link.token));
  });
});

Deno.test("used, expired, revoked and unknown links get the identical refusal", async () => {
  await withFixture(async (f) => {
    const env = client();
    const password = () => `Reset-${crypto.randomUUID()}`;
    const used = await issueUrl(f);
    assertEquals((await redeem(f, env, used.token, password())).status, 204);
    const usedRefusal = await refusal(
      await redeem(f, env, used.token, password()),
    );

    const expired = await issueUrl(f);
    await f.pgDatabase.query(
      "update bakery.password_reset_links set expires_at = now() - interval '1 second' where id = $1",
      [expired.id],
    );
    const expiredRefusal = await refusal(
      await redeem(f, env, expired.token, password()),
    );

    const revoked = await issueUrl(f);
    const replacement = await issueUrl(f);
    const revokedRefusal = await refusal(
      await redeem(f, env, revoked.token, password()),
    );
    const unknownRefusal = await refusal(
      await redeem(f, env, "not-a-real-token", password()),
    );

    assertEquals(usedRefusal.status, 404);
    assertEquals(usedRefusal.code, "RESOURCE_NOT_FOUND");
    assertEquals(expiredRefusal, usedRefusal);
    assertEquals(revokedRefusal, usedRefusal);
    assertEquals(unknownRefusal, usedRefusal);
    assertEquals(
      (await redeem(f, env, replacement.token, password())).status,
      204,
    );
  });
});

Deno.test("a too-short password is refused without consuming the link", async () => {
  await withFixture(async (f) => {
    const env = client();
    const link = await issueUrl(f);
    const weak = await redeem(f, env, link.token, "short");
    assertEquals(weak.status, 422, await weak.clone().text());
    const problem = await weak.json();
    assertEquals(problem.code, "UNPROCESSABLE");
    assertEquals(problem.issues[0].code, "password_too_short");
    const stored = await f.pgDatabase.query<{ usedAt: Date | null }>(
      'select used_at as "usedAt" from bakery.password_reset_links where id = $1',
      [link.id],
    );
    assertEquals(stored.rows[0].usedAt, null);
    await signIn(f, f.developerEmail, f.password);
    const strong = await redeem(
      f,
      env,
      link.token,
      `Reset-${crypto.randomUUID()}`,
    );
    assertEquals(strong.status, 204, await strong.clone().text());
  });
});

Deno.test("redemption attempts are rate limited per client address", async () => {
  await withFixture(async (f) => {
    const env = client();
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const response = await redeem(
        f,
        env,
        `unknown-${crypto.randomUUID()}`,
        "Reset-password-1",
      );
      if (response.status === 429) limited = response;
      else {
        assertEquals(response.status, 404);
        await response.body?.cancel();
      }
    }
    assert(limited, "an address is limited within twelve attempts");
    const problem = await limited.json();
    assertEquals(problem.code, "RATE_LIMITED");
    assert(problem.retryAfterSeconds >= 1 && problem.retryAfterSeconds <= 60);
  });
});
