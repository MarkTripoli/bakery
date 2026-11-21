/**
 * #445: file search over the files people write into working, personal and
 * scratch areas, through the real route. The same visibility rule as the
 * storage reads decides who finds what: another member's personal file is
 * never a hit, a trashed file is not a hit, /system is an Admin's, and nothing
 * crosses organizations.
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
  // Their writes left idempotency records; the principal FK is restrict.
  await fixture.pgDatabase.query(
    "delete from bakery.idempotency_records where principal_id = $1",
    [other.principalId],
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

const put = (
  fixture: Fixture,
  path: string,
  content: string,
  options: { cookie?: string; organizationId?: string; mediaType?: string } =
    {},
) =>
  call(fixture, "PUT", "/v1/storage/files", {
    body: {
      path,
      mediaType: options.mediaType ?? "text/plain",
      content: btoa(content),
    },
    cookie: options.cookie,
    organizationId: options.organizationId,
  });

/** The paths a search finds, newest first. */
async function found(
  fixture: Fixture,
  query: string,
  as: { cookie?: string; organizationId?: string } = {},
): Promise<string[]> {
  const page = await ok(
    await call(fixture, "GET", "/v1/files/search?" + query, as),
  );
  return (page.items as Json[]).map((hit) => String(hit.path));
}

Deno.test("search finds files written into working areas, with their filters", () =>
  withWorkerFixture(async (fixture) => {
    await ok(await put(fixture, "/shared/launch-plan.md", "the plan"));
    await ok(await put(fixture, "/shared/launch-notes.txt", "notes"));
    await ok(
      await put(fixture, "/shared/launch-logo.png", "png", {
        mediaType: "image/png",
      }),
    );

    assertEquals(
      new Set(await found(fixture, "query=launch")),
      new Set([
        "/shared/launch-plan.md",
        "/shared/launch-notes.txt",
        "/shared/launch-logo.png",
      ]),
    );
    // Name, case-insensitively.
    assertEquals(await found(fixture, "query=PLAN"), [
      "/shared/launch-plan.md",
    ]);
    // What the hit says about the file.
    const page = await ok(
      await call(fixture, "GET", "/v1/files/search?query=launch-plan"),
    );
    const hit = (page.items as Json[])[0];
    assertEquals(
      [hit.source, hit.kind, hit.mediaType, hit.mediaGroup, hit.sizeBytes],
      ["files", "file", "text/plain", "text", 8],
    );
    assertEquals(hit.producerKind, "person");
    assert(typeof hit.producerName === "string" && hit.producerName !== "");
    assert(hit.versionId !== null && hit.entryId !== null);
    // Filters: media type and group, kind, folder, producer.
    assertEquals(await found(fixture, "query=launch&mediaType=image/png"), [
      "/shared/launch-logo.png",
    ]);
    assertEquals(await found(fixture, "query=launch&mediaGroup=image"), [
      "/shared/launch-logo.png",
    ]);
    assertEquals((await found(fixture, "query=launch&kind=file")).length, 3);
    assertEquals(await found(fixture, "query=launch&kind=plan"), []);
    assertEquals((await found(fixture, "query=launch&path=/shared")).length, 3);
    assertEquals(await found(fixture, "query=launch&path=/projects"), []);
    assertEquals(
      (await found(
        fixture,
        "query=launch&producerId=" + fixture.principalId,
      )).length,
      3,
    );
    assertEquals(
      await found(fixture, "query=launch&producerId=" + crypto.randomUUID()),
      [],
    );
    // Working files carry no metadata, so a fact filter finds none of them.
    assertEquals(await found(fixture, "factKey=tone&factValue=formal"), []);
    // Paged to the end, never twice.
    const first = await ok(
      await call(fixture, "GET", "/v1/files/search?query=launch&limit=2"),
    );
    assertEquals((first.items as Json[]).length, 2);
    assert(first.nextCursor !== null);
    const second = await ok(
      await call(
        fixture,
        "GET",
        "/v1/files/search?query=launch&limit=2&cursor=" +
          encodeURIComponent(String(first.nextCursor)),
      ),
    );
    assertEquals((second.items as Json[]).length, 1);
    assertEquals(second.nextCursor, null);
    assertEquals(
      new Set(
        [...first.items as Json[], ...second.items as Json[]].map((h) =>
          h.path
        ),
      ).size,
      3,
    );
  }));

