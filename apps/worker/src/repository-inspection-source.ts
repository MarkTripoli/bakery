import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "../../../packages/config/src/env.ts";
import {
  type RepositoryInspectionJobInput,
  RepositoryInspectionJobInputSchema,
  type RepositoryInspectionReceipt,
  RepositoryInspectionSourceEnvelopeSchema,
} from "../../../packages/contracts/src/repository-inspection.ts";
import type { WorkerApiClient } from "./client.ts";
import type { JobAssignment, WorkerSessionFields } from "./types.ts";

export function inspectionCanonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (
      input === null || typeof input === "string" || typeof input === "boolean"
    ) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input).sort().map((
          key,
        ) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    }
    throw new Error("INSPECTION_CANONICAL_INVALID");
  };
  return JSON.stringify(sort(value));
}
export async function inspectionDigest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function inspectionDecodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error("INSPECTION_BASE64_INVALID");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export type LoadedRepositoryInspection = {
  input: RepositoryInspectionJobInput;
  receipt: RepositoryInspectionReceipt;
  sourceDirectory: string;
};

export async function loadRepositoryInspectionSource(options: {
  client: WorkerApiClient;
  assignment: JobAssignment;
  authority: WorkerSessionFields & { workerHostId: string };
  directory: string;
  signal: AbortSignal;
}): Promise<LoadedRepositoryInspection> {
  const { client, assignment, authority, directory, signal } = options;
  const input = RepositoryInspectionJobInputSchema.parse(assignment.input);
  if (input.jobId !== assignment.jobId) {
    throw new Error("INSPECTION_JOB_MISMATCH");
  }
  if (
    await inspectionDigest(
        new TextEncoder().encode(inspectionCanonicalJson(input.profile.config)),
      ) !== input.profile.digest ||
    input.profile.config.branches.base !== input.baseline.defaultBranch
  ) throw new Error("INSPECTION_PROFILE_INVALID");
  const buffer = new Uint8Array(input.source.envelopeBytes);
  let receipt: RepositoryInspectionReceipt | undefined;
  let offset = 0;
  const inputDigest = await inspectionDigest(
    new TextEncoder().encode(inspectionCanonicalJson(input)),
  );
  let created = false;
  const sourceDirectory = `${directory}/source`;
  try {
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const chunk = await client.getRepositorySource(assignment.attemptId, {
        leaseToken: assignment.leaseToken,
        fence: String(assignment.fence),
        ...authority,
        offset,
        maxBytes: Math.min(LIMITS.chunkBytes, buffer.length - offset),
      }, signal);
      const next = chunk.value;
      const bytes = inspectionDecodeBase64(next.bytesBase64);
      if (
        bytes.length === 0 || bytes.length > LIMITS.chunkBytes ||
        next.offset !== offset || next.totalBytes !== buffer.length ||
        offset + bytes.length > buffer.length ||
        next.done !== (offset + bytes.length === buffer.length) ||
        await inspectionDigest(bytes) !== next.chunkDigest
      ) throw new Error("INSPECTION_CHUNK_INVALID");
      const current = next.receipt;
      if (
        current.inspectionId !== input.inspectionId ||
        current.jobId !== input.jobId ||
        current.organizationId !== input.organizationId ||
        current.applicationId !== input.applicationId ||
        current.repositoryId !== input.repositoryId ||
        current.attemptId !== assignment.attemptId ||
        current.fence !== String(assignment.fence) ||
        current.workerHostId !== authority.workerHostId ||
        current.workerSessionId !== authority.workerSessionId ||
        current.workerSessionGeneration !== authority.workerSessionGeneration ||
        current.inputDigest !== inputDigest ||
        inspectionCanonicalJson(current.source) !==
          inspectionCanonicalJson(input.source) ||
        Date.parse(current.expiresAt) <= Date.now()
      ) throw new Error("INSPECTION_RECEIPT_INVALID");
      if (
        receipt &&
        inspectionCanonicalJson(receipt) !== inspectionCanonicalJson(current)
      ) throw new Error("INSPECTION_RECEIPT_CHANGED");
      receipt = current;
      buffer.set(bytes, offset);
      offset += bytes.length;
    }
    if (
      !receipt || await inspectionDigest(buffer) !== input.source.envelopeDigest
    ) throw new Error("INSPECTION_ENVELOPE_INVALID");
    const envelope = RepositoryInspectionSourceEnvelopeSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
    );
    if (
      new TextEncoder().encode(inspectionCanonicalJson(envelope)).length !==
        buffer.length ||
      inspectionCanonicalJson(envelope) !== new TextDecoder().decode(buffer) ||
      envelope.organizationId !== input.organizationId ||
      envelope.applicationId !== input.applicationId ||
      envelope.repositoryId !== input.repositoryId ||
      inspectionCanonicalJson(envelope.source) !==
        inspectionCanonicalJson({
          mappingRevision: input.source.mappingRevision,
          mappingDigest: input.source.mappingDigest,
          baseSha: input.source.baseSha,
          manifestDigest: input.source.manifestDigest,
        }) ||
      envelope.entries.length !== input.source.entryCount
    ) throw new Error("INSPECTION_SOURCE_IDENTITY_INVALID");
    let total = 0;
    let prior = "";
    const manifest: {
      path: string;
      mode: string;
      sha256: string;
      size: number;
    }[] = [];
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const entry of envelope.entries) {
      signal.throwIfAborted();
      const bytes = inspectionDecodeBase64(entry.contentBase64);
      total += bytes.length;
      if (
        entry.path <= prior || bytes.length > LIMITS.fileBytes ||
        total > LIMITS.decodedBytes ||
        await inspectionDigest(bytes) !== entry.sha256
      ) throw new Error("INSPECTION_FILE_INVALID");
      prior = entry.path;
      manifest.push({
        path: entry.path,
        mode: entry.mode,
        sha256: entry.sha256,
        size: bytes.length,
      });
      files.push({ path: entry.path, bytes });
    }
    if (
      total !== input.source.decodedBytes ||
      await inspectionDigest(
          new TextEncoder().encode(inspectionCanonicalJson(manifest)),
        ) !== input.source.manifestDigest
    ) throw new Error("INSPECTION_MANIFEST_INVALID");
    for (const check of input.profile.config.checkPolicy.checks) {
      if (
        check.template !== "node.syntax.v1" &&
        check.template !== "deno.check.v1"
      ) continue;
      if (
        check.paths.length === 0 ||
        (check.template === "node.syntax.v1" && check.paths.length !== 1)
      ) throw new Error("INSPECTION_TEMPLATE_INVALID");
      for (const path of check.paths) {
        const file = files.find((candidate) => candidate.path === path);
        if (!file) throw new Error("INSPECTION_TEMPLATE_FILE_MISSING");
        if (
          check.template === "node.syntax.v1" &&
          (check.tool !== "node" || !/\.(?:js|cjs|mjs)$/.test(path))
        ) throw new Error("INSPECTION_TEMPLATE_INVALID");
        if (
          check.template === "deno.check.v1" &&
          (check.tool !== "deno" || !/\.(?:ts|js)$/.test(path) ||
            /\b(?:import|from|require)\b|<reference\b|sourceMappingURL|sourceURL|\\u/
              .test(
                new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
              ))
        ) throw new Error("INSPECTION_TEMPLATE_INVALID");
      }
    }
    await Deno.mkdir(directory, { mode: 0o700 });
    created = true;
    // This owned enclosing scope blocks host package-type inheritance without
    // adding to or overwriting any canonical repository file.
    await Deno.writeTextFile(`${directory}/package.json`, "{}\n", {
      createNew: true,
      mode: 0o400,
    });
    await Deno.mkdir(sourceDirectory, { mode: 0o700 });
    const directories = new Set<string>();
    for (const file of files) {
      signal.throwIfAborted();
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = `${sourceDirectory}/${parts.slice(0, index).join("/")}`;
        if (!directories.has(parent)) {
          await Deno.mkdir(parent, { mode: 0o700 });
          directories.add(parent);
        }
      }
      await Deno.writeFile(`${sourceDirectory}/${file.path}`, file.bytes, {
        createNew: true,
        mode: 0o400,
      });
    }
    for (const path of [...directories].sort((a, b) => b.length - a.length)) {
      await Deno.chmod(path, 0o500);
    }
    await Deno.chmod(sourceDirectory, 0o500);
    await Deno.chmod(directory, 0o500);
    signal.throwIfAborted();
    if (Date.parse(receipt.expiresAt) <= Date.now()) {
      throw new Error("INSPECTION_RECEIPT_EXPIRED");
    }
    return { input, receipt, sourceDirectory };
  } catch (error) {
    if (created) await removeRepositoryInspectionDirectory(directory);
    throw error;
  }
}

export async function removeRepositoryInspectionDirectory(
  directory: string,
): Promise<void> {
  try {
    const stat = await Deno.lstat(directory);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new Error("INSPECTION_CLEANUP_INVALID");
    }
    const writable = async (path: string): Promise<void> => {
      await Deno.chmod(path, 0o700);
      for await (const entry of Deno.readDir(path)) {
        if (entry.isDirectory && !entry.isSymlink) {
          await writable(`${path}/${entry.name}`);
        }
      }
    };
    await writable(directory);
    await Deno.remove(directory, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
