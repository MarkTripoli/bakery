import { parse as parseYaml } from "yaml";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  compareByCodeUnitPath,
  isSkillExecutableMedia,
  skillFileSha256,
} from "./validation.ts";

export type SkillMdSourceFile = Readonly<{
  path: string;
  content: Uint8Array;
  isExecutable: boolean;
}>;

export type SkillMdManifestFile = Readonly<{
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  isExecutable: boolean;
}>;

export type SkillMdManifest = Readonly<{
  schemaVersion: 1;
  name: string;
  description: string;
  license: string;
  entryPath: "SKILL.md";
  files: readonly SkillMdManifestFile[];
  digest: string;
}>;

export class SkillMdManifestInvalid extends Error {
  constructor() {
    super("SKILL_MD_MANIFEST_INVALID");
    this.name = "SkillMdManifestInvalid";
  }
}

const SKILL_MD = "SKILL.md";
const MAX_NAME_LENGTH = 200;
const FRONT_MATTER_FENCE = "---";

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
};

function invalid(): never {
  throw new SkillMdManifestInvalid();
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function frontMatterLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== FRONT_MATTER_FENCE) invalid();
  const end = lines.findIndex((line, index) =>
    index > 0 && line.trimEnd() === FRONT_MATTER_FENCE
  );
  if (end < 0) invalid();
  return lines.slice(1, end);
}

export function parseSkillMdFrontMatter(
  text: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatterLines(text).join("\n"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    });
  } catch {
    return invalid();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalid();
  }
  return parsed as Record<string, unknown>;
}

function isDisallowedControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a);
}

function boundedText(value: unknown, maxLength?: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 1 || (maxLength !== undefined && text.length > maxLength)) {
    invalid();
  }
  if ([...text].some(isDisallowedControl)) invalid();
  return text;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function skillFileMediaType(file: SkillMdSourceFile): string {
  const known = MEDIA_TYPE_BY_EXTENSION[extension(file.path)];
  const textual = decodeUtf8(file.content) !== null;
  const mediaType = known ??
    (textual ? "text/plain" : "application/octet-stream");
  if (file.isExecutable && !isSkillExecutableMedia(mediaType)) {
    return textual ? "text/plain" : "application/octet-stream";
  }
  return mediaType;
}

export async function deriveSkillMdManifest(
  files: readonly SkillMdSourceFile[],
  license: string,
): Promise<SkillMdManifest> {
  const entry = files.find((file) => file.path === SKILL_MD);
  if (!entry) invalid();
  const text = decodeUtf8(entry.content);
  if (text === null) invalid();
  const frontMatter = parseSkillMdFrontMatter(text);
  const name = boundedText(frontMatter.name, MAX_NAME_LENGTH);
  const description = boundedText(frontMatter.description);
  const described = await Promise.all(files.map(async (file) => ({
    path: file.path,
    mediaType: skillFileMediaType(file),
    sizeBytes: file.content.byteLength,
    sha256: await skillFileSha256(file.content),
    isExecutable: file.isExecutable,
  })));
  described.sort(compareByCodeUnitPath);
  const unsigned = {
    schemaVersion: 1 as const,
    name,
    description,
    license,
    entryPath: SKILL_MD as typeof SKILL_MD,
    files: described,
  };
  return Object.freeze({
    ...unsigned,
    files: Object.freeze(described.map((file) => Object.freeze(file))),
    digest: await sha256Hex(canonicalJson(unsigned)),
  });
}
