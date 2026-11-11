import {
  contractSchemas,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_METADATA_BYTES,
  MAX_ARTIFACT_METADATA_DEPTH,
  MEDIA_TYPE_MAX_LENGTH,
  MEDIA_TYPE_PATTERN,
} from "@bakery/contracts/contracts";
import { parseIdempotencyKey, StandardError } from "@bakery/contracts/http";
import { classifyArtifactMedia } from "./media.ts";

const MAX_MULTIPART_BYTES = MAX_ARTIFACT_BYTES + 1_048_576;
const SERIALIZED_NUL_PATTERN = /(^|[^\\])(?:\\\\)*\\u0000/;

function exceedsMetadataDepth(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.value === null ||
      typeof current.value !== "object"
    ) continue;
    if (current.depth >= MAX_ARTIFACT_METADATA_DEPTH) return true;
    if (seen.has(current.value)) return true;
    seen.add(current.value);
    const nextDepth = current.depth + 1;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      pending.push({ value: child, depth: nextDepth });
    }
  }
  return false;
}

function containsUnpairedSurrogate(value: unknown): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsUnpairedSurrogate);
  return Object.entries(value).some(([key, child]) =>
    containsUnpairedSurrogate(key) || containsUnpairedSurrogate(child)
  );
}
const ARTIFACT_FORM_FIELDS: Record<string, true> = {
  content: true,
  metadata: true,
  artifactType: true,
  name: true,
  contentType: true,
  contentDigest: true,
  leaseToken: true,
  fence: true,
  runStepId: true,
  subjectHeadSha: true,
  subjectBaseSha: true,
  stepKey: true,
  workerSessionId: true,
  workerSessionGeneration: true,
};

export function isArtifactMediaType(value: string): boolean {
  return value.length <= MEDIA_TYPE_MAX_LENGTH &&
    MEDIA_TYPE_PATTERN.test(value);
}

export type ArtifactUpload = {
  idempotencyKey: string;
  leaseToken: string;
  fence: string;
  artifactType: string;
  name: string;
  contentType: string;
  contentDigest?: string;
  contentSha256?: string;
  content: Uint8Array;
  runStepId?: string | null;
  subjectHeadSha?: string | null;
  subjectBaseSha?: string | null;
  stepKey?: string | null;
  workerSessionId?: string | null;
  workerSessionGeneration?: string | null;
  parentVersionId?: string | null;
  metadata: unknown;
};