Deno.test("another member's personal file is never a search hit, and my own is", () =>
  withWorkerFixture(async (fixture) => {
    const other = await addMember(fixture);
    try {
      const mine = "/users/" + fixture.principalId + "/secret-admin.md";
      const theirs = "/users/" + other.principalId + "/secret-member.md";
      await ok(await put(fixture, mine, "admin secret"));
      await ok(
        await put(fixture, theirs, "member secret", { cookie: other.cookie }),
      );
      await ok(await put(fixture, "/shared/secret-shared.md", "everyone"));

      // Each finds their own and the shared one; neither finds the other's,
      // by name, by folder, by media type or by producer.
      assertEquals(
        new Set(await found(fixture, "query=secret")),
        new Set([mine, "/shared/secret-shared.md"]),
      );
      assertEquals(
        new Set(await found(fixture, "query=secret", { cookie: other.cookie })),
        new Set([theirs, "/shared/secret-shared.md"]),
      );
      for (
        const query of [
          "query=secret-member",
          "query=secret&path=/users/" + other.principalId,
          "query=secret&producerId=" + other.principalId,
          "mediaType=text/plain&query=member",
        ]
      ) {
        assertEquals(await found(fixture, query), [], query);
      }
      assertEquals(
        await found(fixture, "query=secret-admin", { cookie: other.cookie }),
        [],
      );
      // The shared file was written by the admin, so a producer filter on the
      // admin still finds it for the member, and never the admin's personal one.
      assertEquals(
        await found(fixture, "query=secret&producerId=" + fixture.principalId, {
          cookie: other.cookie,
        }),
        ["/shared/secret-shared.md"],
      );
    } finally {
      await removeMember(fixture, other);
    }
  }));

Deno.test("a trashed file is not a search hit", () =>
  withWorkerFixture(async (fixture) => {
    const file = await ok(await put(fixture, "/shared/old-brief.md", "brief"));
    assertEquals(await found(fixture, "query=old-brief"), [
      "/shared/old-brief.md",
    ]);
    await ok(
      await call(fixture, "DELETE", "/v1/storage/entries/" + file.id, {
        ifMatch: file.version as number,
      }),
    );
    assertEquals(await found(fixture, "query=old-brief"), []);
  }));

Deno.test("/system is searched by Admins only", () =>
  withWorkerFixture(async (fixture) => {
    const other = await addMember(fixture);
    try {
      const db = fixture.pgDatabase;
      const system = await db.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = 'system'",
        [fixture.organizationId],
      );
      // The tree is made on first read; make sure it is there.
      if (system.rows.length === 0) {
        await ok(await call(fixture, "GET", "/v1/storage/roots"));
      }
      const root = (await db.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = 'system'",
        [fixture.organizationId],
      )).rows[0];
      assert(root, "the /system folder exists");
      const entry = await db.query<{ id: string }>(
        `insert into bakery.storage_entries
           (organization_id, parent_id, name, name_key, kind, policy)
         values ($1, $2, 'system-audit.md', 'system-audit.md', 'file', 'system')
         returning id`,
        [fixture.organizationId, root.id],
      );
      const version = await db.query<{ id: string }>(
        `insert into bakery.storage_file_versions
           (organization_id, entry_id, revision, content, sha256, size_bytes,
            media_type, author_id)
         values ($1, $2, 1, $3, $4, 3, 'text/plain', $5) returning id`,
        [
          fixture.organizationId,
          entry.rows[0].id,
          new Uint8Array([1, 2, 3]),
          "0".repeat(64),
          fixture.principalId,
        ],
      );
      await db.query(
        "update bakery.storage_entries set current_version_id = $3 where organization_id = $1 and id = $2",
        [fixture.organizationId, entry.rows[0].id, version.rows[0].id],
      );
      assertEquals(await found(fixture, "query=system-audit"), [
        "/system/system-audit.md",
      ]);
      assertEquals(
        await found(fixture, "query=system-audit", { cookie: other.cookie }),
        [],
      );
    } finally {
      await removeMember(fixture, other);
    }
  }));

Deno.test("nothing crosses organizations", () =>
  withWorkerFixture(async (fixture) => {
    await ok(await put(fixture, "/shared/org-a-roadmap.md", "a"));
    const foreign = await createWorkerScope(fixture, "search-445", fixture);
    try {
      await ok(
        await put(fixture, "/shared/org-b-roadmap.md", "b", {
          organizationId: foreign.organizationId,
        }),
      );
      assertEquals(await found(fixture, "query=roadmap"), [
        "/shared/org-a-roadmap.md",
      ]);
      assertEquals(
        await found(fixture, "query=roadmap", {
          organizationId: foreign.organizationId,
        }),
        ["/shared/org-b-roadmap.md"],
      );
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));
