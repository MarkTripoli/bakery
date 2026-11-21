/**
 * #445: the files read API over a real record-area (artifact-backed) file.
 * Seeds a real record-area file (artifact-backed) with 3 versions, run input pins,
 * and drives the real HTTP routes. Covers what the PR's own tests never execute:
 * the artifact versions + uses SQL, conditional/range headers, cursor binding,
 * custom-role permission gate, /system descendants.
 */
import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import { createFilesApi, run } from "@bakery/cli";
import { signSessionCookie } from "../helpers/auth.ts";
import { bearerCall } from "../helpers/access-tokens.ts";
import { mintToken } from "../helpers/access-tokens.ts";
import { setup } from "../helpers/output-ingestion.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  projectArtifactEntry,
  storageQueryOf,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;
const items = (page: Json) => page.items as Json[];
const enc = (s: string) => new TextEncoder().encode(s);

function call(
  fixture: Fixture,
  method: string,
  path: string,
  options: {
    body?: unknown;
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
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  ));
}
async function ok(response: Response, expected = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, expected, text);
  return JSON.parse(text) as Json;
}
async function status(response: Response, expected: number) {
  const text = await response.text();
  assertEquals(response.status, expected, text);
}
async function cursorRefused(response: Response, label: string) {
  const text = await response.text();
  assertEquals(response.status, 400, label + ": " + text);
  assertEquals((JSON.parse(text) as Json).code, "INVALID_CURSOR", label);
}
function tamper(cursor: string): string {
  const at = Math.floor(cursor.length / 2);
  const swap = cursor[at] === "A" ? "B" : "A";
  return cursor.slice(0, at) + swap + cursor.slice(at + 1);
}
const q = encodeURIComponent;

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
      "qa724-" + providerUserId + "@example.test",
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
async function removeMember(
  fixture: Fixture,
  other: { principalId: string; providerUserId: string },
) {
  const db = fixture.pgDatabase;
  await db.query(
    "update bakery.organization_memberships set custom_role_id = null where organization_id = $1 and principal_id = $2",
    [fixture.organizationId, other.principalId],
  );
  await db.query(
    "delete from bakery.organization_roles where organization_id = $1",
    [
      fixture.organizationId,
    ],
  );
  await db.query(
    "delete from bakery.organization_memberships where organization_id = $1 and principal_id = $2",
    [fixture.organizationId, other.principalId],
  );
  await db.query(
    "delete from bakery.storage_entries where organization_id = $1 and owner_id = $2 and parent_id is not null and kind = 'folder' and system_key like 'user:%:%'",
    [fixture.organizationId, other.principalId],
  );
  await db.query(
    "delete from bakery.storage_entries where organization_id = $1 and owner_id = $2",
    [fixture.organizationId, other.principalId],
  );
  await db.query('delete from public.session where "userId" = $1', [
    other.providerUserId,
  ]);
  await db.query("delete from bakery.principals where id = $1", [
    other.principalId,
  ]);
  await db.query('delete from public."user" where id = $1', [
    other.providerUserId,
  ]);
}

async function seedRecordFile(
  fixture: Fixture,
  taskId: string,
  name: string,
  versions: { text: string; runStepId?: string }[],
) {
  const db = fixture.pgDatabase;
  const artifactId = crypto.randomUUID();
  await db.query(
    "insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name) values ($1,$2,$3,'document',$4)",
    [artifactId, fixture.organizationId, taskId, name],
  );
  const versionIds: string[] = [];
  const shas: string[] = [];
  for (const [index, v] of versions.entries()) {
    const id = crypto.randomUUID();
    const bytes = enc(v.text);
    const sha = await sha256Bytes(bytes);
    await db.query(
      "insert into bakery.artifact_versions (id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class,run_step_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'text/plain','evidence',$10)",
      [
        id,
        fixture.organizationId,
        artifactId,
        taskId,
        fixture.principalId,
        index + 1,
        bytes,
        sha,
        bytes.length,
        v.runStepId ?? null,
      ],
    );
    versionIds.push(id);
    shas.push(sha);
  }
  await db.query(
    "update bakery.artifacts set current_version_id = $1 where organization_id = $2 and id = $3",
    [versionIds.at(-1), fixture.organizationId, artifactId],
  );
  const entryId = await withPgTransaction(
    db,
    (tx) =>
      projectArtifactEntry(storageQueryOf(tx), {
        organizationId: fixture.organizationId,
        artifactId,
      }),
  );
  assert(entryId, "record file projected into the tree");
  return { artifactId, versionIds, shas, entryId };
}

