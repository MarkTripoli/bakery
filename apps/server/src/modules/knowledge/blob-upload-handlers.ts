/**
 * The three blob upload actions, as handlers rather than route plumbing.
 *
 * Kept out of `resource-routes.ts` so the gate that authorises them and the
 * translation to a response are separate concerns: every handler here assumes
 * it has already been authorised and has a transaction, and does nothing else
 * with identity. That is what makes the tenancy check inside `blobs.ts`
 * meaningful — the organization and principal reaching it are the caller's, not
 * a value parsed from the request body.
 *
 * The session's expiry, size ceiling and digest are all declared up front by the
 * client, so completion can refuse an assembly that does not match instead of
 * storing a truncated file and discovering it later.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  assembleVerifiedBytes,
  completeUploadSession,
  deleteUploadParts,
  lockUploadSession,
  lockUploadSessionForCompletion,
  putUploadPart,
  readBlob,
  readUploadPartSummaries,
  recordBlob,
  startUploadSession,
  streamUploadParts,
} from "./blobs.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import { sha256Bytes } from "./bytes.ts";
import { enqueueProbeSubject } from "./probe-runner.ts";

export type StartInput = Readonly<{
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}>;

export type PartInput = Readonly<{
  id: string;
  partNumber: string;
  sha256: string;
  content: string;
}>;

type CompleteInput = Readonly<{
  id: string;
}>;

/**
 * How many completions may hold a whole file in memory at once.
 *
 * Completion materialises the file to hand it to the object store, so the peak
 * is the declared size times this number, and the declared size may be 5 GiB.
 * One is the only bound that keeps a single large upload from taking the host
 * with it; the streaming port that removes the materialisation is its own
 * change.
 */
const MAX_CONCURRENT_COMPLETIONS = 1;

let completionsInFlight = 0;
const completionWaiters: Array<() => void> = [];

async function withCompletionSlot<T>(work: () => Promise<T>): Promise<T> {
  while (completionsInFlight >= MAX_CONCURRENT_COMPLETIONS) {
    await new Promise<void>((resolve) => completionWaiters.push(resolve));
  }
  completionsInFlight += 1;
  try {
    return await work();
  } finally {
    completionsInFlight -= 1;
    completionWaiters.shift()?.();
  }
}

