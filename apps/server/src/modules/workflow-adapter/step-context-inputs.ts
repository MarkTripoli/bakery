import type { PgTransactionClient } from "@bakery/persistence";
import { insertRunInputPin } from "../work/run-input-pins.ts";

/**
 * One input slot of a step as admission pinned it. The shape is the contract's
 * `StepContextInput`; `kind` is null because a workflow declares a kind on an
 * output slot, never on an input.
 */
export type PinnedStepInput = Readonly<{
  slot: string;
  path: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  kind: string | null;
}>;

/** The most slots one step may pin (the compiler caps them at the same number). */
export const MAX_STEP_CONTEXT_INPUTS = 32;

export type StepInputPinning =
  | Readonly<{ ok: true; inputs: readonly PinnedStepInput[] }>
  | Readonly<{ ok: false; code: string; message: string }>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SLOT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** File extension a slot's bytes get, so a step can tell how to read them. */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = Object.freeze(
  {
    "text/markdown": "md",
    "text/plain": "txt",
    "application/json": "json",
    "text/csv": "csv",
    "application/yaml": "yaml",
    "text/yaml": "yaml",
  },
);

/** The path a slot's bytes are written to, relative to the context directory. */
export function stepInputPath(slot: string, mediaType: string): string {
  const bare = mediaType.split(";")[0]!.trim().toLowerCase();
  return `${slot}.${EXTENSION_BY_MEDIA_TYPE[bare] ?? "bin"}`;
}

function refuse(slot: string, reason: string): StepInputPinning {
  return {
    ok: false,
    code: "STEP_INPUT_UNAVAILABLE",
    message: `Input slot ${slot} cannot be pinned: ${reason}.`,
  };
}

/**
 * What a slot's value names. A slot is normally bound to an artifact version id
 * (`$step.brief.artifact.versionId`); a full artifact reference is accepted
 * too, and then its artifact id and digest are checked against the stored
 * version rather than trusted.
 */
function artifactReference(
  value: unknown,
): { versionId: string; artifactId?: string; sha256?: string } | null {
  if (typeof value === "string") {
    return UUID_PATTERN.test(value) ? { versionId: value } : null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { artifactId, versionId, sha256 } = value as Record<string, unknown>;
  if (typeof versionId !== "string" || !UUID_PATTERN.test(versionId)) {
    return null;
  }
  if (
    artifactId !== undefined &&
    (typeof artifactId !== "string" || !UUID_PATTERN.test(artifactId))
  ) return null;
  if (
    sha256 !== undefined &&
    (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))
  ) return null;
  return {
    versionId,
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

/**
 * Pins what each declared input slot of a step resolved to.
 *
 * The slot's value must name an artifact version, by id or by full reference.
 * The version is read for the organization; a reference that also names an
 * artifact or a digest must match the stored version, so a reference whose bytes
 * moved is refused, never followed. Each version is pinned for the run, so the route that
 * serves an attempt's inputs checks the same digest, and the returned list is
 * what the job carries to the worker. A step with no slots pins nothing.
 */
export async function pinStepContextInputs(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    runId: string;
    slots: readonly Readonly<{ slot: string; value: unknown }>[];
  },
): Promise<StepInputPinning> {
  if (options.slots.length > MAX_STEP_CONTEXT_INPUTS) {
    return refuse("*", "the step declares more slots than a step may pin");
  }
  const pinned: PinnedStepInput[] = [];
  const seen = new Set<string>();
  for (const { slot, value } of options.slots) {
    if (!SLOT_PATTERN.test(slot) || seen.has(slot)) {
      return refuse(slot, "the slot name is not a unique file stem");
    }
    seen.add(slot);
    const reference = artifactReference(value);
    if (reference === null) {
      return refuse(slot, "its value does not name an artifact version");
    }
    const found = await transaction.query<{
      id: string;
      artifact_id: string;
      sha256: string;
      size_bytes: number | string;
      media_type: string;
      publication_status: string;
    }>(
      `select id, artifact_id, sha256, size_bytes, media_type, publication_status
         from bakery.artifact_versions
        where organization_id = $1 and id = $2::uuid`,
      [options.organizationId, reference.versionId],
    );
    const version = found.rows[0];
    if (!version) return refuse(slot, "the artifact version does not exist");
    // A staged version is unvetted and a refused one failed its kind (O29): a
    // step never pins either.
    if (version.publication_status !== "current") {
      return refuse(
        slot,
        `artifact version ${version.id} is ${version.publication_status}, not current`,
      );
    }
    if (
      reference.artifactId !== undefined &&
      version.artifact_id !== reference.artifactId
    ) {
      return refuse(slot, "the version belongs to another artifact");
    }
    if (reference.sha256 !== undefined && version.sha256 !== reference.sha256) {
      return refuse(slot, "the version no longer has the referenced digest");
    }
    const sizeBytes = Number(version.size_bytes);
    await insertRunInputPin(transaction, {
      organizationId: options.organizationId,
      runId: options.runId,
      artifactId: version.artifact_id,
      versionId: version.id,
      sha256: version.sha256,
      sizeBytes,
    });
    pinned.push({
      slot,
      path: stepInputPath(slot, version.media_type),
      digest: version.sha256,
      sizeBytes,
      mediaType: version.media_type,
      kind: null,
    });
  }
  return { ok: true, inputs: Object.freeze(pinned) };
}
