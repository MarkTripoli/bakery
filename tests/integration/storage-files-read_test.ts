/**
 * #445: the files read API over the storage tree, through the HTTP routes the
 * files browser uses: the top-level folders, a folder's entries (folders
 * first, keyset paged), a file's versions, its uses, and its bytes by range
 * and as a download of any version. Plus tenancy: another organization cannot
 * read an entry, and another member cannot see my personal folder.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import { signSessionCookie } from "../helpers/auth.ts";

/**
 * Another active developer in the fixture's organization, with a live
 * session, seeded directly (as tests/helpers/durable-questions.ts addMember
 * does) so no second superuser bootstrap runs.
 */
async function addMember(fixture: Fixture) {
  const db = fixture.pgDatabase;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = "member-" + crypto.randomUUID();
  const now = new Date();
  await db.query(
    'insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, $3, true, $4, $4)',
    [
      providerUserId,
      "member",
      "storage-445-" + providerUserId + "@example.test",
      now,
    ],
  );
  await db.query(
    "insert into bakery.principals (id, provider_user_id, display_name, principal_type) values ($1, $2, 'Member', 'human')",
    [principalId, providerUserId],
  );
  await db.query(
    "insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)",
    [crypto.randomUUID(), fixture.organizationId, principalId, now],
  );
  await db.query(
    'insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $5)',
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
    providerUserId,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

/** Removes a member addMember seeded, so later files bootstrap a fresh install. */
async function removeMember(
  fixture: Fixture,
  other: Awaited<ReturnType<typeof addMember>>,
) {
  await fixture.pgDatabase.query(
    "delete from bakery.organization_memberships where organization_id = $1 and principal_id = $2",
    [fixture.organizationId, other.principalId],
  );
  // The member's personal folder is owned by them; remove it first.
  await fixture.pgDatabase.query(
    "delete from bakery.storage_entries where organization_id = $1 and owner_id = $2 and parent_id is not null and kind = 'folder' and system_key like 'user:%:%'",
    [fixture.organizationId, other.principalId],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.storage_entries where organization_id = $1 and owner_id = $2",
    [fixture.organizationId, other.principalId],
  );
  await fixture.pgDatabase.query(
    'delete from public.session where "userId" = $1',
    [other.providerUserId],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.principals where id = $1",
    [other.principalId],
  );
  await fixture.pgDatabase.query(
    'delete from public."user" where id = $1',
    [
      other.providerUserId,
    ],
  );
}

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function call(
  fixture: Fixture,
  method: string,
  path: string,
  options: {
    body?: unknown;
    ifMatch?: number;
    organizationId?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        Cookie: options.cookie ?? fixture.adminCookie,
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
        ...(options.ifMatch === undefined
          ? {}
          : { "If-Match": '"' + options.ifMatch + '"' }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  ));
}

async function ok(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

async function status(response: Response, expected: number) {
  const text = await response.text();
  assertEquals(response.status, expected, text);
}

function put(
  fixture: Fixture,
  path: string,
  content: string,
  options: { ifMatch?: number; organizationId?: string } = {},
) {
  return call(fixture, "PUT", "/v1/storage/files", {
    body: { path, mediaType: "text/plain", content: btoa(content) },
    ...options,
  });
}

const items = (page: Json) => page.items as Json[];

Deno.test("the top of the tree lists my own folder, never /users, and /system only for Admins", () =>
  withWorkerFixture(async (fixture) => {
    const roots = items(
      await ok(await call(fixture, "GET", "/v1/storage/roots")),
    );
    assertEquals(roots.map((root) => root.path), [
      "/projects",
      "/shared",
      "/users/" + fixture.principalId,
      "/library",
      "/trash",
      "/system",
    ]);

    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set role = 'developer' where organization_id = $1 and principal_id = $2",
      [fixture.organizationId, fixture.principalId],
    );
    try {
      const asDeveloper = items(
        await ok(await call(fixture, "GET", "/v1/storage/roots")),
      );
      assertEquals(asDeveloper.some((root) => root.path === "/system"), false);
      // The top-level folders have no parent, so there is no organization
      // root a caller could list to reach /system or /users another way.
      assertEquals(
        roots.filter((root) => root.path !== "/users/" + fixture.principalId)
          .map((root) => root.parentId),
        roots.filter((root) => root.path !== "/users/" + fixture.principalId)
          .map(() => null),
      );
      const system = roots.find((root) => root.path === "/system")!;
      await status(
        await call(
          fixture,
          "GET",
          "/v1/storage/folders/" + system.id + "/entries",
        ),
        404,
      );
    } finally {
      await fixture.pgDatabase.query(
        "update bakery.organization_memberships set role = 'admin' where organization_id = $1 and principal_id = $2",
        [fixture.organizationId, fixture.principalId],
      );
    }

    // /connections shows once something is under it.
    const connections = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = 'connections'",
      [fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy) values ($1, $2, 'drive', 'drive', 'folder', 'working')",
      [fixture.organizationId, connections.rows[0].id],
    );
    const withConnection = items(
      await ok(await call(fixture, "GET", "/v1/storage/roots")),
    );
    assert(withConnection.some((root) => root.path === "/connections"));
  }));

Deno.test("a folder lists folders first, then files by name, keyset paged", () =>
  withWorkerFixture(async (fixture) => {
    for (const name of ["b.md", "a.md", "c.md"]) {
      await ok(await put(fixture, "/shared/" + name, name));
    }
    await ok(
      await call(fixture, "POST", "/v1/storage/folders", {
        body: { path: "/shared/zeta" },
      }),
      201,
    );
    const shared = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = 'shared'",
      [fixture.organizationId],
    );
    const base = "/v1/storage/folders/" + shared.rows[0].id + "/entries";
    const first = await ok(await call(fixture, "GET", base + "?limit=2"));
    assertEquals(items(first).map((item) => item.name), ["zeta", "a.md"]);
    assertEquals(items(first)[0].sizeBytes, null);
    assertEquals(items(first)[1].sizeBytes, 4);
    assertEquals(items(first)[1].path, "/shared/a.md");
    assert(typeof first.nextCursor === "string");
    const second = await ok(
      await call(
        fixture,
        "GET",
        base + "?limit=2&cursor=" +
          encodeURIComponent(first.nextCursor as string),
      ),
    );
    assertEquals(items(second).map((item) => item.name), ["b.md", "c.md"]);
    assertEquals(second.nextCursor, null);
  }));

