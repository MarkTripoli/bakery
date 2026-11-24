import type { PgTransactionClient } from "@bakery/persistence";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { isOrganizationAdmin } from "../knowledge/folder-access-store.ts";
import { readableEntry } from "../knowledge/storage-reads.ts";
import {
  pinStoragePath,
  StorageNameError,
  type StoragePin,
  storageQueryOf,
} from "../knowledge/storage-tree.ts";

export type ConnectionInputIngest = (path: string) => Promise<StoragePin>;

/**
 * The key an input value uses to declare a pinned artifact version.
 *
 * A run's declared inputs are free JSON, so the one structural fact this module
 * fixes is how an input names a version. Keeping it a single well-known key
 * means the pin is a value in the run's own inputs rather than a second place
 * a caller has to remember to update.
 */
export const DECLARED_ARTIFACT_VERSION_KEY = "artifactVersionId";

/**
 * Refuses a version that is not published as current (O29, #437).
 *
 * A version under a kind with a probe-backed rule is staged until the probe
 * answers and refused if the answer fails the kind; a run must never pin bytes
 * that are unvetted or were refused. The issue names the version and its status
 * so a caller can tell "wait for the probe" from "pick another version".
 */
export function assertPinnableVersion(
  path: readonly (string | number)[],
  version: { readonly id: string; readonly publication_status: string },
): void {
  if (version.publication_status === "current") return;
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: [{
        path,
        code: "input_artifact_version_not_current",
        message:
          `artifact version ${version.id} is ${version.publication_status}, not current, so it cannot be a run input`,
      }],
    },
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every artifact version id the input tree declares, in first-seen order and
 * without duplicates.
 *
 * A version named twice is pinned once: the pin is keyed by the run and the
 * version, so repetition carries no extra meaning and a duplicate insert would
 * only be noise.
 */
export function declaredArtifactVersionIds(inputs: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (
      const [key, child] of Object.entries(value as Record<string, unknown>)
    ) {
      if (key === DECLARED_ARTIFACT_VERSION_KEY && typeof child === "string") {
        if (!seen.has(child)) {
          seen.add(child);
          ids.push(child);
        }
        continue;
      }
      walk(child);
    }
  };
  walk(inputs);
  return ids;
}