async function pin(
  fixture: Fixture,
  runId: string,
  seed: Awaited<ReturnType<typeof seedRecordFile>>,
  index: number,
  minutesAgo: number,
  inputName: string,
  size: number,
) {
  const db = fixture.pgDatabase;
  await db.query(
    "insert into bakery.run_input_pins (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes,created_at) values ($1,$2,$3,$4,$5,$6, now() - ($7 || ' minutes')::interval)",
    [
      fixture.organizationId,
      runId,
      seed.artifactId,
      seed.versionIds[index],
      seed.shas[index],
      size,
      String(minutesAgo),
    ],
  );
  await db.query(
    "insert into bakery.run_input_paths (organization_id,run_id,input_name,storage_path,entry_id,artifact_id,artifact_version_id,sha256) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      fixture.organizationId,
      runId,
      inputName,
      "/projects/x/" + inputName,
      seed.entryId,
      seed.artifactId,
      seed.versionIds[index],
      seed.shas[index],
    ],
  );
}

async function world(fixture: Fixture) {
  const own = await setup(fixture);
  const file = await seedRecordFile(fixture, own.job.taskId, "brief.txt", [
    { text: "one" },
    { text: "two2", runStepId: own.job.runStepId },
    { text: "three33" },
  ]);
  const other = await seedRecordFile(fixture, own.job.taskId, "other.txt", [
    { text: "solo" },
  ]);
  await pin(fixture, own.job.runId, file, 0, 10, "brief-one", 3);
  await pin(fixture, own.job.runId, file, 2, 5, "brief-three", 7);
  return { own, file, other };
}

