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

function fail(message: string): never {
  throw new Error(`SKILL_UPLOAD_INVALID:${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) fail("PATH_BOUNDS");
  const path = raw.normalize("NFC");
  if (
    path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.endsWith("/") || path.includes("//")
  ) fail("PATH_UNSAFE");
  const segments = path.split("/");
  if (
    segments.some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail("PATH_UNSAFE");
  }
  if (path.length > MAX_PATH_LENGTH) fail("PATH_BOUNDS");
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
): Promise<ValidatedSkillVersion> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    fail("REVISION");
  }
  if (!DIGEST.test(input.digest)) fail("DIGEST");
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
  for (const file of input.files) {
    const path = normalizePath(file.path);
    const identity = pathIdentity(path);
    if (identities.has(identity)) fail("PATH_COLLISION");
    identities.add(identity);
    const expectedFile = expectedFiles.get(identity);
    if (!expectedFile || expectedFile.path !== path) fail("MANIFEST_FILES");
    if (
      !MEDIA.test(file.mediaType) || file.mediaType !== expectedFile.mediaType
    ) fail("MEDIA_TYPE");
    if (file.isExecutable !== expectedFile.isExecutable) {
      fail("EXECUTABLE_POLICY");
    }
    if (file.isExecutable && !executableMediaAllowed(file.mediaType)) {
      fail("EXECUTABLE_MEDIA");
    }
    if (file.contentBase64.length > MAX_BASE64_FILE_LENGTH) fail("FILE_BYTES");
    const expected = expectedDecodedBytes(file.contentBase64);
    if (
      expected > MAX_DECODED_FILE_BYTES ||
      totalBytes > MAX_DECODED_FILE_BYTES - expected
    ) fail("FILE_BYTES");
    if (
      !BASE64.test(file.contentBase64) || file.contentBase64.length % 4 !== 0
    ) fail("BASE64");
    const content = strictBase64(file.contentBase64);
    if (
      content.byteLength !== expected ||
      content.byteLength !== expectedFile.sizeBytes
    ) fail("FILE_SIZE");
    const fileSha256 = await sha256(content);
    if (fileSha256 !== expectedFile.sha256) fail("FILE_HASH");
    totalBytes += content.byteLength;
    files.push({
      path,
      mediaType: file.mediaType,
      isExecutable: file.isExecutable,
      content,
      sha256: fileSha256,
      sizeBytes: content.byteLength,
    });
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
  if (digest !== input.digest) fail("MANIFEST_DIGEST");
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
