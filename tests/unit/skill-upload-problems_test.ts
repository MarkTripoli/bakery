import { assertEquals, assertRejects } from "@std/assert";
import {
  SkillUploadInvalid,
  skillUploadIssues,
  validateLocalSkillVersion,
} from "../../apps/server/src/modules/catalog/validation.ts";

const encoder = new TextEncoder();

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

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** A one-file-per-entry upload whose manifest lists exactly what was meant. */
async function upload(
  files: readonly { path: string; meant: string; sent: string | null }[],
  license: string | null = "MIT",
) {
  const listed = [];
  const sent = [];
  for (const file of files) {
    const meant = encoder.encode(file.meant);
    listed.push({
      path: file.path,
      mediaType: "text/markdown",
      sizeBytes: meant.byteLength,
      sha256: await sha256(meant),
      isExecutable: false,
    });
    sent.push({
      path: file.path,
      mediaType: "text/markdown",
      isExecutable: false,
      // null stands for contents that are not base64 at all.
      contentBase64: file.sent === null
        ? "!!!!"
        : base64(encoder.encode(file.sent)),
    });
  }
  return {
    id: crypto.randomUUID(),
    revision: 1,
    digest: "0".repeat(64),
    entryPath: "SKILL.md",
    manifest: {
      schemaVersion: 1,
      ...(license === null ? {} : { license }),
      entryPath: "SKILL.md",
      files: listed,
    },
    files: sent,
  };
}

Deno.test("an upload with several broken files reports each one by position, in plain words", async () => {
  const input = await upload([
    { path: "SKILL.md", meant: "# Skill", sent: "# Skill" },
    { path: "notes.md", meant: "the notes", sent: "the notez" },
    { path: "broken.md", meant: "broken", sent: null },
    { path: "also.md", meant: "ok", sent: "ok" },
  ]);
  const error = await assertRejects(
    () => validateLocalSkillVersion(input),
    SkillUploadInvalid,
    "SKILL_UPLOAD_INVALID:FILE_HASH",
  );
  assertEquals(
    skillUploadIssues(error).map(({ path, code }) => ({ path, code })),
    [
      { path: ["files", 1], code: "file_hash" },
      { path: ["files", 2], code: "base64" },
    ],
  );
  for (const issue of skillUploadIssues(error)) {
    assertEquals(issue.message.endsWith("."), true, issue.message);
    assertEquals(issue.message.includes("FILE_HASH"), false);
  }
});

Deno.test("a manifest or request problem names the field, not a file", async () => {
  const noLicense = await upload(
    [{ path: "SKILL.md", meant: "# Skill", sent: "# Skill" }],
    null,
  );
  const license = await assertRejects(
    () => validateLocalSkillVersion(noLicense),
    SkillUploadInvalid,
  );
  assertEquals(skillUploadIssues(license).map((i) => i.path), [[
    "manifest",
    "license",
  ]]);

  const wrongDigest = await upload([
    { path: "SKILL.md", meant: "# Skill", sent: "# Skill" },
  ]);
  const digest = await assertRejects(
    () => validateLocalSkillVersion(wrongDigest),
    SkillUploadInvalid,
    "MANIFEST_DIGEST",
  );
  assertEquals(skillUploadIssues(digest).map((i) => i.path), [["digest"]]);

  const missingEntry = await upload([
    { path: "other.md", meant: "x", sent: "x" },
  ]);
  const entry = await assertRejects(
    () => validateLocalSkillVersion(missingEntry),
    SkillUploadInvalid,
  );
  assertEquals(skillUploadIssues(entry).map((i) => i.path), [["entryPath"]]);
});
