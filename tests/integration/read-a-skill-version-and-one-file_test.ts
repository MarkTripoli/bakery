/**
 * #74: a person reads one skill version, and one of its files.
 *
 * The skill page lists a version's files from its manifest, and the browser has
 * no way to read what is in one. These two reads are what it needs: the version
 * by id, so a copy can name the version it came from without listing the whole
 * history, and the file's bytes, verified against the digest the version was
 * published with.
 *
 * Each test would pass for the wrong reason if the read answered 404 to
 * everything, so the positive case comes first and asserts the facts; the
 * refusals below it say what may not be read.
 */
import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { authTestOrigin, signSessionCookie } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fixture = Awaited<ReturnType<typeof openPersonalSkillFixture>>;

const markdown = new TextEncoder().encode(
  "# Readable skill\n\nDo the thing.\n",
);
const script = new TextEncoder().encode("#!/bin/sh\nprintf ready\n");

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Publishes one version with two files, through the real API. */
async function publishVersion(
  fixture: Fixture,
  cookie: string,
  slug: string,
  story: string,
  options: {
    skillId?: string;
    revision?: number;
    markdown?: Uint8Array;
  } = {},
): Promise<{ skillId: string; versionId: string; digest: string }> {
  const entry = options.markdown ?? markdown;
  const skillId = options.skillId ?? await (async () => {
    const createSkill = await fixture.post(
      cookie,
      "/v1/skills",
      { slug, name: story },
      crypto.randomUUID(),
    );
    assertEquals(createSkill.status, 201, await createSkill.clone().text());
    return (await createSkill.json() as { id: string }).id;
  })();
  const skill = { id: skillId };
  const markdownDigest = await sha256(entry);
  const scriptDigest = await sha256(script);
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: markdown.byteLength,
      sha256: markdownDigest,
      isExecutable: false,
    }, {
      path: "scripts/ready.sh",
      mediaType: "text/x-shellscript",
      sizeBytes: script.byteLength,
      sha256: scriptDigest,
      isExecutable: true,
    }],
  };
  const digest = await sha256Hex(canonicalJson(manifest));
  const publish = await fixture.post(
    cookie,
    `/v1/skills/${skill.id}/versions`,
    {
      revision: options.revision ?? 1,
      digest,
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(entry),
      }, {
        path: "scripts/ready.sh",
        mediaType: "text/x-shellscript",
        isExecutable: true,
        contentBase64: base64(script),
      }],
    },
    crypto.randomUUID(),
  );
  assertEquals(publish.status, 201, await publish.clone().text());
  const version = await publish.json() as { id: string };
  return { skillId: skill.id, versionId: version.id, digest };
}

/** A read that names another organization, as a caller would. */
async function readIn(
  fixture: Fixture,
  cookie: string,
  organizationId: string,
  path: string,
): Promise<Response> {
  return await fixture.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      headers: { cookie, "Bakery-Organization-Id": organizationId },
    }),
  );
}

/**
 * A second organization with the same person as its Admin: a tenant boundary is
 * a boundary even when the caller is a member somewhere else.
 */
async function otherOrganization(fixture: Fixture): Promise<string> {
  const organizationId = crypto.randomUUID();
  await fixture.fixture.pgDatabase.query(
    `insert into bakery.organizations (id, name, slug, created_at, updated_at)
     values ($1, 'Other Org', $2, now(), now())`,
    [organizationId, `other-${organizationId}`],
  );
  await fixture.fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at
     ) values ($1, $2, $3, 'admin', 'active', now(), now(), now())`,
    [crypto.randomUUID(), organizationId, fixture.adminPrincipalId],
  );
  return organizationId;
}

/**
 * A Viewer of the same organization: a role that may read a lot, but not these
 * two, and the same answer from both is what keeps the fence honest.
 */
async function addViewer(fixture: Fixture): Promise<string> {
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `skill-viewer-${crypto.randomUUID()}`;
  const now = new Date();
  await fixture.fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Viewer', $2, true, $3, $3)`,
    [userId, `viewer-${userId}@example.test`, now],
  );
  await fixture.fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Viewer', 'human')`,
    [principalId, userId],
  );
  await fixture.fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, 'viewer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, now],
  );
  await fixture.fixture.pgDatabase.query(
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
  return await signSessionCookie(token, fixture.fixture.config.auth!.secret);
}

