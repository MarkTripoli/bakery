/**
 * #447: working areas over the storage tree, through the HTTP routes a client
 * and the CLI use. One case per scope item: put (and upload as a put naming a
 * blob), mkdir, cp, mv, rm to trash and restore, a record area refusing rm,
 * kept and scratch retention, limits as organization settings, quotas, and
 * the Admin purge; plus tenancy (a foreign id is 404) and the purge
 * permission.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { reapExpiredStorage } from "../../apps/server/src/modules/knowledge/storage-retention-reaper.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function call(
  fixture: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: number; organizationId?: string } = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
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

async function problem(response: Response, status: number, code: string) {
  const body = JSON.parse(await response.text()) as Json;
  assertEquals(
    [response.status, body.code],
    [status, code],
    JSON.stringify(body),
  );
  return body;
}

const text = (value: string) => btoa(value);

function put(
  fixture: Fixture,
  path: string,
  content: string,
  ifMatch?: number,
  organizationId?: string,
) {
  return call(fixture, "PUT", "/v1/storage/files", {
    body: { path, mediaType: "text/plain", content: text(content) },
    ifMatch,
    organizationId,
  });
}

const versions = async (fixture: Fixture, entryId: string) =>
  Number(
    (await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.storage_file_versions where entry_id = $1",
      [entryId],
    )).rows[0].n,
  );

/** A blob and the completed upload session that stored it, by createdById. */
async function completedUpload(
  fixture: Fixture,
  digest: string,
  sizeBytes: number,
  createdById: string,
) {
  const blob = await fixture.pgDatabase.query<{ id: string }>(
    "insert into bakery.blobs (organization_id, sha256, size_bytes, media_type, created_by_id) values ($1, $2, $3, 'application/octet-stream', $4) returning id",
    [fixture.organizationId, digest, sizeBytes, createdById],
  );
  await fixture.pgDatabase.query(
    "insert into bakery.blob_upload_sessions (organization_id, created_by_id, sha256, size_bytes, media_type, state, expires_at, completed_blob_id) values ($1, $2, $3, $4, 'application/octet-stream', 'completed', now() + interval '1 day', $5)",
    [fixture.organizationId, createdById, digest, sizeBytes, blob.rows[0].id],
  );
  return blob;
}