Deno.test("record-area file: versions, uses, bytes and conditional headers", () =>
  withWorkerFixture(async (fixture) => {
    const { own, file } = await world(fixture);
    const db = fixture.pgDatabase;
    const base = "/v1/storage/files/" + file.entryId;

    // The file is listed in its work item folder with its current version's facts.
    const parent = (await db.query<{ parent_id: string }>(
      "select parent_id from bakery.storage_entries where id = $1",
      [file.entryId],
    )).rows[0].parent_id;
    const listing = items(
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/folders/" + parent + "/entries",
        ),
      ),
    );
    const row = listing.find((r) => r.id === file.entryId)!;
    assert(row, "record file is listed in its work item folder");
    assertEquals(row.name, "brief.txt");
    assertEquals(row.sizeBytes, 7);
    assertEquals(row.mediaType, "text/plain");
    assertEquals(row.artifactId, file.artifactId);
    assertEquals(row.kindName, "document");
    assertEquals(row.contentRemoved, false);

    // Versions: newest first, who made each.
    const versions = items(
      await ok(await call(fixture, "GET", base + "/versions")),
    );
    assertEquals(versions.map((v) => [v.revision, v.isCurrent]), [
      [3, true],
      [2, false],
      [1, false],
    ]);
    const stepName = (await db.query<{ step_key: string }>(
      "select step_key from bakery.run_steps where id = $1",
      [own.job.runStepId],
    )).rows[0].step_key;
    const title = (await db.query<{ title: string }>(
      "select title from bakery.tasks where id = $1",
      [own.job.taskId],
    )).rows[0].title;
    assertEquals(versions[1].makerKind, "step");
    assertEquals(versions[1].stepId, own.job.runStepId);
    assertEquals(versions[1].stepName, stepName);
    assertEquals(versions[1].runId, own.job.runId);
    assertEquals(versions[1].workItemId, own.job.taskId);
    assertEquals(versions[1].workItemTitle, title);
    assertEquals(versions[0].makerKind, "person");
    assertEquals(versions[0].makerPrincipalId, fixture.principalId);
    assertEquals(versions[0].runId, null);
    assertEquals(versions[2].sha256, file.shas[0]);
    assertEquals(versions[0].sizeBytes, 7);

    // Versions keyset: limit 1 walks 3,2,1.
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Json = await ok(
        await call(
          fixture,
          "GET",
          base + "/versions?limit=1" + (cursor ? "&cursor=" + q(cursor) : ""),
        ),
      );
      for (const item of items(page)) seen.push(item.revision as number);
      cursor = page.nextCursor as string | null;
      if (!cursor) break;
    }
    assertEquals(seen, [3, 2, 1]);

    // Uses: the two pins, newest first, with the work item and input name.
    const uses = items(await ok(await call(fixture, "GET", base + "/uses")));
    assertEquals(uses.map((u) => [u.revision, u.inputName]), [
      [3, "brief-three"],
      [1, "brief-one"],
    ]);
    assertEquals(uses[0].runId, own.job.runId);
    assertEquals(uses[0].workItemId, own.job.taskId);
    assertEquals(uses[0].workItemTitle, title);
    assertEquals(uses[0].versionId, file.versionIds[2]);
    const p1: Json = await ok(
      await call(fixture, "GET", base + "/uses?limit=1"),
    );
    assertEquals(items(p1).map((u) => u.revision), [3]);
    const p2: Json = await ok(
      await call(
        fixture,
        "GET",
        base + "/uses?limit=1&cursor=" + q(p1.nextCursor as string),
      ),
    );
    assertEquals(items(p2).map((u) => u.revision), [1]);
    assertEquals(p2.nextCursor, null);

    // Bytes: whole, etag, 304, ranges, If-Range, revisions.
    const whole = await call(fixture, "GET", base + "/content");
    assertEquals(whole.status, 200);
    assertEquals(await whole.text(), "three33");
    assertEquals(whole.headers.get("ETag"), '"' + file.shas[2] + '"');
    assertEquals(whole.headers.get("Content-Length"), "7");
    assert(whole.headers.get("Content-Disposition")!.startsWith("attachment;"));
    assertEquals(whole.headers.get("X-Content-Type-Options"), "nosniff");

    const notModified = await call(fixture, "GET", base + "/content", {
      headers: { "If-None-Match": '"' + file.shas[2] + '"' },
    });
    assertEquals(notModified.status, 304);
    assertEquals(await notModified.text(), "");
    assertEquals(notModified.headers.get("ETag"), '"' + file.shas[2] + '"');
    const otherTag = await call(fixture, "GET", base + "/content", {
      headers: { "If-None-Match": '"deadbeef"' },
    });
    assertEquals(otherTag.status, 200);
    await otherTag.text();

    const suffix = await call(fixture, "GET", base + "/content", {
      headers: { Range: "bytes=-3" },
    });
    assertEquals(suffix.status, 206);
    assertEquals(suffix.headers.get("Content-Range"), "bytes 4-6/7");
    assertEquals(await suffix.text(), "e33");
    const one = await call(fixture, "GET", base + "/content", {
      headers: { Range: "bytes=0-0" },
    });
    assertEquals(one.status, 206);
    assertEquals(await one.text(), "t");
    const staleRange = await call(fixture, "GET", base + "/content", {
      headers: { Range: "bytes=0-1", "If-Range": '"deadbeef"' },
    });
    assertEquals(staleRange.status, 200);
    assertEquals(await staleRange.text(), "three33");
    const freshRange = await call(fixture, "GET", base + "/content", {
      headers: { Range: "bytes=0-1", "If-Range": '"' + file.shas[2] + '"' },
    });
    assertEquals(freshRange.status, 206);
    assertEquals(await freshRange.text(), "th");
    const unsat = await call(fixture, "GET", base + "/content", {
      headers: { Range: "bytes=50-" },
    });
    assertEquals(unsat.status, 416);
    assertEquals(unsat.headers.get("Content-Range"), "bytes */7");
    await unsat.text();
    for (
      const bad of ["bytes=abc", "bytes=0-1,3-4", "items=0-1", "bytes=5-2"]
    ) {
      const res = await call(fixture, "GET", base + "/content", {
        headers: { Range: bad },
      });
      const text = await res.text();
      assert(
        res.status < 500,
        "range " + bad + " must not 5xx: " + res.status + " " + text,
      );
      assert(
        res.status !== 206 || bad === "bytes=0-1,3-4",
        "range " + bad + " answered 206",
      );
    }
    const rev2 = await call(fixture, "GET", base + "/content?revision=2");
    assertEquals(await rev2.text(), "two2");
    const rev1range = await call(fixture, "GET", base + "/content?revision=1", {
      headers: { Range: "bytes=1-" },
    });
    assertEquals(rev1range.status, 206);
    assertEquals(await rev1range.text(), "ne");
    for (const bad of ["0", "abc", "01", "1.5", "-1", "9999999999"]) {
      const res = await call(fixture, "GET", base + "/content?revision=" + bad);
      const text = await res.text();
      assertEquals(res.status, 400, "revision=" + bad + " -> " + text);
      assertEquals((JSON.parse(text) as Json).code, "MALFORMED_REQUEST");
    }
    await status(
      await call(fixture, "GET", base + "/content?revision=99"),
      404,
    );

    // A purged version: bytes are 410, the version row says so.
    await db.query(
      "update bakery.artifact_versions set purged_at = now(), content = null where id = $1",
      [file.versionIds[0]],
    );
    await status(await call(fixture, "GET", base + "/content?revision=1"), 410);
    const after = items(
      await ok(await call(fixture, "GET", base + "/versions")),
    );
    assertEquals(after.find((v) => v.revision === 1)!.contentRemoved, true);
    assertEquals(after.find((v) => v.revision === 3)!.contentRemoved, false);
  }));

