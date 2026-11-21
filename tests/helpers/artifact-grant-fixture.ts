import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { authTestOrigin, signSessionCookie } from "./auth.ts";
import type { DraftFixture } from "./draft-fixture.ts";

/**
 * Guests for the document-grant tests: people whose only role is "chat only",
 * so a document grant is the one thing that opens a document to them, and a
 * second document in the same task to show a grant stops at its own.
 */

export type Guest = {
  providerUserId: string;
  principalId: string;
  sessionToken: string;
  cookie: string;
  displayName: string;
};

/** A custom role that reads conversations and notifications and nothing about documents. */
export async function chatOnlyRole(fixture: DraftFixture): Promise<string> {
  const roleId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.organization_roles
       (id, organization_id, key, name, permissions, created_by_principal_id)
     values ($1, $2, 'chat-only', 'Chat only', $3::text[], $4)`,
    [
      roleId,
      fixture.ids.organizationId,
      ["conversation:read", "notification:read"],
      fixture.ids.principalId,
    ],
  );
  return roleId;
}

/** A signed-in guest of the fixture's organization holding the given custom role. */
export async function addGuest(
  fixture: DraftFixture,
  displayName: string,
  roleId: string,
): Promise<Guest> {
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const now = new Date();
  const db = fixture.pgDatabase;
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, $4, $4)`,
    [providerUserId, displayName, `grant-${providerUserId}@example.test`, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, $3, 'human')`,
    [principalId, providerUserId, displayName],
  );
  await db.query(
    `insert into public.member (id, "organizationId", "userId", role, status, "createdAt", "joinedAt", "updatedAt")
     values ($1, $2, $3, 'member', 'active', $4, $4, $4)`,
    [crypto.randomUUID(), fixture.ids.organizationId, providerUserId, now],
  );
  await db.query(
    `insert into bakery.organization_memberships
       (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version, custom_role_id)
     values ($1, $2, $3, 'guest', 'active', $4, $4, $4, 1, $5)`,
    [crypto.randomUUID(), fixture.ids.organizationId, principalId, now, roleId],
  );
  await db.query(
    `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      sessionToken,
      providerUserId,
      new Date(Date.now() + 3_600_000),
      now,
    ],
  );
  return {
    providerUserId,
    principalId,
    sessionToken,
    cookie: await signSessionCookie(sessionToken, fixture.config.auth!.secret),
    displayName,
  };
}

/** Removes the guests' rows; the fixture's own cleanup does not know them. */
export async function removeGuests(
  fixture: DraftFixture,
  guests: readonly Guest[],
): Promise<void> {
  const db = fixture.pgDatabase;
  for (const guest of guests) {
    await db.query('delete from public.session where "userId" = $1', [
      guest.providerUserId,
    ]).catch(() => {});
    await db.query('delete from public.member where "userId" = $1', [
      guest.providerUserId,
    ]).catch(() => {});
    await db.query("delete from bakery.principals where id = $1", [
      guest.principalId,
    ]).catch(() => {});
    await db.query('delete from public."user" where id = $1', [
      guest.providerUserId,
    ]).catch(() => {});
  }
}

/** A second document in the fixture's task, with one published version. */
export async function secondDocument(
  fixture: DraftFixture,
): Promise<{ artifactId: string; versionId: string }> {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode("bravo secret text");
  const db = fixture.pgDatabase;
  const ids = fixture.ids;
  await db.query(
    `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name, revision, version)
     values ($1, $2, $3, 'plan', 'doc B', 1, 1)`,
    [artifactId, ids.organizationId, ids.taskId],
  );
  await db.query(
    `insert into bakery.artifact_versions
       (id, organization_id, artifact_id, task_id, author_id, revision, metadata, content, sha256, size_bytes, media_type)
     values ($1, $2, $3, $4, $5, 1, '{}'::jsonb, $6, $7, $8, 'text/markdown')`,
    [
      versionId,
      ids.organizationId,
      artifactId,
      ids.taskId,
      ids.principalId,
      content,
      await sha256Bytes(content),
      content.length,
    ],
  );
  await db.query(
    `update bakery.artifacts set current_version_id = $3
      where organization_id = $1 and id = $2`,
    [ids.organizationId, artifactId, versionId],
  );
  return { artifactId, versionId };
}

/** One request to the fixture's app as a signed-in person; returns the status and parsed body. */
export async function callAs(
  fixture: DraftFixture,
  who: { cookie: string },
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const headers = new Headers({
    cookie: who.cookie,
    origin: authTestOrigin,
    "Bakery-Organization-Id": fixture.ids.organizationId,
    ...extraHeaders,
  });
  if (method !== "GET") {
    headers.set("content-type", "application/json");
    if (!headers.has("idempotency-key")) {
      headers.set("idempotency-key", crypto.randomUUID());
    }
  }
  const response = await fixture.app.fetch(
    new Request(authTestOrigin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the text is what there is
  }
  return { status: response.status, text, json };
}
