import { assert, assertEquals } from "@std/assert";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

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

Deno.test("publishing a skill with broken files answers 422 with one plain problem per file", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const created = await f.post(
      f.ownerCookie,
      "/v1/skills",
      { slug: "problems", name: "Problems" },
      "skill-problems",
    );
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const meant = ["# Skill", "the notes", "references"];
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: await Promise.all(
        ["SKILL.md", "notes.md", "docs/guide.md"].map(async (path, index) => ({
          path,
          mediaType: "text/markdown",
          sizeBytes: encoder.encode(meant[index]).byteLength,
          sha256: await sha256(encoder.encode(meant[index])),
          isExecutable: false,
        })),
      ),
    };
    const sent = ["# Skill", "the notez", "references!!"];
    const response = await f.post(
      f.ownerCookie,
      `/v1/skills/${skill.id}/versions`,
      {
        revision: 1,
        digest: "0".repeat(64),
        entryPath: "SKILL.md",
        manifest,
        files: manifest.files.map((file, index) => ({
          path: file.path,
          mediaType: file.mediaType,
          isExecutable: false,
          contentBase64: btoa(
            String.fromCharCode(...encoder.encode(sent[index])),
          ),
        })),
      },
      "publish-problems",
    );
    assertEquals(response.status, 422, await response.clone().text());
    const problem = await response.json() as {
      code: string;
      issues: { path: (string | number)[]; code: string; message: string }[];
    };
    assertEquals(problem.code, "UNPROCESSABLE");
    assertEquals(
      problem.issues.map(({ path, code }) => ({ path, code })),
      [
        { path: ["files", 1], code: "file_hash" },
        { path: ["files", 2], code: "file_size" },
      ],
    );
    assert(problem.issues.every((issue) => !issue.message.includes("_")));
  } finally {
    await f.close();
  }
});