Deno.test("a file's versions, and bytes by range and as a download of any version", () =>
  withWorkerFixture(async (fixture) => {
    let file = await ok(await put(fixture, "/shared/clip.txt", "version one"));
    file = await ok(
      await put(fixture, "/shared/clip.txt", "version two!", {
        ifMatch: file.version as number,
      }),
    );
    const versions = items(
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + file.id + "/versions",
        ),
      ),
    );
    assertEquals(versions.map((v) => [v.revision, v.isCurrent]), [
      [2, true],
      [1, false],
    ]);
    assertEquals(versions[0].makerKind, "person");
    assertEquals(versions[0].makerPrincipalId, fixture.principalId);
    assertEquals(versions[1].contentRemoved, false);

    const content = "/v1/storage/files/" + file.id + "/content";
    const whole = await call(fixture, "GET", content);
    assertEquals(whole.status, 200);
    assertEquals(await whole.text(), "version two!");
    assert(
      whole.headers.get("Content-Disposition")!.startsWith("attachment;"),
    );
    assertEquals(whole.headers.get("Accept-Ranges"), "bytes");

    const old = await call(fixture, "GET", content + "?revision=1");
    assertEquals(await old.text(), "version one");

    const ranged = await call(fixture, "GET", content, {
      headers: { Range: "bytes=8-11" },
    });
    assertEquals(ranged.status, 206);
    assertEquals(ranged.headers.get("Content-Range"), "bytes 8-11/12");
    assertEquals(await ranged.text(), "two!");

    await status(
      await call(fixture, "GET", content, { headers: { Range: "bytes=99-" } }),
      416,
    );
    await status(await call(fixture, "GET", content + "?revision=9"), 404);

    // A working-area file is never pinned by a run, so it has no uses.
    const uses = await ok(
      await call(fixture, "GET", "/v1/storage/files/" + file.id + "/uses"),
    );
    assertEquals([uses.items, uses.nextCursor], [[], null]);
  }));