/** Pins one version for a run: the row a worker's read is checked against. */
export async function insertRunInputPin(
  transaction: PgTransactionClient,
  pin: {
    organizationId: string;
    runId: string;
    artifactId: string;
    versionId: string;
    sha256: string;
    sizeBytes: number;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.run_input_pins (
       organization_id, run_id, artifact_id, artifact_version_id,
       sha256, size_bytes
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (organization_id, run_id, artifact_version_id) do nothing`,
    [
      pin.organizationId,
      pin.runId,
      pin.artifactId,
      pin.versionId,
      pin.sha256,
      pin.sizeBytes,
    ],
  );
}

/**
 * Pins, at admission, the exact version each declared input resolved to.
 *
 * The pin carries the digest and size the bytes had at this moment, so a later
 * publication of the same path cannot change what the run reads. A declared
 * version that does not exist for this organization is refused here rather
 * than left to fail later as a hole in the context: a partial pin must not
 * produce a context with missing files.
 */
export async function pinDeclaredRunInputs(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    runId: string;
    inputs: unknown;
  },
): Promise<void> {
  for (const versionId of declaredArtifactVersionIds(options.inputs)) {
    if (!UUID_PATTERN.test(versionId)) {
      throw unprocessable(
        ["inputs"],
        "input_artifact_version_invalid",
      );
    }
    const version = await transaction.query<
      {
        id: string;
        artifact_id: string;
        sha256: string;
        size_bytes: number;
        publication_status: string;
      }
    >(
      `select id, artifact_id, sha256, size_bytes, publication_status
         from bakery.artifact_versions
        where organization_id = $1 and id = $2::uuid`,
      [options.organizationId, versionId],
    );
    const row = version.rows[0];
    if (!row) {
      throw unprocessable(["inputs"], "input_artifact_unavailable");
    }
    assertPinnableVersion(["inputs"], row);
    await insertRunInputPin(transaction, {
      organizationId: options.organizationId,
      runId: options.runId,
      artifactId: row.artifact_id,
      versionId: row.id,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    });
  }
}

/** The most path inputs one run may name, so admission does a bounded number of lookups. */
export const MAX_INPUT_PATHS = 100;

/** One input's resolution: the pin a storage path became. */
export type ResolvedInputPath = Readonly<{
  inputName: string;
  storagePath: string;
  entryId: string;
  artifactId: string;
  versionId: string;
  sha256: string;
}>;

/**
 * Resolves the storage paths a run names for its inputs, at admission.
 *
 * `inputPaths` maps a declared input name to an absolute path. Each path is
 * resolved in the caller's organization to the file's current version, and that
 * version id becomes the value of the named input: it fits the declared `uuid`
 * type a plan run checks, and it is the pin the run keeps. The path survives
 * only as a label (see `recordInputPaths`). A path that does not resolve to a
 * file with a current version is refused with one code, whether it is missing or
 * in another organization, so a caller learns nothing about another tree.
 */
async function readableByCaller(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    context: Pick<ActionContext, "agentSession" | "sessionScopes">;
  },
  entryId: string,
): Promise<boolean> {
  try {
    await readableEntry(
      options.context,
      transaction,
      options.organizationId,
      options.principalId,
      {
        isAdmin: await isOrganizationAdmin(
          transaction,
          options.organizationId,
          options.principalId,
        ),
      },
      entryId,
    );
    return true;
  } catch (error) {
    if (error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

export async function resolveInputPaths(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    context: Pick<ActionContext, "agentSession" | "sessionScopes">;
    inputs: unknown;
    inputPaths: unknown;
    connections?: ConnectionInputIngest;
  },
): Promise<{ inputs: unknown; resolved: ResolvedInputPath[] }> {
  if (options.inputPaths === undefined || options.inputPaths === null) {
    return { inputs: options.inputs, resolved: [] };
  }
  const paths = options.inputPaths;
  if (typeof paths !== "object" || Array.isArray(paths)) {
    throw unprocessable(["inputPaths"], "input_paths_not_object");
  }
  const named = Object.entries(paths as Record<string, unknown>);
  if (named.length > MAX_INPUT_PATHS) {
    throw unprocessable(["inputPaths"], "input_storage_paths_too_many");
  }
  const supplied = options.inputs;
  if (
    supplied !== null && supplied !== undefined &&
    (typeof supplied !== "object" || Array.isArray(supplied))
  ) {
    throw unprocessable(["inputs"], "inputs_not_object");
  }
  const merged: Record<string, unknown> = {
    ...((supplied ?? {}) as Record<string, unknown>),
  };
  const db = storageQueryOf(transaction);
  const resolved: ResolvedInputPath[] = [];
  for (const [inputName, path] of named) {
    if (inputName === "" || typeof path !== "string") {
      throw unprocessable(
        ["inputPaths", inputName],
        "input_storage_path_invalid",
      );
    }
    if (Object.hasOwn(merged, inputName)) {
      throw unprocessable(
        ["inputPaths", inputName],
        "input_storage_path_conflict",
      );
    }
    let pin;
    try {
      pin = isConnectionsPath(path)
        ? options.connections === undefined
          ? undefined
          : await options.connections(path)
        : await pinStoragePath(db, {
          organizationId: options.organizationId,
          path,
        });
    } catch (error) {
      if (error instanceof StorageNameError) {
        throw unprocessable(
          ["inputPaths", inputName],
          "input_storage_path_invalid",
        );
      }
      throw error;
    }
    if (!pin || !(await readableByCaller(transaction, options, pin.entryId))) {
      throw unprocessable(
        ["inputPaths", inputName],
        "input_storage_path_unavailable",
      );
    }
    merged[inputName] = pin.versionId;
    resolved.push({
      inputName,
      storagePath: pin.label,
      entryId: pin.entryId,
      artifactId: pin.artifactId,
      versionId: pin.versionId,
      sha256: pin.sha256,
    });
  }
  return { inputs: merged, resolved };
}

/**
 * Pins what each path resolved to and records the path as a label, in the run's
 * admission transaction. The pin is the same row a declared version input gets,
 * keyed by the run and the version, so the worker reads exactly these bytes
 * whatever the path points at later.
 */
export async function recordInputPaths(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    runId: string;
    resolved: readonly ResolvedInputPath[];
  },
): Promise<void> {
  for (const item of options.resolved) {
    const version = await transaction.query<
      { id: string; size_bytes: number; publication_status: string }
    >(
      `select id, size_bytes, publication_status from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [options.organizationId, item.versionId],
    );
    if (!version.rows[0]) {
      throw unprocessable(
        ["inputPaths", item.inputName],
        "input_storage_path_unavailable",
      );
    }
    assertPinnableVersion(["inputPaths", item.inputName], version.rows[0]);
    await insertRunInputPin(transaction, {
      organizationId: options.organizationId,
      runId: options.runId,
      artifactId: item.artifactId,
      versionId: item.versionId,
      sha256: item.sha256,
      sizeBytes: version.rows[0].size_bytes,
    });
    await transaction.query(
      `insert into bakery.run_input_paths (
         organization_id, run_id, input_name, storage_path, entry_id,
         artifact_id, artifact_version_id, sha256
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        options.organizationId,
        options.runId,
        item.inputName,
        item.storagePath,
        item.entryId,
        item.artifactId,
        item.versionId,
        item.sha256,
      ],
    );
  }
}

export type RunInputPin = {
  artifactVersionId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

/** The pins recorded for a run, ordered as they were created. */
export async function readRunInputPins(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RunInputPin[]> {
  const result = await transaction.query<
    {
      artifact_version_id: string;
      artifact_id: string;
      sha256: string;
      size_bytes: number;
    }
  >(
    `select artifact_version_id, artifact_id, sha256, size_bytes
       from bakery.run_input_pins
      where organization_id = $1 and run_id = $2
      order by created_at asc, id asc`,
    [organizationId, runId],
  );
  return result.rows.map((row) => ({
    artifactVersionId: row.artifact_version_id,
    artifactId: row.artifact_id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  }));
}

function isConnectionsPath(path: string): boolean {
  const first = path.split("/")[1] ?? "";
  return path.startsWith("/") &&
    first.normalize("NFC").trim().toLowerCase() === "connections";
}