Deno.test("a person reads one version and one file, and nothing they may not", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-reads-" });
  const fixture = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const shared = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-shared",
      "Readable shared",
    );
    // The list is what the page falls back to today; the read must agree with it.
    const list = await fixture.read(
      fixture.ownerCookie,
      `/v1/skills/${shared.skillId}/versions`,
    );
    assertEquals(list.status, 200);
    const listed = (await list.json() as { items: Record<string, unknown>[] })
      .items[0];
    const read = await fixture.read(
      fixture.ownerCookie,
      `/v1/skill-versions/${shared.versionId}`,
    );
    assertEquals(read.status, 200, await read.clone().text());
    const version = await read.json() as Record<string, unknown>;
    assertEquals(version.id, shared.versionId);
    assertEquals(version.skillId, shared.skillId);
    assertEquals(version.revision, 1);
    assertEquals(version.digest, shared.digest);
    assertEquals(version.entryPath, "SKILL.md");
    // The same projection the list returns, not a narrower one.
    assertEquals(Object.keys(version).sort(), Object.keys(listed).sort());

    // Both reads carry the same role fence: a Viewer who may not read the
    // record does not read its bytes either, and says so the same way.
    const viewer = await addViewer(fixture);
    const viewerVersion = await fixture.read(
      viewer,
      `/v1/skill-versions/${shared.versionId}`,
    );
    const viewerFile = await fixture.read(
      viewer,
      `/v1/skill-versions/${shared.versionId}/files/SKILL.md`,
    );
    // The version read answers not-found to a Viewer; the bytes must answer
    // the same, or the fence is only as strong as the weaker read.
    assertEquals(viewerVersion.status, 404, await viewerVersion.clone().text());
    assertEquals(viewerFile.status, 404, await viewerFile.clone().text());
    assertEquals(
      (await viewerVersion.json() as { code: string }).code,
      (await viewerFile.json() as { code: string }).code,
    );

    // Another Admin of the organization reads the organization's skill too.
    const adminRead = await fixture.read(
      fixture.adminCookie,
      `/v1/skill-versions/${shared.versionId}`,
    );
    assertEquals(adminRead.status, 200, await adminRead.clone().text());

    // A personal skill stays its owner's: not found, never forbidden.
    const personal = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-personal",
      "Readable personal",
    );
    await fixture.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'personal', owner_principal_id = $2 where id = $1",
      [personal.skillId, fixture.ownerPrincipalId],
    );
    const hidden = await fixture.read(
      fixture.adminCookie,
      `/v1/skill-versions/${personal.versionId}`,
    );
    assertEquals(hidden.status, 404, await hidden.clone().text());
    assertEquals(
      (await hidden.json() as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${personal.versionId}`,
      )).status,
      200,
    );

    // Another organization cannot read the version even naming its id: the read
    // answers not-found, the same way the listing would not show it.
    const elsewhere = await otherOrganization(fixture);
    const crossTenant = await readIn(
      fixture,
      fixture.adminCookie,
      elsewhere,
      `/v1/skill-versions/${shared.versionId}`,
    );
    assertEquals(crossTenant.status, 404, await crossTenant.clone().text());
    assertEquals(
      (await crossTenant.json() as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );

    // A reserved draft is not a version yet, and the listing hides it.
    const draftId = `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`;
    await fixture.fixture.pgDatabase.query(
      `insert into bakery.skill_versions (
         id, organization_id, skill_id, revision, source_revision, digest,
         entry_path, manifest, status, created_by
       ) values ($1, $2, $3, 2, 'rev-2', $4, 'SKILL.md', '{}'::jsonb,
                 'draft', $5)`,
      [
        draftId,
        fixture.organizationId,
        shared.skillId,
        "d".repeat(64),
        fixture.ownerPrincipalId,
      ],
    );
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${draftId}`,
      )).status,
      404,
    );
    // The draft's own file row exists and points at real bytes, so the read
    // that refuses it is refusing the draft, not the missing row.
    await fixture.fixture.pgDatabase.query(
      `insert into bakery.skill_files (
         organization_id, skill_version_id, path, media_type, object_key,
         size_bytes, sha256, is_executable
       )
       select $1, $2, path, media_type, object_key, size_bytes, sha256,
              is_executable
         from bakery.skill_files
        where organization_id = $1 and skill_version_id = $3 and path = 'SKILL.md'`,
      [fixture.organizationId, draftId, shared.versionId],
    );
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${draftId}/files/SKILL.md`,
      )).status,
      404,
    );
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${crypto.randomUUID().toUpperCase()}`,
      )).status,
      404,
    );
    // --- the same person reads one file's verified bytes ---
    const files = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-files",
      "Readable files",
    );
    const path = `/v1/skill-versions/${files.versionId}/files/SKILL.md`;
    const file = await fixture.read(fixture.ownerCookie, path);
    assertEquals(file.status, 200, await file.clone().text());
    // The headers describe the stored file, and the body is the published bytes.
    assertEquals(file.headers.get("content-type"), "text/markdown");
    assertEquals(
      file.headers.get("content-length"),
      String(markdown.byteLength),
    );
    assertEquals(file.headers.get("etag"), `"${await sha256(markdown)}"`);
    assertEquals(file.headers.get("cache-control"), "private, no-store");
    assertEquals(file.headers.get("x-content-type-options"), "nosniff");
    assert(
      file.headers.get("content-disposition")?.includes("attachment") === true,
    );
    assertEquals(await file.text(), new TextDecoder().decode(markdown));

    // A nested path is a path, not a query.
    const nested = await fixture.read(
      fixture.ownerCookie,
      `/v1/skill-versions/${files.versionId}/files/scripts/ready.sh`,
    );
    assertEquals(nested.status, 200, await nested.clone().text());
    assertEquals(nested.headers.get("content-type"), "text/x-shellscript");
    assertEquals(await nested.text(), new TextDecoder().decode(script));

    // A path the manifest does not name is not found.
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${files.versionId}/files/SECRET.md`,
      )).status,
      404,
    );
    // A path that climbs out of the version is not a path this contract has: it
    // is refused as malformed before any row is read.
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${files.versionId}/files/..%2F..%2Fetc%2Fpasswd`,
      )).status,
      400,
    );

    // Bytes that no longer match the published digest are refused, not served.
    const stored = await fixture.fixture.pgDatabase.query<{
      object_key: string;
      sha256: string;
      size_bytes: number;
    }>(
      `select object_key, sha256, size_bytes from bakery.skill_files
        where organization_id = $1 and skill_version_id = $2 and path = 'SKILL.md'`,
      [fixture.organizationId, files.versionId],
    );
    const object = stored.rows[0];
    // Same length, different bytes: the digest is the only thing wrong.
    const replaced = new TextEncoder().encode(
      new TextDecoder().decode(markdown).replace("skill", "SKILL"),
    );
    assertEquals(replaced.byteLength, markdown.byteLength);
    await Deno.writeFile(`${root}/${object.object_key}`, replaced);
    const tampered = await fixture.read(fixture.ownerCookie, path);
    assertEquals(tampered.status, 409, await tampered.clone().text());
    assertEquals(
      (await tampered.json() as { code: string }).code,
      "SKILL_CONTENT_INTEGRITY_FAILED",
    );
    // A different length is an object the store will not even trust as stored:
    // refused as unavailable rather than reported as a digest mismatch.
    await Deno.writeFile(
      `${root}/${object.object_key}`,
      new TextEncoder().encode("# Not the published bytes\n"),
    );
    assertEquals(
      (await fixture.read(fixture.ownerCookie, path)).status,
      503,
    );
    // Putting the published bytes back makes the read work again, which proves
    // the refusal was about the bytes and not about the file being gone.
    await Deno.writeFile(`${root}/${object.object_key}`, markdown);
    assertEquals(
      (await fixture.read(fixture.ownerCookie, path)).status,
      200,
    );

    // The same path in a later version is that version's own bytes: the read
    // is keyed to the version in the URL, not to the path alone.
    const later = new TextEncoder().encode(
      new TextDecoder().decode(markdown).replace("skill", "SKILL"),
    );
    assertEquals(later.byteLength, markdown.byteLength);
    const second = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-files",
      "Readable files",
      { skillId: files.skillId, revision: 2, markdown: later },
    );
    const firstRead = await fixture.read(fixture.ownerCookie, path);
    const secondRead = await fixture.read(
      fixture.ownerCookie,
      `/v1/skill-versions/${second.versionId}/files/SKILL.md`,
    );
    assertEquals(firstRead.status, 200);
    assertEquals(secondRead.status, 200, await secondRead.clone().text());
    assertEquals(await firstRead.text(), new TextDecoder().decode(markdown));
    assertEquals(await secondRead.text(), new TextDecoder().decode(later));
    assertEquals(
      secondRead.headers.get("etag"),
      `"${await sha256(later)}"`,
    );

    // Another organization gets no bytes either.
    const filesCrossTenant = await readIn(
      fixture,
      fixture.adminCookie,
      await otherOrganization(fixture),
      path,
    );
    assertEquals(
      filesCrossTenant.status,
      404,
      await filesCrossTenant.clone().text(),
    );
    // A problem document, not the file: no bytes leak with the refusal.
    assertEquals(
      (await filesCrossTenant.json() as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );

    // A file of someone else's personal version is not found, and says nothing.
    const personalFiles = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-personal-files",
      "Readable personal files",
    );
    await fixture.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'personal', owner_principal_id = $2 where id = $1",
      [personalFiles.skillId, fixture.ownerPrincipalId],
    );
    const hiddenFile = await fixture.read(
      fixture.adminCookie,
      `/v1/skill-versions/${personal.versionId}/files/SKILL.md`,
    );
    assertEquals(hiddenFile.status, 404, await hiddenFile.clone().text());
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});