export async function sha256Bytes(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    content as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validateWorkerArtifactScalars(input: ArtifactUpload): void {
  const result = contractSchemas.WorkerArtifact.safeParse({
    leaseToken: input.leaseToken,
    fence: input.fence,
    artifactType: input.artifactType,
    name: input.name,
    contentType: input.contentType,
    ...(input.contentDigest !== undefined
      ? { contentDigest: input.contentDigest }
      : {}),
    content: input.content,
    runStepId: input.runStepId ?? null,
    subjectHeadSha: input.subjectHeadSha ?? null,
    subjectBaseSha: input.subjectBaseSha ?? null,
    stepKey: input.stepKey ?? null,
    metadata: input.metadata,
    ...(input.workerSessionId != null
      ? { workerSessionId: input.workerSessionId }
      : {}),
    ...(input.workerSessionGeneration != null
      ? { workerSessionGeneration: input.workerSessionGeneration }
      : {}),
  });
  if (!result.success) {
    throw new StandardError({ code: "UNPROCESSABLE", cause: result.error });
  }
}

export function validateArtifactUpload(input: ArtifactUpload): void {
  if (exceedsMetadataDepth(input.metadata)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  validateWorkerArtifactScalars(input);
  const media = classifyArtifactMedia({
    declaredType: input.contentType,
    content: input.content,
  });
  if (media === null) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  input.contentType = media.mediaType;
  let serializedMetadata: string;
  try {
    serializedMetadata = JSON.stringify(input.metadata);
  } catch {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (typeof serializedMetadata !== "string") {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (
    input.name.includes("\0") ||
    input.stepKey?.includes("\0") === true ||
    SERIALIZED_NUL_PATTERN.test(serializedMetadata) ||
    containsUnpairedSurrogate(input.metadata) ||
    (input.contentSha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(input.contentSha256)) ||
    input.metadata === null ||
    typeof input.metadata !== "object" ||
    Array.isArray(input.metadata)
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    !/^\d+$/.test(contentLength)
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (
    contentLength !== null &&
    Number(contentLength) > MAX_MULTIPART_BYTES
  ) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }
  if (request.body === null) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (request.signal.aborted) {
    throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  let completed = false;
  const abort = () => {
    cancelled = true;
    void reader.cancel("multipart request aborted").catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_MULTIPART_BYTES) {
        cancelled = true;
        await reader.cancel("multipart body too large").catch(() => undefined);
        throw new StandardError({ code: "BODY_TOO_LARGE" });
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (request.signal.aborted) {
      throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    completed = true;
    return body;
  } catch (cause) {
    if (!cancelled) {
      cancelled = true;
      await reader.cancel(cause).catch(() => undefined);
    }
    if (request.signal.aborted) {
      throw new StandardError({ code: "DEPENDENCY_TIMEOUT", cause });
    }
    throw cause;
  } finally {
    request.signal.removeEventListener("abort", abort);
    if (!completed) chunks.length = 0;
    reader.releaseLock();
  }
}

export async function readArtifactUpload(
  request: Request,
): Promise<ArtifactUpload> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data;")) {
    throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const body = await readBoundedBody(request);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body.buffer as ArrayBuffer,
    }).formData();
  } catch (cause) {
    throw new StandardError({ code: "UNPROCESSABLE", cause });
  }
  const entries = Array.from(form.entries());
  if (
    entries.length > Object.keys(ARTIFACT_FORM_FIELDS).length ||
    entries.some(([name]) => !Object.hasOwn(ARTIFACT_FORM_FIELDS, name)) ||
    new Set(entries.map(([name]) => name)).size !== entries.length
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const text = (name: string, required = true): string | null => {
    const value = form.get(name);
    if (value === null) {
      if (required) throw new StandardError({ code: "UNPROCESSABLE" });
      return null;
    }
    if (typeof value !== "string") {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
    return value;
  };
  const file = form.get("content");
  if (!(file instanceof File)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (file.size > MAX_ARTIFACT_BYTES) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }
  let content: Uint8Array;
  try {
    content = new Uint8Array(await file.arrayBuffer());
  } catch (cause) {
    throw new StandardError({ code: "UNPROCESSABLE", cause });
  }
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }
  const metadataText = text("metadata")!;
  if (
    new TextEncoder().encode(metadataText).byteLength >
      MAX_ARTIFACT_METADATA_BYTES
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch (cause) {
    throw new StandardError({ code: "UNPROCESSABLE", cause });
  }
  if (
    metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  // The worker route fingerprints metadata before publication validation.
  // Bound its shape before canonicalJson recursively walks it.
  if (exceedsMetadataDepth(metadata)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const artifactType = text("artifactType")!;
  const name = text("name")!;
  const contentType = text("contentType")!;
  const upload: ArtifactUpload = {
    idempotencyKey,
    leaseToken: text("leaseToken")!,
    fence: text("fence")!,
    artifactType,
    name,
    contentType,
    contentDigest: text("contentDigest", false) ?? undefined,
    content,
    runStepId: text("runStepId", false),
    subjectHeadSha: text("subjectHeadSha", false),
    subjectBaseSha: text("subjectBaseSha", false),
    stepKey: text("stepKey", false),
    workerSessionId: text("workerSessionId", false),
    workerSessionGeneration: text("workerSessionGeneration", false),
    parentVersionId: request.headers.get("if-match") ?? null,
    metadata,
  };
  upload.contentSha256 = await sha256Bytes(content);
  return upload;
}
