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
): Promise<{ skillId: string; versionId: string; digest: string }> {
  const createSkill = await fixture.post(
    cookie,
    "/v1/skills",
    { slug, name: story },
    crypto.randomUUID(),
  );
  assertEquals(createSkill.status, 201, await createSkill.clone().text());
  const skill = await createSkill.json() as { id: string };
  const markdownDigest = await sha256(markdown);
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
      revision: 1,
      digest,
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(markdown),
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

Deno.test("a person reads one version by id, and only a version they may see", async () => {
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
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${crypto.randomUUID().toUpperCase()}`,
      )).status,
      404,
    );
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a person reads one file's verified bytes, and nothing they may not", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-files-" });
  const fixture = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const shared = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-files",
      "Readable files",
    );
    const path = `/v1/skill-versions/${shared.versionId}/files/SKILL.md`;
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
      `/v1/skill-versions/${shared.versionId}/files/scripts/ready.sh`,
    );
    assertEquals(nested.status, 200, await nested.clone().text());
    assertEquals(nested.headers.get("content-type"), "text/x-shellscript");
    assertEquals(await nested.text(), new TextDecoder().decode(script));

    // A path the manifest does not name is not found.
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${shared.versionId}/files/SECRET.md`,
      )).status,
      404,
    );
    // A path that climbs out of the version is not a path this contract has: it
    // is refused as malformed before any row is read.
    assertEquals(
      (await fixture.read(
        fixture.ownerCookie,
        `/v1/skill-versions/${shared.versionId}/files/..%2F..%2Fetc%2Fpasswd`,
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
      [fixture.organizationId, shared.versionId],
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

    // A file of someone else's personal version is not found, and says nothing.
    const personal = await publishVersion(
      fixture,
      fixture.ownerCookie,
      "readable-personal-files",
      "Readable personal files",
    );
    await fixture.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'personal', owner_principal_id = $2 where id = $1",
      [personal.skillId, fixture.ownerPrincipalId],
    );
    const hidden = await fixture.read(
      fixture.adminCookie,
      `/v1/skill-versions/${personal.versionId}/files/SKILL.md`,
    );
    assertEquals(hidden.status, 404, await hidden.clone().text());
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});
