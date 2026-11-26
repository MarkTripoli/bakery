import type { MessageKey } from "@bakery/i18n";
import type {
  SkillDraftCheckResponse,
  SkillDraftResponse,
} from "../../api/client.ts";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import type { Words } from "./skills-state.ts";

export const SKILL_BYTES_LIMIT = 10 * 1024 * 1024;
export const SKILL_FILES_LIMIT = 256;
export const SKILL_NAME_LIMIT = 200;
export const SKILL_SLUG_LIMIT = 100;
export const SKILL_ENTRY_FILE = "SKILL.md";
export const SKILL_FILE_NAME_LIMIT = 500;

export type DraftFile = {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly isExecutable: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
};
export type DraftProblem = {
  readonly file: string | null;
  readonly line: number | null;
  readonly code: string;
  readonly message: string;
};
export type TypedDraft = Omit<SkillDraftResponse, "files"> & {
  readonly files: readonly DraftFile[];
};
export type TypedCheck = Omit<SkillDraftCheckResponse, "problems"> & {
  readonly problems: readonly DraftProblem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFile(value: unknown): DraftFile | null {
  if (!isRecord(value)) return null;
  const { id, path, mediaType, isExecutable, sizeBytes, sha256 } = value;
  return typeof id === "string" && typeof path === "string" &&
      typeof mediaType === "string" && typeof isExecutable === "boolean" &&
      typeof sizeBytes === "number" && typeof sha256 === "string"
    ? { id, path, mediaType, isExecutable, sizeBytes, sha256 }
    : null;
}

function asProblem(value: unknown): DraftProblem | null {
  if (!isRecord(value)) return null;
  const { file, line, code, message } = value;
  return typeof message === "string" && typeof code === "string"
    ? {
      file: typeof file === "string" ? file : null,
      line: typeof line === "number" ? line : null,
      code,
      message,
    }
    : null;
}

export function typedDraft(draft: SkillDraftResponse): TypedDraft {
  return {
    ...draft,
    files: draft.files.flatMap((value) => {
      const file = asFile(value);
      return file === null ? [] : [file];
    }),
  };
}

export function typedCheck(check: SkillDraftCheckResponse): TypedCheck {
  return {
    ...check,
    problems: check.problems.flatMap((value) => {
      const problem = asProblem(value);
      return problem === null ? [] : [problem];
    }),
  };
}

const TEXT_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/xml",
  "application/javascript",
  "application/x-sh",
]);

export function isTextMedia(mediaType: string): boolean {
  const base = mediaType.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("text/") || TEXT_TYPES.has(base) ||
    base.endsWith("+json") || base.endsWith("+xml");
}

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  py: "text/x-python",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  rb: "text/x-ruby",
  css: "text/css",
  html: "text/html",
};

const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "py",
  "js",
  "mjs",
  "ts",
  "rb",
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function mediaTypeOf(path: string): string {
  return MEDIA_BY_EXTENSION[extensionOf(path)] ?? "text/plain";
}

export function isScript(path: string): boolean {
  return SCRIPT_EXTENSIONS.has(extensionOf(path));
}

export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
export function slugOf(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SKILL_SLUG_LIMIT).replace(/-+$/g, "");
  return slug === "" ? "skill" : slug;
}

export function groupFiles(
  draft: Pick<TypedDraft, "files" | "entryPath">,
): { entry: DraftFile | null; others: DraftFile[] } {
  const entry = draft.files.find((file) => file.path === draft.entryPath) ??
    null;
  return {
    entry,
    others: draft.files.filter((file) => file !== entry),
  };
}
export function pathTaken(
  files: readonly DraftFile[],
  path: string,
  except?: string,
): boolean {
  const wanted = path.toLowerCase();
  return files.some((file) =>
    file.path !== except && file.path.toLowerCase() === wanted
  );
}

export type PathProblem = "empty" | "tooLong" | "invalid" | "taken" | "full";
export function pathProblem(
  files: readonly DraftFile[],
  path: string,
  except?: string,
): PathProblem | null {
  const text = path.trim();
  if (text === "") return "empty";
  if (text.length > SKILL_FILE_NAME_LIMIT) return "tooLong";
  if (
    text.startsWith("/") || text.endsWith("/") || text.includes("\\") ||
    text.split("/").some((part) => part === "" || part === "." || part === "..")
  ) return "invalid";
  if (pathTaken(files, text, except)) return "taken";
  if (except === undefined && files.length >= SKILL_FILES_LIMIT) return "full";
  return null;
}

const SHOWN_NAME_LIMIT = 34;

export function shortName(path: string): string {
  return path.length <= SHOWN_NAME_LIMIT
    ? path
    : `${path.slice(0, 16)}…${path.slice(-17)}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function sizeWords(
  draft: Pick<TypedDraft, "files" | "totalBytes">,
  locale: string,
): Words {
  const megabytes = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: draft.totalBytes === 0 ? 0 : 1,
  }).format(draft.totalBytes / (1024 * 1024));
  return {
    key: "library.skills.editor.size" as MessageKey,
    values: { used: megabytes, count: draft.files.length },
  };
}
export function problemWords(problem: DraftProblem): Words {
  if (problem.code === "license") {
    return {
      key: "library.skills.editor.problems.licence" as MessageKey,
      values: {},
    };
  }
  if (problem.file === null) {
    return {
      key: "library.skills.editor.problems.whole" as MessageKey,
      values: { message: problem.message },
    };
  }
  return problem.line === null
    ? {
      key: "library.skills.editor.problems.file" as MessageKey,
      values: { file: problem.file, message: problem.message },
    }
    : {
      key: "library.skills.editor.problems.line" as MessageKey,
      values: {
        file: problem.file,
        line: problem.line,
        message: problem.message,
      },
    };
}

export type DraftFailure =
  | "forbidden"
  | "conflict"
  | "tooLarge"
  | "rejected"
  | "nameTaken"
  | "offline"
  | "failed";

export function draftFailure(error: unknown): DraftFailure {
  if (asyncKindForError(error) === "offline") return "offline";
  switch (failureStatus(error)) {
    case 403:
      return "forbidden";
    case 409:
      return "nameTaken";
    case 412:
      return "conflict";
    case 413:
      return "tooLarge";
    case 422:
      return "rejected";
    default:
      return "failed";
  }
}
