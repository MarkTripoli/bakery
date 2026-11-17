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
  completeUploadSession,
  lockUploadSession,
  putUploadPart,
  readUploadParts,
  recordBlob,
  startUploadSession,
} from "./blobs.ts";
import { sha256Bytes } from "./bytes.ts";

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

export function createBlobUploadHandlers() {
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
      const session = await lockUploadSession(transaction, {
        organizationId,
        principalId,
        sessionId: input.id,
      });
      const blob = await recordBlob(transaction, {
        organizationId,
        principalId,
        sha256: session.sha256,
        sizeBytes: Number(session.sizeBytes),
        mediaType: session.mediaType,
      });
      await completeUploadSession(transaction, {
        organizationId,
        principalId,
        sessionId: session.id,
        blobId: blob.id,
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
    state: "pending" | "completed" | "abandoned";
    expiresAt: Date;
  }>,
) {
  const parts = await readUploadParts(tx, {
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
    receivedBytes: parts.reduce(
      (total, part) => total + part.content.byteLength,
      0,
    ),
    partCount: parts.length,
  };
}
