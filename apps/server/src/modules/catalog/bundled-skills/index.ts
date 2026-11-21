import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { type LocalSkillVersionInput, skillFileSha256 } from "../validation.ts";

/**
 * A skill package that comes with Bakery. Its files live beside this module,
 * one directory per package, and every organization gets the same bytes, so the
 * digest of what is installed is the digest of what ships.
 */
export type BundledSkill = Readonly<{
  /** Directory name and the slug the installed skill is listed under. */
  slug: string;
  /** What the installed skill is called. */
  name: string;
  license: string;
  entryPath: string;
  files: readonly Readonly<{
    path: string;
    mediaType: string;
    content: Uint8Array;
  }>[];
}>;

const PACKAGES = [
  {
    slug: "bakery-authoring",
    name: "Writing a Bakery skill",
    license: "Apache-2.0",
    entryPath: "SKILL.md",
    files: [{ path: "SKILL.md", mediaType: "text/markdown" }],
  },
] as const;

let loaded: Promise<readonly BundledSkill[]> | undefined;

/** Every bundled package, read once per process. */
export function bundledSkills(): Promise<readonly BundledSkill[]> {
  loaded ??= Promise.all(PACKAGES.map(async (entry) =>
    Object.freeze({
      slug: entry.slug,
      name: entry.name,
      license: entry.license,
      entryPath: entry.entryPath,
      files: await Promise.all(entry.files.map(async (file) =>
        Object.freeze({
          path: file.path,
          mediaType: file.mediaType,
          content: new Uint8Array(
            await readFile(
              new URL(`./${entry.slug}/${file.path}`, import.meta.url),
            ),
          ),
        })
      )),
    })
  ));
  return loaded;
}

/** The upload a package is validated and published as, at one revision of one skill. */
export async function bundledSkillUpload(
  skill: BundledSkill,
  skillId: string,
  revision: number,
): Promise<LocalSkillVersionInput> {
  const files = await Promise.all(skill.files.map(async (file) => ({
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.content.byteLength,
    sha256: await skillFileSha256(file.content),
    isExecutable: false,
  })));
  return {
    id: skillId,
    revision,
    digest: "",
    entryPath: skill.entryPath,
    manifest: {
      schemaVersion: 1,
      license: skill.license,
      entryPath: skill.entryPath,
      files,
    },
    files: skill.files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      isExecutable: false,
      contentBase64: Buffer.from(file.content).toString("base64"),
    })),
  };
}