Deno.test("cursor binding: folder, versions, uses; other file, action, principal, organization, tamper, stale", () =>
  withWorkerFixture(async (fixture) => {
    const { file, other } = await world(fixture);
    const db = fixture.pgDatabase;
    for (const name of ["a.md", "b.md", "c.md"]) {
      await ok(
        await call(fixture, "PUT", "/v1/storage/files", {
          body: {
            path: "/shared/" + name,
            mediaType: "text/plain",
            content: btoa(name),
          },
        }),
      );
    }
    const ids = async (key: string) =>
      (await db.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = $2",
        [fixture.organizationId, key],
      )).rows[0].id;
    const shared = await ids("shared");
    const library = await ids("library");
    const entries = (id: string, extra = "") =>
      "/v1/storage/folders/" + id + "/entries" + extra;
    const fbase = "/v1/storage/files/" + file.entryId;
    const obase = "/v1/storage/files/" + other.entryId;

    const f1: Json = await ok(
      await call(fixture, "GET", entries(shared, "?limit=1")),
    );
    const folderCursor = f1.nextCursor as string;
    const v1: Json = await ok(
      await call(fixture, "GET", fbase + "/versions?limit=1"),
    );
    const versionCursor = v1.nextCursor as string;
    const u1: Json = await ok(
      await call(fixture, "GET", fbase + "/uses?limit=1"),
    );
    const useCursor = u1.nextCursor as string;
    assert(folderCursor && versionCursor && useCursor);

    // Control: each cursor works where it was minted.
    await ok(
      await call(
        fixture,
        "GET",
        entries(shared, "?limit=1&cursor=" + q(folderCursor)),
      ),
    );
    await ok(
      await call(
        fixture,
        "GET",
        fbase + "/versions?limit=1&cursor=" + q(versionCursor),
      ),
    );
    await ok(
      await call(
        fixture,
        "GET",
        fbase + "/uses?limit=1&cursor=" + q(useCursor),
      ),
    );

    // Another folder / another file.
    await cursorRefused(
      await call(
        fixture,
        "GET",
        entries(library, "?limit=1&cursor=" + q(folderCursor)),
      ),
      "folder cursor on another folder",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        obase + "/versions?limit=1&cursor=" + q(versionCursor),
      ),
      "versions cursor on another file",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        obase + "/uses?limit=1&cursor=" + q(useCursor),
      ),
      "uses cursor on another file",
    );
    // Another action on the same target.
    await cursorRefused(
      await call(
        fixture,
        "GET",
        fbase + "/uses?limit=1&cursor=" + q(versionCursor),
      ),
      "versions cursor on uses",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        fbase + "/versions?limit=1&cursor=" + q(useCursor),
      ),
      "uses cursor on versions",
    );
    // Tampered.
    await cursorRefused(
      await call(
        fixture,
        "GET",
        entries(shared, "?limit=1&cursor=" + q(tamper(folderCursor))),
      ),
      "tampered folder cursor",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        fbase + "/versions?limit=1&cursor=" + q(tamper(versionCursor)),
      ),
      "tampered versions cursor",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        fbase + "/uses?limit=1&cursor=" + q(tamper(useCursor)),
      ),
      "tampered uses cursor",
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        entries(shared, "?limit=1&cursor=not-a-cursor"),
      ),
      "garbage cursor",
    );

    // Another principal in the same organization.
    const member = await addMember(fixture);
    try {
      const as = { cookie: member.cookie };
      await cursorRefused(
        await call(
          fixture,
          "GET",
          entries(shared, "?limit=1&cursor=" + q(folderCursor)),
          as,
        ),
        "folder cursor as another member",
      );
      await cursorRefused(
        await call(
          fixture,
          "GET",
          fbase + "/versions?limit=1&cursor=" + q(versionCursor),
          as,
        ),
        "versions cursor as another member",
      );
      await cursorRefused(
        await call(
          fixture,
          "GET",
          fbase + "/uses?limit=1&cursor=" + q(useCursor),
          as,
        ),
        "uses cursor as another member",
      );
      // The record file itself is readable by another member (record area).
      assertEquals(
        items(await ok(await call(fixture, "GET", fbase + "/versions", as)))
          .length,
        3,
      );
      assertEquals(
        (await call(fixture, "GET", fbase + "/content", as)).status,
        200,
      );
    } finally {
      await removeMember(fixture, member);
    }

    // Another organization: the same ids and cursors are not found / refused, never 200.
    const foreign = await createWorkerScope(fixture, "qa-724", fixture);
    try {
      for (
        const path of [
          entries(shared, "?limit=1&cursor=" + q(folderCursor)),
          fbase + "/versions?limit=1&cursor=" + q(versionCursor),
          fbase + "/uses?limit=1&cursor=" + q(useCursor),
        ]
      ) {
        const res = await call(fixture, "GET", path, {
          organizationId: foreign.organizationId,
        });
        const text = await res.text();
        assert(
          res.status === 404 || res.status === 400,
          "foreign org got " + res.status + " " + text,
        );
      }
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }

    // Stale anchor: the last row seen left the folder.
    const anchor = (await db.query<{ id: string }>(
      "select e.id from bakery.storage_entries e where e.organization_id = $1 and e.parent_id = $2 order by case when e.kind = 'folder' then 0 else 1 end, e.name_key, e.id limit 1",
      [fixture.organizationId, shared],
    )).rows[0].id;
    await db.query(
      "update bakery.storage_entries set parent_id = $1 where id = $2",
      [library, anchor],
    );
    await cursorRefused(
      await call(
        fixture,
        "GET",
        entries(shared, "?limit=1&cursor=" + q(folderCursor)),
      ),
      "stale anchor",
    );
  }));

