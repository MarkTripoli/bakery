import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";

/**
 * Adds a second, signed-in teammate to the signed-in admin's organization for
 * `apps/web/tests/shared-conversation-real-api.spec.ts`, as the database owner:
 * a human principal with the Developer role and a live browser session. The
 * seed is idempotent per teammate email. Prints one JSON line with the ids and
 * the signed `better-auth.session_token` cookie value the browser context
 * presents (signed with `BETTER_AUTH_SECRET`, like the server verifies it).
 *
 * Usage: `web-member-seed.ts <adminEmail> <memberEmail> <displayName>` against
 * the stack named by `DATABASE_URL` (the owner URL `compose-up.sh` writes).
 */
/** Signs the raw token the way `readSignedSessionToken` verifies it. */
async function signSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `better-auth.session_token=${token}.${btoa(binary)}`;
}

const [adminEmail, memberEmail, displayName] = Deno.args.map((value) =>
  value.trim()
);
if (!adminEmail || !memberEmail || !displayName) {
  console.error(
    "web-member-seed: usage: web-member-seed.ts <adminEmail> <memberEmail> <displayName>",
  );
  Deno.exit(2);
}
const secret = Deno.env.get("BETTER_AUTH_SECRET");
if (!secret) {
  console.error("web-member-seed: BETTER_AUTH_SECRET is required");
  Deno.exit(2);
}
const database = openPgDatabase(
  readDatabaseConfig(Deno.env.toObject(), "owner").url,
);
try {
  const scope = (await database.query<{ organizationId: string }>(
    `select membership.organization_id as "organizationId"
       from bakery.principals principal
       join public."user" provider_user on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships membership on membership.principal_id = principal.id
      where provider_user.email = $1`,
    [adminEmail.toLowerCase()],
  )).rows[0];
  if (!scope) throw new Error("WEB_MEMBER_ADMIN_SCOPE_REQUIRED");
  const email = memberEmail.toLowerCase();
  const now = new Date();
  let providerUserId = (await database.query<{ id: string }>(
    `select id from public."user" where email = $1`,
    [email],
  )).rows[0]?.id;
  let principalId: string;
  if (providerUserId === undefined) {
    providerUserId = crypto.randomUUID();
    principalId = crypto.randomUUID();
    await database.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, true, $4, $4)`,
      [providerUserId, displayName, email, now],
    );
    await database.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, $3, 'human')`,
      [principalId, providerUserId, displayName],
    );
    await database.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), scope.organizationId, principalId, now],
    );
  } else {
    principalId = (await database.query<{ id: string }>(
      `select id from bakery.principals where provider_user_id = $1`,
      [providerUserId],
    )).rows[0].id;
  }
  const token = `web-member-${crypto.randomUUID()}`;
  await database.query(
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
  const cookie = await signSessionCookie(token, secret);
  console.log(JSON.stringify({
    organizationId: scope.organizationId,
    principalId,
    displayName,
    cookieName: "better-auth.session_token",
    cookieValue: cookie.slice("better-auth.session_token=".length),
  }));
} finally {
  await closePgDatabase(database);
}