export function createBlobUploadHandlers(blobStore?: OrganizationBlobStore) {
  return {
    /**
     * Opens an upload session that names the digest and size it promises.
     *
     * Nothing is stored until completion, so an abandoned session costs a row
     * and no object; the expiry is what bounds even that.
     */
    async startUpload(context: ActionContext, input: StartInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const session = await startUploadSession(transaction, {
        organizationId,
        principalId,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
      });
      return await projection(transaction, organizationId, session);
    },

    /**
     * Stores one part, addressed by its ordinal.
     *
     * The content arrives base64 in the body because a part is a bounded slice
     * of a binary upload and the catalog surface is JSON; the digest the client
     * reports is checked here so a corrupt part is refused at the part rather
     * than at the completion, where the cause is much harder to find.
     */
    async putPart(context: ActionContext, input: PartInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const partNumber = Number(input.partNumber);
      if (!Number.isInteger(partNumber)) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "partNumber", reason: "invalid_part_number" },
        });
      }
      const content = decodeBase64(input.content);
      const actual = await sha256Bytes(content);
      if (actual !== input.sha256) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "content", reason: "digest_mismatch" },
        });
      }
      await putUploadPart(transaction, {
        organizationId,
        principalId,
        sessionId: input.id,
        partNumber,
        sha256: input.sha256,
        content,
      });
      // The session as it is now, so a client can see the recorded part and how
      // long it has left without guessing.
      const session = await lockUploadSession(transaction, {
        organizationId,
        principalId,
        sessionId: input.id,
      });
      return await projection(transaction, organizationId, session);
    },

    /**
     * Completes a session, verifying the assembled bytes against what was
     * declared before anything is recorded.
     *
     * The order matters: assemble and verify, then record the blob, then mark the
     * session complete. A failure at any step rolls the whole thing back, so a
     * session is never marked complete around a blob that was refused.
     */
    async completeUpload(context: ActionContext, input: CompleteInput) {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      const session = await lockUploadSessionForCompletion(transaction, {
        organizationId,
        principalId,
        sessionId: input.id,
      });

      // A client that never saw the first response retries, and the answer it
      // needs is the blob it already produced. Answering a conflict would leave
      // it holding a session it cannot finish and a blob id it cannot learn.
      if (session.state === "completed") {
        const existing = await readBlob(transaction, {
          organizationId,
          blobId: session.completedBlobId!,
        });
        return {
          id: existing.id,
          sha256: existing.sha256,
          sizeBytes: existing.sizeBytes,
          mediaType: existing.mediaType,
          createdAt: existing.createdAt.toISOString(),
        };
      }

      if (!blobStore) {
        // Without a store the bytes would have nowhere to live, and a blob row
        // naming bytes that exist nowhere is a lie the registry cannot detect.
        throw new StandardError({ code: "INTERNAL" });
      }

      // Verify before writing anything. The session declared a digest and a
      // size up front; until the parts are hashed, that declaration is a claim
      // the client made, not a fact.
      //
      // The order is binding: the object key is the digest, so a write that
      // happened before verification would put unverified bytes at the address
      // every later honest upload of that digest resolves to. Verify, then
      // write, then record.
      const blob = await withCompletionSlot(async () => {
        const bytes = await assembleVerifiedBytes(
          streamUploadParts(transaction, {
            organizationId,
            sessionId: session.id,
          }),
          { sha256: session.sha256, sizeBytes: Number(session.sizeBytes) },
        );
        await blobStore.putIfAbsent(
          organizationId,
          session.sha256,
          bytes,
        );
        const recorded = await recordBlob(transaction, {
          organizationId,
          principalId,
          sha256: session.sha256,
          sizeBytes: Number(session.sizeBytes),
          mediaType: session.mediaType,
        }, blobStore);
        await completeUploadSession(transaction, {
          organizationId,
          principalId,
          sessionId: session.id,
          blobId: recorded.id,
        });
        // The bytes exist and are digest-checked, so this is the moment the
        // subject becomes askable: queue it in the same transaction as the blob.
        await enqueueProbeSubject(transaction, {
          organizationId,
          blobId: recorded.id,
        });
        // The object store is the home now; the parts are a second copy.
        await deleteUploadParts(transaction, {
          organizationId,
          sessionId: session.id,
        });
        return recorded;
      });
      return {
        id: blob.id,
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        mediaType: blob.mediaType,
        // When this blob first became known, not when this call ran: a replay
        // finds the existing row, and reporting now() would date it to the
        // retry.
        createdAt: blob.createdAt.toISOString(),
      };
    },
  };
}

/**
 * Decodes a base64 part body, refusing anything that is not valid base64.
 *
 * `atob` is lenient about padding in ways that silently truncate, so the length
 * is checked after decoding against what the encoding implies.
 */
function decodeBase64(content: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(content);
  } catch {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "content", reason: "invalid_base64" },
    });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The session as a client needs to see it: what it promised, how far it has got,
 * and how long it has left.
 *
 * Progress is read from the parts rather than kept as a counter on the session.
 * A counter would be a second source of truth that a retried or removed part
 * could silently disagree with; the parts are the record.
 */
async function projection(
  tx: PgTransactionClient,
  organizationId: string,
  session: Readonly<{
    id: string;
    sha256: string;
    sizeBytes: bigint;
    mediaType: string;
    state: "pending" | "completed" | "abandoned" | "expired";
    expiresAt: Date;
  }>,
) {
  const parts = await readUploadPartSummaries(tx, {
    organizationId,
    sessionId: session.id,
  });
  return {
    id: session.id,
    sha256: session.sha256,
    // The row stores a bigint; the boundary hands a number to JSON, which every
    // caller of this projection already expects.
    sizeBytes: Number(session.sizeBytes),
    mediaType: session.mediaType,
    state: session.state,
    expiresAt: session.expiresAt.toISOString(),
    receivedBytes: parts.reduce((total, part) => total + part.sizeBytes, 0),
    partCount: parts.length,
  };
}
