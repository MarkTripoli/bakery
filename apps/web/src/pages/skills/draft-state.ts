import type {
  SkillDraftCheckResponse,
  SkillDraftResponse,
} from "../../api/client.ts";

export const SKILL_DRAFT_LIMIT_BYTES = 10_000_000;
export const SKILL_DRAFT_LIMIT_FILES = 256;

export type DraftProblem = Readonly<{
  file: string | null;
  line: number | null;
  code: string;
  message: string;
}>;

const TEXT_MEDIA = [
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "image/svg+xml",
];

export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA.includes(mediaType);
}

export function encodeSkillText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeSkillText(contentBase64: string): string {
  const binary = atob(contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

export function skillSlugIsTaken(
  name: string,
  existing: readonly string[],
): boolean {
  const slug = slugFromName(name);
  return slug !== "" && existing.includes(slug);
}

export function formatDraftBytes(bytes: number): string {
  if (bytes < 100_000) return `${Math.round(bytes / 1_000)} KB`;
  const value = bytes / 1_000_000;
  return `${value === Math.round(value) ? `${value}` : value.toFixed(1)} MB`;
}

export function draftWouldOverflow(bytes: number): boolean {
  return bytes > SKILL_DRAFT_LIMIT_BYTES;
}

export function problemsOf(check: SkillDraftCheckResponse): DraftProblem[] {
  return (check.problems as readonly unknown[]).flatMap(
    (candidate: unknown) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const row = candidate as Record<string, unknown>;
      const message = typeof row.message === "string" ? row.message : "";
      if (message === "") return [];
      return [{
        file: typeof row.file === "string" && row.file !== "" ? row.file : null,
        line: typeof row.line === "number" && Number.isInteger(row.line)
          ? row.line
          : null,
        code: typeof row.code === "string" ? row.code : "",
        message,
      }];
    },
  );
}

export function checkIsStale(
  check: SkillDraftCheckResponse,
  draft: SkillDraftResponse,
): boolean {
  return check.draftVersion !== draft.version;
}

export type DraftFile = Readonly<{
  id: string;
  path: string;
  mediaType: string;
  isExecutable: boolean;
  sizeBytes: number;
}>;

export function draftFilesOf(draft: SkillDraftResponse): DraftFile[] {
  return (draft.files as readonly unknown[]).flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.path !== "string") return [];
    return [{
      id: row.id,
      path: row.path,
      mediaType: typeof row.mediaType === "string"
        ? row.mediaType
        : "text/plain",
      isExecutable: row.isExecutable === true,
      sizeBytes: typeof row.sizeBytes === "number" ? row.sizeBytes : 0,
    }];
  });
}
