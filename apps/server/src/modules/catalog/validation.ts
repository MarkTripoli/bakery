import { contractSchemas } from "@bakery/contracts/contracts";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { unicodeDefaultCaseFold } from "./unicode-case-fold.ts";
import type { z } from "zod";

export const MAX_DECODED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 256;
export const MAX_MANIFEST_BYTES = 262_144;
export const MAX_PATH_LENGTH = 500;
const MAX_BASE64_FILE_LENGTH = 4 * Math.ceil(MAX_DECODED_FILE_BYTES / 3);

export type LocalSkillVersionInput = z.output<
  typeof contractSchemas.LocalSkillVersion
>;
export type ValidatedSkillFile = {
  path: string;
  mediaType: string;
  isExecutable: boolean;
  content: Uint8Array;
  sha256: string;
  sizeBytes: number;
};
export type ValidatedSkillVersion = {
  skillId: string;
  revision: number;
  digest: string;
  entryPath: string;
  manifest: Record<string, unknown>;
  canonicalManifest: string;
  files: readonly ValidatedSkillFile[];
};

const DIGEST = /^[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*;[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*=[ \t]*(?:"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"|[!#$%&'*+\-.^_`|~0-9A-Za-z]+))?)*$/;
const OMIT_FROM_CANONICAL = new Set([
  "bytes",
  "content",
  "contentBase64",
  "digest",
  "objectKey",
  "storageKey",
]);

/**
 * An upload that cannot be published. It names the rule that failed and, when
 * one file broke it, which file, so the editor can show the problem beside the
 * file. The message keeps the code the tests and logs have always matched.
 */
export class SkillUploadInvalid extends Error {
  readonly code: string;
  /** Position of the file in the upload, when one file broke the rule. */
  readonly fileIndex: number | undefined;
  /** Every file problem found in one pass; the first is also this error. */
  readonly problems: readonly { code: string; fileIndex: number }[];
  constructor(
    code: string,
    fileIndex?: number,
    problems: readonly { code: string; fileIndex: number }[] = [],
  ) {
    super(`SKILL_UPLOAD_INVALID:${code}`);
    this.name = "SkillUploadInvalid";
    this.code = code;
    this.fileIndex = fileIndex;
    this.problems = problems;
  }
}

/** What each rule means to the person who broke it, in plain words. */
const UPLOAD_PROBLEM_MESSAGES: Readonly<Record<string, string>> = Object.freeze(
  {
    PATH_BOUNDS: "The file name is empty or longer than 500 characters.",
    PATH_UNSAFE:
      "The file name must be a plain relative path: no leading or trailing slash, no backslash, no empty or .. parts.",
    PATH_COLLISION: "Another file has the same name once capitals are ignored.",
    MANIFEST_FILES:
      "The manifest does not list this file under this name, or lists it differently.",
    MEDIA_TYPE:
      "The file type is not the one the manifest lists for this file.",
    EXECUTABLE_POLICY:
      "The manifest and the upload disagree on whether this file can be run.",
    EXECUTABLE_MEDIA: "Only a script can be marked as runnable.",
    FILE_BYTES: "The file is too large: all files together may hold 10 MiB.",
    BASE64: "The file's contents are not valid base64.",
    FILE_SIZE: "The file's size is not the size the manifest lists.",
    FILE_HASH:
      "The file's contents are not what the manifest fingerprinted; it changed after the manifest was made.",
    REVISION: "The version number must be a whole number from 1.",
    DIGEST:
      "The version fingerprint must be 64 lowercase hexadecimal characters.",
    MANIFEST_SCHEMA: "The manifest is missing, or is not schema version 1.",
    MANIFEST_VALUE: "The manifest holds a value that cannot be stored.",
    LICENSE: "The manifest needs a license of 1 to 200 printable characters.",
    FILE_COUNT:
      "The number of files uploaded is not the number the manifest lists.",
    ENTRY_PATH: "The entry file is not among the uploaded files.",
    MANIFEST_BYTES: "The manifest is too large.",
    MANIFEST_DIGEST:
      "The version fingerprint does not match the manifest and files uploaded.",
  },
);

/** Where in the request each upload rule applies when no one file broke it. */
const UPLOAD_PROBLEM_PATHS: Readonly<Record<string, readonly string[]>> = Object
  .freeze({
    REVISION: ["revision"],
    DIGEST: ["digest"],
    MANIFEST_DIGEST: ["digest"],
    ENTRY_PATH: ["entryPath"],
    LICENSE: ["manifest", "license"],
    FILE_COUNT: ["files"],
  });

/** The issues a failed upload reports: one per file that broke a rule, or one. */
export function skillUploadIssues(error: SkillUploadInvalid) {
  const issue = (code: string, fileIndex: number | undefined) => ({
    path: fileIndex === undefined
      ? [...(UPLOAD_PROBLEM_PATHS[code] ?? ["manifest"])]
      : ["files", fileIndex],
    code: code.toLowerCase(),
    message: UPLOAD_PROBLEM_MESSAGES[code] ?? "The upload cannot be published.",
  });
  return error.problems.length > 0
    ? error.problems.slice(0, 20).map((p) => issue(p.code, p.fileIndex))
    : [issue(error.code, error.fileIndex)];
}

function fail(message: string, fileIndex?: number): never {
  throw new SkillUploadInvalid(message, fileIndex);
}

/** The path rules an upload applies to a file name, for a draft to share. */
export function normalizeSkillFilePath(raw: string): string {
  return normalizePath(raw);
}

/** Two names that collide once case and Unicode forms are ignored have one identity. */
export function skillFileIdentity(path: string): string {
  return pathIdentity(path);
}

/** Whether a string is an acceptable media type for a skill file. */
export function isSkillMediaType(value: string): boolean {
  return MEDIA.test(value);
}

/** Whether a file of this media type may be marked runnable. */
export function compareByCodeUnitPath(
  left: Readonly<{ path: string }>,
  right: Readonly<{ path: string }>,
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function isSkillExecutableMedia(mediaType: string): boolean {
  return executableMediaAllowed(mediaType);
}

/** Decodes one file's base64 under the limits an upload has. */
export function decodeSkillFileBase64(
  contentBase64: string,
): Uint8Array {
  if (contentBase64.length > MAX_BASE64_FILE_LENGTH) fail("FILE_BYTES");
  const expected = expectedDecodedBytes(contentBase64);
  if (expected > MAX_DECODED_FILE_BYTES) fail("FILE_BYTES");
  if (!BASE64.test(contentBase64) || contentBase64.length % 4 !== 0) {
    fail("BASE64");
  }
  const content = strictBase64(contentBase64);
  if (content.byteLength !== expected) fail("FILE_SIZE");
  return content;
}

/** SHA-256 of some bytes as lowercase hex. */
export function skillFileSha256(content: Uint8Array): Promise<string> {
  return sha256(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(raw: string, fileIndex?: number): string {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) {
    fail("PATH_BOUNDS", fileIndex);
  }
  const path = raw.normalize("NFC");
  if (
    path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.endsWith("/") || path.includes("//")
  ) fail("PATH_UNSAFE", fileIndex);
  const segments = path.split("/");
  if (
    segments.some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail("PATH_UNSAFE", fileIndex);
  }
  if (path.length > MAX_PATH_LENGTH) fail("PATH_BOUNDS", fileIndex);
  return path;
}

function pathIdentity(path: string): string {
  return unicodeDefaultCaseFold(path);
}

function strictBase64(value: string): Uint8Array {
  if (!BASE64.test(value) || value.length % 4 !== 0) fail("BASE64");
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    fail("BASE64");
  }
}

function expectedDecodedBytes(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function executableMediaAllowed(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0].toLowerCase();
  return essence === "application/octet-stream" ||
    essence === "application/x-sh" ||
    essence === "application/x-shellscript" ||
    essence === "application/x-python" ||
    essence === "text/plain" ||
    essence === "text/x-shellscript" ||
    essence === "text/x-python";
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

function canonicalManifestValue(value: unknown, key?: string): unknown {
  if (key !== undefined && OMIT_FROM_CANONICAL.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalManifestValue(entry)).filter((entry) =>
      entry !== undefined
    );
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(value).sort()) {
      const child = canonicalManifestValue(value[name], name);
      if (child !== undefined) result[name] = child;
    }
    return result;
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  fail("MANIFEST_VALUE");
}

function canonicalManifest(
  manifest: Record<string, unknown>,
  files: readonly ValidatedSkillFile[],
  entryPath: string,
): string {
  const copy = canonicalManifestValue(manifest) as Record<string, unknown>;
  copy.entryPath = entryPath;
  copy.files = files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    isExecutable: file.isExecutable,
  })).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return canonicalJson(copy);
}

type ManifestFile = {
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  isExecutable: boolean;
};

function manifestFiles(
  manifest: Record<string, unknown>,
): Map<string, ManifestFile> {
  if (
    !Array.isArray(manifest.files) || manifest.files.length > MAX_UPLOAD_FILES
  ) {
    fail("MANIFEST_FILES");
  }
  const result = new Map<string, ManifestFile>();
  for (const value of manifest.files) {
    if (!isRecord(value) || typeof value.path !== "string") {
      fail("MANIFEST_FILES");
    }
    const path = normalizePath(value.path);
    const identity = pathIdentity(path);
    if (result.has(identity)) fail("PATH_COLLISION");
    if (
      typeof value.mediaType !== "string" || !MEDIA.test(value.mediaType) ||
      typeof value.sha256 !== "string" || !DIGEST.test(value.sha256) ||
      typeof value.sizeBytes !== "number" ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0 || typeof value.isExecutable !== "boolean"
    ) fail("MANIFEST_FILES");
    if (value.isExecutable && !executableMediaAllowed(value.mediaType)) {
      fail("EXECUTABLE_MEDIA");
    }
    result.set(identity, {
      path,
      mediaType: value.mediaType,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
      isExecutable: value.isExecutable,
    });
  }
  return result;
}

/** Validates and hashes a complete local bundle without selecting any storage path from input. */
export async function validateLocalSkillVersion(
  input: LocalSkillVersionInput,
  /**
   * `computeDigest` checks everything but the supplied fingerprint and returns
   * the one the files and manifest make: a draft is checked and published that
   * way, because its author never computes a fingerprint.
   */
  options: { readonly computeDigest?: boolean } = {},
): Promise<ValidatedSkillVersion> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    fail("REVISION");
  }
  if (!options.computeDigest && !DIGEST.test(input.digest)) fail("DIGEST");
  const entryPath = normalizePath(input.entryPath);
  if (!isRecord(input.manifest)) fail("MANIFEST_SCHEMA");
  if (input.manifest.schemaVersion !== 1) fail("MANIFEST_SCHEMA");
  const license = input.manifest.license;
  if (
    typeof license !== "string" || license.length < 1 || license.length > 200 ||
    !/^[\x20-\x7e]+$/.test(license)
  ) fail("LICENSE");
  const expectedFiles = manifestFiles(input.manifest);
  if (
    input.files.length > MAX_UPLOAD_FILES ||
    input.files.length !== expectedFiles.size
  ) {
    fail("FILE_COUNT");
  }
  const identities = new Set<string>();
  const files: ValidatedSkillFile[] = [];
  let totalBytes = 0;
  const problems: { code: string; fileIndex: number }[] = [];
  for (const [index, file] of input.files.entries()) {
    try {
      const path = normalizePath(file.path, index);
      const identity = pathIdentity(path);
      if (identities.has(identity)) fail("PATH_COLLISION", index);
      identities.add(identity);
      const expectedFile = expectedFiles.get(identity);
      if (!expectedFile || expectedFile.path !== path) {
        fail("MANIFEST_FILES", index);
      }
      if (
        !MEDIA.test(file.mediaType) || file.mediaType !== expectedFile.mediaType
      ) fail("MEDIA_TYPE", index);
      if (file.isExecutable !== expectedFile.isExecutable) {
        fail("EXECUTABLE_POLICY", index);
      }
      if (file.isExecutable && !executableMediaAllowed(file.mediaType)) {
        fail("EXECUTABLE_MEDIA", index);
      }
      if (file.contentBase64.length > MAX_BASE64_FILE_LENGTH) {
        fail("FILE_BYTES", index);
      }
      const expected = expectedDecodedBytes(file.contentBase64);
      if (
        expected > MAX_DECODED_FILE_BYTES ||
        totalBytes > MAX_DECODED_FILE_BYTES - expected
      ) fail("FILE_BYTES", index);
      if (
        !BASE64.test(file.contentBase64) || file.contentBase64.length % 4 !== 0
      ) fail("BASE64", index);
      const content = strictBase64(file.contentBase64);
      if (
        content.byteLength !== expected ||
        content.byteLength !== expectedFile.sizeBytes
      ) fail("FILE_SIZE", index);
      const fileSha256 = await sha256(content);
      if (fileSha256 !== expectedFile.sha256) fail("FILE_HASH", index);
      totalBytes += content.byteLength;
      files.push({
        path,
        mediaType: file.mediaType,
        isExecutable: file.isExecutable,
        content,
        sha256: fileSha256,
        sizeBytes: content.byteLength,
      });
    } catch (error) {
      // One file's problem does not hide another's: all are reported together.
      if (
        error instanceof SkillUploadInvalid && error.fileIndex !== undefined
      ) {
        problems.push({ code: error.code, fileIndex: error.fileIndex });
        continue;
      }
      throw error;
    }
  }
  if (problems.length > 0) {
    throw new SkillUploadInvalid(
      problems[0].code,
      problems[0].fileIndex,
      problems,
    );
  }
  if (!files.some((file) => file.path === entryPath)) fail("ENTRY_PATH");
  if (input.manifest.entryPath !== undefined) {
    if (
      typeof input.manifest.entryPath !== "string" ||
      normalizePath(input.manifest.entryPath) !== entryPath
    ) {
      fail("ENTRY_PATH");
    }
  }
  const canonical = canonicalManifest(input.manifest, files, entryPath);
  if (new TextEncoder().encode(canonical).byteLength > MAX_MANIFEST_BYTES) {
    fail("MANIFEST_BYTES");
  }
  const digest = await sha256(new TextEncoder().encode(canonical));
  if (!options.computeDigest && digest !== input.digest) {
    fail("MANIFEST_DIGEST");
  }
  return {
    skillId: input.id,
    revision: input.revision,
    digest,
    entryPath,
    manifest: JSON.parse(canonical) as Record<string, unknown>,
    canonicalManifest: canonical,
    files,
  };
}