/** Another active member of the fixture's organization; returns a cleanup. */
async function otherMember(fixture: Fixture) {
  const db = fixture.pgDatabase;
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'Other member', $2, true, $3, $3)`,
    [userId, `storage-447-${userId}@example.test`, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, 'Other member', 'human')`,
    [principalId, userId],
  );
  await db.query(
    `insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version)
     values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, now],
  );
  return {
    principalId,
    async remove() {
      for (
        const sql of [
          "delete from bakery.blob_upload_sessions where created_by_id = $1",
          "delete from bakery.blobs where created_by_id = $1",
          "delete from bakery.organization_memberships where principal_id = $1",
          "delete from bakery.principals where id = $1",
        ]
      ) await db.query(sql, [principalId]);
      await db.query('delete from public."user" where id = $1', [userId]);
    },
  };
}

Deno.test("a put naming another member's upload, or a blob with no upload, is 404", () =>
  withWorkerFixture(async (fixture) => {
    const other = await otherMember(fixture);
    try {
      const bytes = new TextEncoder().encode("their bytes");
      const theirs = await completedUpload(
        fixture,
        await sha256Bytes(bytes),
        bytes.byteLength,
        other.principalId,
      );
      const bare = await fixture.pgDatabase.query<{ id: string }>(
        "insert into bakery.blobs (organization_id, sha256, size_bytes, media_type, created_by_id) values ($1, $2, 4, 'application/octet-stream', $3) returning id",
        [
          fixture.organizationId,
          await sha256Bytes(new TextEncoder().encode("bare")),
          other.principalId,
        ],
      );
      for (const blobId of [theirs.rows[0].id, bare.rows[0].id]) {
        await problem(
          await call(fixture, "PUT", "/v1/storage/files", {
            body: {
              path: "/shared/stolen.bin",
              mediaType: "application/octet-stream",
              blobId,
            },
          }),
          404,
          "RESOURCE_NOT_FOUND",
        );
      }
    } finally {
      await other.remove();
    }
  }));

Deno.test("put, upload, mkdir, cp and mv in a working area", () =>
  withWorkerFixture(async (fixture) => {
    // put: the first write makes the file, at revision 1.
    const made = await ok(await put(fixture, "/shared/notes.md", "one"), 200);
    assertEquals(made.path, "/shared/notes.md");
    assertEquals(made.policy, "working");
    assertEquals(made.revision, 1);
    assertEquals(
      made.sha256,
      await sha256Bytes(new TextEncoder().encode("one")),
    );

    // Identical bytes change nothing, even without If-Match.
    const same = await ok(await put(fixture, "/shared/notes.md", "one"));
    assertEquals([same.revision, same.version], [1, made.version]);

    // Replacing needs If-Match on the entry's version.
    await problem(
      await put(fixture, "/shared/notes.md", "two"),
      428,
      "PRECONDITION_REQUIRED",
    );
    await problem(
      await put(fixture, "/shared/notes.md", "two", 99),
      412,
      "PRECONDITION_FAILED",
    );
    const second = await ok(
      await put(fixture, "/shared/notes.md", "two", made.version as number),
    );
    assertEquals(second.revision, 2);

    // Upload: the caller's completed upload put at a path. The blob and
    // session rows are what blobUploads.complete records; the upload routes
    // have their own test.
    const bytes = new TextEncoder().encode("uploaded bytes");
    const digest = await sha256Bytes(bytes);
    const blob = await completedUpload(
      fixture,
      digest,
      bytes.byteLength,
      fixture.principalId,
    );
    const uploaded = await ok(
      await call(fixture, "PUT", "/v1/storage/files", {
        body: {
          path: "/shared/upload.bin",
          mediaType: "application/octet-stream",
          blobId: blob.rows[0].id,
        },
      }),
    );
    assertEquals([uploaded.sha256, uploaded.sizeBytes], [
      digest,
      bytes.byteLength,
    ]);

    // mkdir, then cp by reference and mv with If-Match.
    const folder = await ok(
      await call(fixture, "POST", "/v1/storage/folders", {
        body: { path: "/shared/briefs" },
      }),
      201,
    );
    assertEquals(folder.kind, "folder");
    const copy = await ok(
      await call(
        fixture,
        "POST",
        "/v1/storage/entries/" + uploaded.id + "/copy",
        {
          body: { destinationPath: "/shared/briefs/copy.bin" },
        },
      ),
      201,
    );
    assertEquals(copy.sha256, digest);
    assert(copy.id !== uploaded.id);
    const blobOfCopy = await fixture.pgDatabase.query<{ blob_id: string }>(
      "select blob_id from bakery.storage_file_versions where id = $1",
      [copy.currentVersionId],
    );
    assertEquals(
      blobOfCopy.rows[0].blob_id,
      blob.rows[0].id,
      "copy is by reference",
    );

    await problem(
      await call(fixture, "POST", "/v1/storage/entries/" + copy.id + "/move", {
        body: { destinationPath: "/shared/renamed.bin" },
      }),
      428,
      "PRECONDITION_REQUIRED",
    );
    const moved = await ok(
      await call(fixture, "POST", "/v1/storage/entries/" + copy.id + "/move", {
        body: { destinationPath: "/shared/renamed.bin" },
        ifMatch: copy.version as number,
      }),
    );
    assertEquals([moved.id, moved.path], [copy.id, "/shared/renamed.bin"]);
    assertEquals(
      moved.currentVersionId,
      copy.currentVersionId,
      "mv moves no version",
    );

    // Every mutation is audited.
    const audits = await fixture.pgDatabase.query<{ operation: string }>(
      "select operation from bakery.audit_events where organization_id = $1 and resource_type = 'storage_entry' order by created_at",
      [fixture.organizationId],
    );
    assertEquals(
      [...new Set(audits.rows.map((row) => row.operation))].sort(),
      [
        "storageEntries.copy",
        "storageEntries.move",
        "storageFiles.put",
        "storageFolders.create",
      ],
    );
  }));

Deno.test("record areas refuse rm, mv and writes; rm in a working area trashes and restores", () =>
  withWorkerFixture(async (fixture) => {
    // Any write makes the default layout.
    const file = await ok(await put(fixture, "/shared/draft.md", "draft"));
    const projects = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = 'projects'",
      [fixture.organizationId],
    );
    const record = await fixture.pgDatabase.query<{ id: string }>(
      "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy) values ($1, $2, 'evidence', 'evidence', 'folder', 'record') returning id",
      [fixture.organizationId, projects.rows[0].id],
    );
    const refused = await problem(
      await call(
        fixture,
        "DELETE",
        "/v1/storage/entries/" + record.rows[0].id,
        {
          ifMatch: 1,
        },
      ),
      409,
      "STORAGE_AREA_REFUSED",
    );
    assertEquals(refused.reason, "record_area");
    // An Admin purge refuses a record-area folder; only a record-area file's
    // purge is queued (storage-record-purge_test.ts).
    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set role = 'admin' where organization_id = $1 and principal_id = $2",
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals(
      (await problem(
        await call(
          fixture,
          "POST",
          "/v1/storage/entries/" + record.rows[0].id + "/purge",
        ),
        409,
        "STORAGE_AREA_REFUSED",
      )).reason,
      "record_area",
    );
    assertEquals(
      (await problem(
        await put(fixture, "/projects/evidence/x.md", "x"),
        409,
        "STORAGE_AREA_REFUSED",
      )).reason,
      "record_area",
    );
    assertEquals(
      (await problem(
        await put(fixture, "/library/x.md", "x"),
        409,
        "STORAGE_AREA_REFUSED",
      )).reason,
      "library_area",
    );
    // A folder Bakery made stays put.
    const shared = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = 'shared'",
      [fixture.organizationId],
    );
    assertEquals(
      (await problem(
        await call(
          fixture,
          "DELETE",
          "/v1/storage/entries/" + shared.rows[0].id,
          {
            ifMatch: 1,
          },
        ),
        409,
        "STORAGE_AREA_REFUSED",
      )).reason,
      "system_folder",
    );

    // rm trashes; the name is free again; restore puts it back.
    const trashed = await ok(
      await call(fixture, "DELETE", "/v1/storage/entries/" + file.id, {
        ifMatch: file.version as number,
      }),
    );
    assert(typeof trashed.trashedAt === "string");
    assertEquals(trashed.path, "/trash/draft.md");
    assertEquals(
      [trashed.originalName, trashed.originalFolderPath, trashed.trashedById],
      ["draft.md", "/shared", fixture.principalId],
    );
    assert(
      typeof trashed.trashedByName === "string" &&
        trashed.trashedByName.length > 0,
    );
    const listed = await ok(await call(fixture, "GET", "/v1/storage/trash"));
    assertEquals((listed.items as Json[]).map((item) => item.id), [file.id]);
    const restored = await ok(
      await call(
        fixture,
        "POST",
        "/v1/storage/entries/" + file.id + "/restore",
        {
          ifMatch: trashed.version as number,
        },
      ),
    );
    assertEquals([restored.path, restored.trashedAt, restored.trashedById], [
      "/shared/draft.md",
      null,
      null,
    ]);
    assertEquals(
      (await ok(await call(fixture, "GET", "/v1/storage/trash"))).items,
      [],
    );

    // Trash expires: the sweep removes what has been there past retention.
    const again = await ok(
      await call(fixture, "DELETE", "/v1/storage/entries/" + file.id, {
        ifMatch: restored.version as number,
      }),
    );
    await fixture.pgDatabase.query(
      "update bakery.storage_entries set trashed_at = now() - interval '31 days' where id = $1",
      [again.id],
    );
    const swept = await reapExpiredStorage(fixture.pgDatabase);
    assert(swept.trashed >= 1, JSON.stringify(swept));
    const gone = await fixture.pgDatabase.query(
      "select 1 from bakery.storage_entries where id = $1",
      [file.id],
    );
    assertEquals(gone.rows.length, 0);
  }));

Deno.test("kept files keep the newest N versions; scratch keeps the latest and expires", () =>
  withWorkerFixture(async (fixture) => {
    const settings = await ok(
      await call(fixture, "GET", "/v1/storage/settings"),
    );
    assertEquals(settings.customized, false);
    assertEquals(settings.workingVersionsKept, 20);
    const saved = await ok(
      await call(fixture, "PUT", "/v1/storage/settings", {
        body: {
          ...Object.fromEntries(
            [
              "trashRetentionDays",
              "scratchRetentionDays",
              "maxFileBytes",
              "organizationQuotaBytes",
              "projectQuotaBytes",
              "personalQuotaBytes",
            ].map((key) => [key, settings[key]]),
          ),
          workingVersionsKept: 2,
        },
      }),
    );
    assertEquals([saved.workingVersionsKept, saved.version], [2, 1]);

    let kept = await ok(await put(fixture, "/shared/kept.md", "v1"));
    for (const content of ["v2", "v3"]) {
      kept = await ok(
        await put(fixture, "/shared/kept.md", content, kept.version as number),
      );
    }
    assertEquals(kept.revision, 3);
    assertEquals(await versions(fixture, kept.id as string), 2);

    const scratchPath = "/users/" + fixture.principalId + "/scratch/tmp.txt";
    let scratch = await ok(await put(fixture, scratchPath, "a"));
    assertEquals(scratch.policy, "scratch");
    scratch = await ok(
      await put(fixture, scratchPath, "b", scratch.version as number),
    );
    assertEquals(await versions(fixture, scratch.id as string), 1);
    await fixture.pgDatabase.query(
      "update bakery.storage_entries set updated_at = now() - interval '31 days' where id = $1",
      [scratch.id],
    );
    const swept = await reapExpiredStorage(fixture.pgDatabase);
    assert(swept.scratch >= 1, JSON.stringify(swept));
    // A kept working file is never swept, however old.
    await fixture.pgDatabase.query(
      "update bakery.storage_entries set updated_at = now() - interval '400 days' where id = $1",
      [kept.id],
    );
    await reapExpiredStorage(fixture.pgDatabase);
    const left = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where id = any($1::uuid[])",
      [[scratch.id, kept.id]],
    );
    assertEquals(left.rows.map((row) => row.id), [kept.id]);
  }));

Deno.test("limits are organization settings and quotas pause writes at 90%", () =>
  withWorkerFixture(async (fixture) => {
    const defaults = await ok(
      await call(fixture, "GET", "/v1/storage/settings"),
    );
    const limits = {
      workingVersionsKept: 20,
      trashRetentionDays: 30,
      scratchRetentionDays: 30,
      maxFileBytes: 50,
      organizationQuotaBytes: 100,
      projectQuotaBytes: 100,
      personalQuotaBytes: 100,
    };
    await ok(
      await call(fixture, "PUT", "/v1/storage/settings", { body: limits }),
    );
    // A later save needs the current version.
    await problem(
      await call(fixture, "PUT", "/v1/storage/settings", { body: limits }),
      428,
      "PRECONDITION_REQUIRED",
    );
    await problem(
      await call(fixture, "PUT", "/v1/storage/settings", {
        body: { ...limits, workingVersionsKept: 0 },
        ifMatch: 1,
      }),
      400,
      "MALFORMED_REQUEST",
    );
    await problem(
      await put(fixture, "/shared/big.txt", "x".repeat(51)),
      422,
      "STORAGE_FILE_TOO_LARGE",
    );
    await ok(await put(fixture, "/shared/a.txt", "x".repeat(50)));
    const warn = await ok(await call(fixture, "GET", "/v1/storage/settings"));
    assertEquals([warn.organizationUsedBytes, warn.organizationQuotaState], [
      50,
      "ok",
    ]);
    await ok(await put(fixture, "/shared/b.txt", "x".repeat(30)));
    assertEquals(
      (await ok(await call(fixture, "GET", "/v1/storage/settings")))
        .organizationQuotaState,
      "warning",
    );
    const full = await problem(
      await put(fixture, "/shared/c.txt", "x".repeat(10)),
      409,
      "STORAGE_QUOTA_EXCEEDED",
    );
    assertEquals(full.reason, "organization");
    assert(defaults.version === 0);
  }));

Deno.test("Admin purge deletes for good, is Admin only and audited; foreign ids are 404", () =>
  withWorkerFixture(async (fixture) => {
    const file = await ok(await put(fixture, "/shared/leak.txt", "secret"));

    // Another organization's entry does not exist here.
    const other = await createWorkerScope(fixture, "storage-447", fixture);
    try {
      await purgeAcrossOrganizations(fixture, file, other.organizationId);
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, other.organizationId);
    }
  }));

async function purgeAcrossOrganizations(
  fixture: Fixture,
  file: Json,
  otherOrganizationId: string,
) {
  const foreign = await ok(
    await put(
      fixture,
      "/shared/theirs.txt",
      "theirs",
      undefined,
      otherOrganizationId,
    ),
  );
  for (
    const [method, suffix, body] of [
      ["DELETE", "", undefined],
      ["POST", "/move", { destinationPath: "/shared/mine.txt" }],
      ["POST", "/copy", { destinationPath: "/shared/mine.txt" }],
      ["POST", "/restore", undefined],
      ["POST", "/purge", undefined],
    ] as const
  ) {
    await problem(
      await call(
        fixture,
        method,
        "/v1/storage/entries/" + foreign.id + suffix,
        {
          body,
          ifMatch: 1,
        },
      ),
      404,
      "RESOURCE_NOT_FOUND",
    );
  }

  // A developer may not purge.
  await fixture.pgDatabase.query(
    "update bakery.organization_memberships set role = 'developer' where organization_id = $1 and principal_id = $2",
    [fixture.organizationId, fixture.principalId],
  );
  try {
    await problem(
      await call(fixture, "POST", "/v1/storage/entries/" + file.id + "/purge"),
      403,
      "AUTH_FORBIDDEN",
    );
  } finally {
    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set role = 'admin' where organization_id = $1 and principal_id = $2",
      [fixture.organizationId, fixture.principalId],
    );
  }

  const purged = await ok(
    await call(fixture, "POST", "/v1/storage/entries/" + file.id + "/purge"),
  );
  assertEquals([purged.entriesRemoved, purged.bytesRemoved], [1, 6]);
  const rows = await fixture.pgDatabase.query(
    "select 1 from bakery.storage_file_versions where entry_id = $1",
    [file.id],
  );
  assertEquals(rows.rows.length, 0);
  const audit = await fixture.pgDatabase.query<{ principal_id: string }>(
    "select principal_id from bakery.audit_events where organization_id = $1 and operation = 'storageEntries.purge' and resource_id = $2",
    [fixture.organizationId, file.id],
  );
  assertEquals(audit.rows.map((row) => row.principal_id), [
    fixture.principalId,
  ]);
  // The other organization's file is untouched.
  const theirs = await fixture.pgDatabase.query(
    "select 1 from bakery.storage_entries where id = $1",
    [foreign.id],
  );
  assertEquals(theirs.rows.length, 1);
}