Deno.test("tenancy, permission gate, /system descendants, validation", () =>
  withWorkerFixture(async (fixture) => {
    const { file } = await world(fixture);
    const db = fixture.pgDatabase;
    const fbase = "/v1/storage/files/" + file.entryId;
    const all = [
      "/v1/storage/roots",
      fbase + "/versions",
      fbase + "/uses",
      fbase + "/content",
    ];

    // Another organization: a record file's id is 404 on every read.
    const foreign = await createWorkerScope(fixture, "qa-724b", fixture);
    try {
      for (const path of all.slice(1)) {
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

    const member = await addMember(fixture);
    try {
      const as = { cookie: member.cookie };
      // /system: a file under it is 404 for a developer, readable-path for an Admin.
      const system = (await db.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = 'system'",
        [fixture.organizationId],
      )).rows[0].id;
      const sysFile = (await db.query<{ id: string }>(
        "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy) values ($1, $2, 'secret.txt', 'secret.txt', 'file', 'working') returning id",
        [fixture.organizationId, system],
      )).rows[0].id;
      for (const suffix of ["/versions", "/uses", "/content"]) {
        await status(
          await call(
            fixture,
            "GET",
            "/v1/storage/files/" + sysFile + suffix,
            as,
          ),
          404,
        );
      }
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + sysFile + "/versions",
        ),
      );
      await status(
        await call(
          fixture,
          "GET",
          "/v1/storage/folders/" + system + "/entries",
          as,
        ),
        404,
      );

      // Personal: another member's uses is 404 too (the PR test covers versions and content).
      const mine = await ok(
        await call(fixture, "PUT", "/v1/storage/files", {
          body: {
            path: "/users/" + fixture.principalId + "/uploads/p.txt",
            mediaType: "text/plain",
            content: btoa("mine"),
          },
        }),
      );
      await status(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + mine.id + "/uses",
          as,
        ),
        404,
      );

      // Validation.
      const shared = (await db.query<{ id: string }>(
        "select id from bakery.storage_entries where organization_id = $1 and system_key = 'shared'",
        [fixture.organizationId],
      )).rows[0].id;
      const entries = "/v1/storage/folders/" + shared + "/entries";
      for (const bad of ["0", "101", "abc", "-1", "1.5"]) {
        const res = await call(fixture, "GET", entries + "?limit=" + bad);
        const text = await res.text();
        assert(
          res.status === 422 || res.status === 400,
          "limit=" + bad + " -> " + res.status + " " + text,
        );
      }
      await ok(await call(fixture, "GET", entries + "?limit=100"));
      // A malformed id is rejected by the shared IdPath validator before the handler.
      await status(
        await call(fixture, "GET", "/v1/storage/files/not-a-uuid/versions"),
        400,
      );
      await status(
        await call(
          fixture,
          "GET",
          "/v1/storage/files/" + crypto.randomUUID() + "/content",
        ),
        404,
      );
      await status(
        await call(fixture, "GET", "/v1/storage/files/" + shared + "/versions"),
        404,
      );
      await status(
        await call(fixture, "GET", "/v1/storage/files/" + shared + "/content"),
        404,
      );
      await status(
        await call(
          fixture,
          "GET",
          "/v1/storage/folders/" + file.entryId + "/entries",
        ),
        404,
      );

      // A custom role without artifactVersion:read is refused on every read.
      const role = await ok(
        await call(fixture, "POST", "/v1/organization-roles", {
          body: {
            key: "qa724-noread",
            name: "QA 724 no read",
            permissions: ["principal:read"],
          },
        }),
        201,
      );
      const assigned = await call(
        fixture,
        "POST",
        "/v1/organization-roles/" + role.id + "/members",
        {
          body: { principalId: member.principalId },
        },
      );
      assert(
        assigned.status < 300,
        "assign role " + assigned.status + " " + await assigned.text(),
      );
      await assigned.text().catch(() => "");
      // The same member against an EXISTING artifact read route is the control:
      // whatever the platform answers a role without the permission, these must match.
      const control = await call(
        fixture,
        "GET",
        "/v1/artifact-versions/" + file.versionIds[2] + "/content",
        as,
      );
      const controlStatus = control.status;
      await control.text();
      assert(
        controlStatus >= 400 && controlStatus < 500,
        "control " + controlStatus,
      );
      for (
        const path of [...all, "/v1/storage/folders/" + shared + "/entries"]
      ) {
        const res = await call(fixture, "GET", path, as);
        const text = await res.text();
        assert(
          res.status >= 400 && res.status < 500,
          "no-read role on " + path + ": " + res.status + " " + text,
        );
        assertEquals(
          res.status,
          controlStatus,
          "no-read role on " + path +
            " differs from the existing artifact route: " + text,
        );
      }
    } finally {
      await db.query(
        "delete from bakery.audit_events where operation like 'organizationRoles.%'",
      );
      await removeMember(fixture, member);
    }
  }));

