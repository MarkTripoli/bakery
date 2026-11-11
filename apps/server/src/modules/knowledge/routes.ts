import type { Context } from "hono";
import { contractSchemas } from "@bakery/contracts/contracts";
import { problemResponse, StandardError } from "@bakery/contracts/http";
import { jsonResponse } from "../execution/http.ts";
import { readArtifactUpload } from "./bytes.ts";
import { publishArtifact } from "./persistence.ts";
import {
  BASE_WORKER_PROTOCOL_VERSION,
  type ExecutionRouteOptions,
  parseWorkerProtocolVersion,
  readAttemptId,
  requestDigest,
  requestMetadata,
  sha256Hex,
  withWorkerProtocolHeader,
  WORKER_PROTOCOL_VERSION,
  workerTransaction,
} from "../execution/shared.ts";

export async function artifact(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  let protocolVersion = BASE_WORKER_PROTOCOL_VERSION;
  try {
    protocolVersion = parseWorkerProtocolVersion(context.req.raw.headers);
    const attemptId = readAttemptId(context);
    await workerTransaction(
      options.database,
      context.req.raw.headers,
      () => Promise.resolve(undefined),
    );
    const upload = await readArtifactUpload(context.req.raw);
    const digest = await requestDigest({
      idempotencyKey: upload.idempotencyKey,
      leaseTokenHash: await sha256Hex(upload.leaseToken),
      fence: upload.fence,
      artifactType: upload.artifactType,
      name: upload.name,
      contentType: upload.contentType,
      contentDigest: upload.contentDigest ?? null,
      contentSha256: upload.contentSha256 ?? null,
      runStepId: upload.runStepId ?? null,
      subjectHeadSha: upload.subjectHeadSha ?? null,
      subjectBaseSha: upload.subjectBaseSha ?? null,
      stepKey: upload.stepKey ?? null,
      parentVersionId: upload.parentVersionId ?? null,
      metadata: upload.metadata,
    });
    const result = await workerTransaction(
      options.database,
      context.req.raw.headers,
      (transaction, identity) =>
        publishArtifact(
          transaction,
          identity,
          attemptId,
          upload,
          digest,
          requestMetadata(context).traceId,
        ),
    );
    const parsed = contractSchemas.ArtifactVersion.safeParse(result.response);
    if (!parsed.success) {
      throw new StandardError({ code: "INTERNAL", cause: parsed.error });
    }
    return withWorkerProtocolHeader(
      jsonResponse(parsed.data, 201, result.replayed),
      protocolVersion,
    );
  } catch (error) {
    const response = problemResponse(context, error, {
      publicBaseUrl: options.publicBaseUrl,
    });
    const advertisedVersion = error instanceof StandardError &&
        error.code === "WORKER_PROTOCOL_UNSUPPORTED"
      ? WORKER_PROTOCOL_VERSION
      : protocolVersion;
    return withWorkerProtocolHeader(response, advertisedVersion);
  }
}
