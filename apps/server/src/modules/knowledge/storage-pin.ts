import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { applyArtifactPin } from "./retention/operations.ts";
import { readableEntry, type StorageReader } from "./storage-reads.ts";

/**
 * Pins or unpins a file in the storage tree: the administrator pin of the
 * artifact behind it, by the file's own id, so the command line can do what the
 * artifact PATCH does without knowing an artifact id or its version.
 *
 * The file must be one the caller can read (404 otherwise, another
 * organization's id included). Only a file backed by an artifact has a pin: a
 * working-area file keeps its last versions by policy and is refused with 422.
 * The pin itself is the one implementation the artifact PATCH uses.
 */
export async function pinStorageFile(
  context: ActionContext,
  reader: StorageReader,
  input: { readonly pinned: boolean },
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const file = await readableEntry(
    context,
    transaction,
    organizationId,
    principalId,
    reader,
    context.params.id,
  );
  if (file.kind !== "file") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (file.artifact_id === null) {
    // A working-area file keeps its latest versions by policy: nothing to pin.
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["id"],
          message: "not_a_record_file",
          code: "not_a_record_file",
        }],
      },
    });
  }
  return await applyArtifactPin(
    context,
    file.artifact_id,
    input.pinned,
    null,
    "storageFiles.pin",
  );
}