Deno.test("record-area file: an artifact version id opens its file with that revision", () =>
  withWorkerFixture(async (fixture) => {
    const { file } = await world(fixture);
    const first = await ok(
      await call(
        fixture,
        "GET",
        "/v1/storage/file-versions/" + file.versionIds[0],
      ),
    );
    assertEquals([first.revision, first.isCurrent], [1, false]);
    assertEquals((first.file as Json).id, file.entryId);
    assertEquals((first.file as Json).artifactId, file.artifactId);
    const last = await ok(
      await call(
        fixture,
        "GET",
        "/v1/storage/file-versions/" + file.versionIds.at(-1),
      ),
    );
    assertEquals([last.revision, last.isCurrent], [3, true]);
  }));

Deno.test("pin: a token with the admin scope pins a record file by its id; read and operate scopes, a developer, a working-area file and another organization are refused", () =>
  withWorkerFixture(async (fixture) => {
    const { file } = await world(fixture);
    const path = "/v1/storage/files/" + file.entryId + "/pin";
    const asToken = (
      secret: string,
      pinned: boolean,
      organizationId?: string,
    ) =>
      bearerCall(
        fixture as unknown as Parameters<typeof bearerCall>[0],
        "PUT",
        path,
        secret,
        { body: { pinned }, organizationId },
      );
    const mint = (scopes: string[]) =>
      mintToken(
        fixture as unknown as Parameters<typeof mintToken>[0],
        undefined,
        scopes,
        "pin " + scopes.join("+"),
      );
    const isPinned = async () =>
      (await fixture.pgDatabase.query<{ pinned: boolean }>(
        "select (pinned_at is not null) as pinned from bakery.artifacts where organization_id = $1 and id = $2",
        [fixture.organizationId, file.artifactId],
      )).rows[0].pinned;

    // A token whose scope does not cover artifact:manage is refused, and nothing changes.
    for (const scope of ["bakery:read", "bakery:operate"]) {
      const token = await mint([scope]);
      await status(await asToken(token.secret as string, true), 403);
    }
    assertEquals(await isPinned(), false);

    // The admin scope pins it: the same result the artifact PATCH gives.
    const admin = await mint(["bakery:admin"]);
    const pinned = await ok(await asToken(admin.secret as string, true));
    assertEquals([pinned.id, pinned.pinned], [file.artifactId, true]);
    assertEquals(await isPinned(), true);
    // Asking for the state it is already in changes nothing and still answers.
    assertEquals(
      (await ok(await asToken(admin.secret as string, true))).pinned,
      true,
    );

    // The listing says so.
    const parent = (await fixture.pgDatabase.query<{ parent_id: string }>(
      "select parent_id from bakery.storage_entries where id = $1",
      [file.entryId],
    )).rows[0].parent_id;
    const row = items(
      await ok(
        await call(
          fixture,
          "GET",
          "/v1/storage/folders/" + parent + "/entries",
        ),
      ),
    ).find((entry) => entry.id === file.entryId)!;
    assertEquals(row.pinned, true);

    // The artifact PATCH and the pin are one implementation: the audit names the action.
    const audited = await fixture.pgDatabase.query<{ operation: string }>(
      "select operation from bakery.audit_events where organization_id = $1 and resource_id = $2 and operation = 'storageFiles.pin'",
      [fixture.organizationId, file.artifactId],
    );
    assert(audited.rows.length >= 1, "the pin is audited as storageFiles.pin");

    // A developer (not an administrator) is refused with a session too.
    const member = await addMember(fixture);
    try {
      await status(
        await call(fixture, "PUT", path, {
          body: { pinned: false },
          cookie: member.cookie,
        }),
        403,
      );
    } finally {
      await removeMember(fixture, member);
    }
    assertEquals(await isPinned(), true);

    // Unpin with the token.
    assertEquals(
      (await ok(await asToken(admin.secret as string, false))).pinned,
      false,
    );
    assertEquals(await isPinned(), false);

    // The command line does the same end to end: pin, stat, unpin, with the real
    // generated client, the admin token and the real route.
    const cli = async (argv: string[]) => {
      const lines: string[] = [];
      const errors: string[] = [];
      const code = await run(argv, {
        environment: (name) =>
          ({
            BAKERY_URL: fixture.config.publicBaseUrl,
            BAKERY_ORGANIZATION: fixture.organizationId,
            BAKERY_TOKEN: admin.secret as string,
          })[name],
        error: (line) => errors.push(line),
        createApi: (config) =>
          createFilesApi(
            config,
            ((input: RequestInfo | URL, init?: RequestInit) =>
              fixture.app.fetch(new Request(input, init))) as typeof fetch,
          ),
        output: {
          text: (line) => lines.push(line),
          bytes: () => {},
          file: () => Promise.resolve(),
        },
      });
      console.log(
        "$ bakery " + argv.join(" ") + "  -> exit " + code +
          (errors.length > 0 ? "  | " + errors.join(" / ") : ""),
      );
      return { code, lines, errors };
    };
    const filePath = row.path as string;
    const cliPin = await cli(["files", "pin", filePath]);
    assertEquals([cliPin.code, cliPin.lines], [0, ["Pinned " + filePath]]);
    assertEquals(await isPinned(), true);
    const cliStat = await cli(["files", "stat", filePath]);
    assert(cliStat.lines.some((line) => /^Pinned\s+yes$/.test(line)));
    const cliUnpin = await cli(["files", "unpin", filePath]);
    assertEquals(cliUnpin.code, 0);
    assertEquals(await isPinned(), false);

    // A working-area file has no pin: 422, never a quiet no-op.
    const made = await ok(
      await call(fixture, "PUT", "/v1/storage/files", {
        body: {
          path: "/shared/pin-working.md",
          mediaType: "text/plain",
          content: btoa("working"),
        },
      }),
    );
    const working = await call(
      fixture,
      "PUT",
      "/v1/storage/files/" + (made.id as string) + "/pin",
      { body: { pinned: true } },
    );
    await status(working, 422);

    // Another organization: the file's id is 404, and nothing is pinned.
    const foreign = await createWorkerScope(fixture, "pin-445", fixture);
    try {
      await status(
        await asToken(admin.secret as string, true, foreign.organizationId),
        404,
      );
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
    assertEquals(await isPinned(), false);

    // A file that does not exist is 404.
    await status(
      await bearerCall(
        fixture as unknown as Parameters<typeof bearerCall>[0],
        "PUT",
        "/v1/storage/files/" + crypto.randomUUID() + "/pin",
        admin.secret as string,
        { body: { pinned: true } },
      ),
      404,
    );
  }));
