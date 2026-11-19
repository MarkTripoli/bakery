import { assertEquals } from "@std/assert";
import {
  authTestOrigin,
  cleanupAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";

/**
 * #458: organization groups. Any member reads them, only an Admin changes them,
 * the handle is fixed at creation, and role handles are reserved. Real routes
 * and real Postgres.
 */

type Group = {
  id: string;
  name: string;
  mentionName: string;
  purpose: string | null;
  members: { principalId: string; displayName: string }[];
  memberCount: number;
  version: number;
};

function api(
  fixture: SocketFixture,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  ifMatch?: number,
): Promise<Response> {
  const headers = new Headers({
    cookie,
    "Bakery-Organization-Id": fixture.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  if (ifMatch !== undefined) headers.set("If-Match", `"${ifMatch}"`);
  return Promise.resolve(fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

async function ok<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return (text === "" ? null : JSON.parse(text)) as T;
}

async function addMember(
  fixture: SocketFixture,
  label: string,
  role = "developer",
): Promise<{ principalId: string; cookie: string; email: string }> {
  const db = fixture.pgDatabase;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `member-${crypto.randomUUID()}`;
  const now = new Date();
  const email = `${label}-${providerUserId}@example.test`;
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, $4, $4)`,
    [providerUserId, label, email, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, $3, 'human')`,
    [principalId, providerUserId, label],
  );
  await db.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, $5, 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, now, role],
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
    principalId,
    email,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

Deno.test("an admin makes, changes and deletes a group; a member only reads", async () => {
  const fixture = await openSocketFixture();
  const sam = await addMember(fixture, "Sam");
  const kim = await addMember(fixture, "Kim");
  try {
    const admin = fixture.cookie;
    const create = (body: Record<string, unknown>) =>
      api(fixture, admin, "POST", "/v1/groups", body);

    const made = await ok<Group>(
      await create({
        name: "Design reviewers",
        mentionName: "design-reviewers",
        purpose: "Look at UI changes",
        memberIds: [sam.principalId],
      }),
      201,
    );
    assertEquals(made.mentionName, "design-reviewers");
    assertEquals(made.memberCount, 1);
    assertEquals(made.members[0].displayName, "Sam");

    // Refusals, each by its own reason.
    assertEquals(
      (await create({ name: "DESIGN REVIEWERS", mentionName: "other-one" }))
        .status,
      409,
    );
    assertEquals(
      (await create({ name: "Another", mentionName: "design-reviewers" }))
        .status,
      409,
    );
    // A role's handle is reserved, so asking @admins always means the role.
    assertEquals(
      (await create({ name: "Bosses", mentionName: "admins" })).status,
      409,
    );
    assertEquals(
      (await create({ name: "Bad handle", mentionName: "Not Valid" })).status,
      422,
    );
    // A stranger, not a member of this organization, cannot be added.
    assertEquals(
      (await create({
        name: "Strangers",
        mentionName: "strangers",
        memberIds: [crypto.randomUUID()],
      })).status,
      422,
    );

    // The list carries the group and the groups made from roles, read live.
    const read = await ok<{
      groups: Group[];
      fromRoles: { mentionName: string; memberCount: number }[];
    }>(await api(fixture, sam.cookie, "GET", "/v1/groups"), 200);
    assertEquals(read.groups.map((group) => group.mentionName), [
      "design-reviewers",
    ]);
    const handles = read.fromRoles.map((role) => role.mentionName);
    assertEquals(handles.includes("admins"), true);
    assertEquals(handles.includes("developers"), true);
    assertEquals(
      read.fromRoles.find((role) => role.mentionName === "developers")
        ?.memberCount,
      2,
    );

    // A member who is not an admin reads but cannot change.
    assertEquals(
      (await api(fixture, sam.cookie, "POST", "/v1/groups", {
        name: "Mine",
        mentionName: "mine",
      })).status,
      403,
    );
    assertEquals(
      (await api(fixture, sam.cookie, "PATCH", `/v1/groups/${made.id}`, {
        name: "Renamed",
      }, made.version)).status,
      403,
    );
    assertEquals(
      (await api(
        fixture,
        sam.cookie,
        "DELETE",
        `/v1/groups/${made.id}`,
        undefined,
        made.version,
      )).status,
      403,
    );

    // Update needs If-Match, refuses a stale one, and never moves the handle.
    const path = `/v1/groups/${made.id}`;
    assertEquals(
      (await api(fixture, admin, "PATCH", path, { name: "X" })).status,
      428,
    );
    assertEquals(
      (await api(
        fixture,
        admin,
        "PATCH",
        path,
        { name: "X" },
        made.version + 5,
      ))
        .status,
      412,
    );
    assertEquals(
      (await api(fixture, admin, "PATCH", path, {
        mentionName: "renamed",
      }, made.version)).status >= 400,
      true,
    );
    const updated = await ok<Group>(
      await api(fixture, admin, "PATCH", path, {
        name: "UI reviewers",
        purpose: null,
        memberIds: [sam.principalId, kim.principalId],
      }, made.version),
      200,
    );
    assertEquals(updated.mentionName, "design-reviewers");
    assertEquals(updated.name, "UI reviewers");
    assertEquals(updated.purpose, null);
    assertEquals(updated.memberCount, 2);
    assertEquals(updated.version, made.version + 1);

    // Replacing the member set removes the people no longer named.
    const shrunk = await ok<Group>(
      await api(fixture, admin, "PATCH", path, {
        memberIds: [],
      }, updated.version),
      200,
    );
    assertEquals(shrunk.memberCount, 0);

    // Delete: stale version refused, then removed.
    assertEquals(
      (await api(fixture, admin, "DELETE", path, undefined, made.version))
        .status,
      412,
    );
    await ok(
      await api(fixture, admin, "DELETE", path, undefined, shrunk.version),
      204,
    );
    const after = await ok<{ groups: Group[] }>(
      await api(fixture, admin, "GET", "/v1/groups"),
      200,
    );
    assertEquals(after.groups.length, 0);
    const members = await fixture.pgDatabase.query(
      `select 1 from bakery.organization_group_members
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(members.rows.length, 0);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      fixture.email,
      sam.email,
      kim.email,
    ]);
    await fixture.close();
  }
});

Deno.test("two creates racing for one name both answer cleanly: one wins, one conflicts", async () => {
  const fixture = await openSocketFixture();
  try {
    const attempt = () =>
      api(fixture, fixture.cookie, "POST", "/v1/groups", {
        name: "Design reviewers",
        mentionName: "design-reviewers",
      });
    const statuses = (await Promise.all([attempt(), attempt(), attempt()]))
      .map((response) => response.status)
      .sort();
    // Never a 500: the loser of the race gets the same conflict the pre-check
    // gives.
    assertEquals(statuses, [201, 409, 409]);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a member whose membership went inactive is not listed or counted, and returns on reactivation", async () => {
  const fixture = await openSocketFixture();
  const sam = await addMember(fixture, "Sam");
  try {
    const made = await ok<Group>(
      await api(fixture, fixture.cookie, "POST", "/v1/groups", {
        name: "Reviewers",
        mentionName: "reviewers",
        memberIds: [sam.principalId],
      }),
      201,
    );
    assertEquals(made.memberCount, 1);
    const setStatus = (status: string) =>
      fixture.pgDatabase.query(
        `update bakery.organization_memberships set status = $3
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, sam.principalId, status],
      );
    const read = async () =>
      (await ok<{ groups: Group[] }>(
        await api(fixture, fixture.cookie, "GET", "/v1/groups"),
        200,
      )).groups[0];
    await setStatus("inactive");
    assertEquals((await read()).memberCount, 0);
    assertEquals((await read()).members, []);
    await setStatus("active");
    assertEquals((await read()).memberCount, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email, sam.email]);
    await fixture.close();
  }
});