Deno.test("another organization cannot read an entry; another member cannot see my personal folder", () =>
  withWorkerFixture(async (fixture) => {
    const mine = await ok(
      await put(
        fixture,
        "/users/" + fixture.principalId + "/uploads/private.txt",
        "mine",
      ),
    );
    const personal = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = $2",
      [fixture.organizationId, "user:" + fixture.principalId],
    );

    // Another organization: every read of my ids is 404 there.
    const foreign = await createWorkerScope(fixture, "storage-445", fixture);
    try {
      for (
        const path of [
          "/v1/storage/folders/" + personal.rows[0].id + "/entries",
          "/v1/storage/files/" + mine.id + "/versions",
          "/v1/storage/files/" + mine.id + "/uses",
          "/v1/storage/files/" + mine.id + "/content",
          "/v1/storage/files/" + mine.id + "/probe?organizationId=" +
          foreign.organizationId,
        ]
      ) {
        await status(
          await call(fixture, "GET", path, {
            organizationId: foreign.organizationId,
          }),
          404,
        );
      }
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }

    // Another member of my organization.
    const other = await addMember(fixture);
    try {
      const as = { cookie: other.cookie };
      const roots = items(
        await ok(await call(fixture, "GET", "/v1/storage/roots", as)),
      );
      assertEquals(
        roots.filter((root) => String(root.path).startsWith("/users/"))
          .map((root) => root.path),
        ["/users/" + other.principalId],
      );
      for (
        const path of [
          "/v1/storage/folders/" + personal.rows[0].id + "/entries",
          "/v1/storage/files/" + mine.id + "/versions",
          "/v1/storage/files/" + mine.id + "/content",
          "/v1/storage/files/" + mine.id + "/probe?organizationId=" +
          fixture.organizationId,
        ]
      ) {
        await status(await call(fixture, "GET", path, as), 404);
      }
      const users = await fixture.pgDatabase.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = 'users'",
        [fixture.organizationId],
      );
      const listed = items(
        await ok(
          await call(
            fixture,
            "GET",
            "/v1/storage/folders/" + users.rows[0].id + "/entries",
            as,
          ),
        ),
      );
      assertEquals(listed.map((item) => item.name), [other.principalId]);
    } finally {
      await removeMember(fixture, other);
    }
  }));

Deno.test("a version id opens its file: revision, current flag, and 404 for anyone who cannot read it", () =>
  withWorkerFixture(async (fixture) => {
    let file = await ok(await put(fixture, "/shared/source.md", "first"));
    file = await ok(
      await put(fixture, "/shared/source.md", "second", {
        ifMatch: file.version as number,
      }),
    );
    const versions = items(
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + file.id + "/versions",
        ),
      ),
    );
    const [current, older] = versions;
    const at = (id: unknown) => "/v1/storage/file-versions/" + id;

    const old = await ok(await call(fixture, "GET", at(older.id)));
    assertEquals(
      [old.versionId, old.revision, old.isCurrent],
      [older.id, 1, false],
    );
    const shown = old.file as Json;
    assertEquals(
      [shown.id, shown.path, shown.kind, shown.sizeBytes],
      [file.id, "/shared/source.md", "file", 6],
    );
    const now = await ok(await call(fixture, "GET", at(current.id)));
    assertEquals([now.revision, now.isCurrent], [2, true]);

    await status(await call(fixture, "GET", at(crypto.randomUUID())), 404);
    // The router rejects a malformed id before the handler, as on every route.
    await status(await call(fixture, "GET", at("not-a-uuid")), 400);

    // Another organization: the same id is not found there.
    const foreign = await createWorkerScope(fixture, "storage-445-v", fixture);
    try {
      await status(
        await call(fixture, "GET", at(older.id), {
          organizationId: foreign.organizationId,
        }),
        404,
      );
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }

    // Another member: a version of my personal file does not exist for them.
    const mine = await ok(
      await put(
        fixture,
        "/users/" + fixture.principalId + "/uploads/note.md",
        "private",
      ),
    );
    const mineVersions = items(
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + mine.id + "/versions",
        ),
      ),
    );
    await ok(await call(fixture, "GET", at(mineVersions[0].id)));
    const other = await addMember(fixture);
    try {
      await status(
        await call(fixture, "GET", at(mineVersions[0].id), {
          cookie: other.cookie,
        }),
        404,
      );
    } finally {
      await removeMember(fixture, other);
    }
  }));
