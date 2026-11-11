import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type ContractInput,
  type ContractOutput,
  MAX_ARTIFACT_BYTES,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { classifyArtifactMedia } from "./media.ts";

const MAX_EXTRACTION_BYTES = 65_536;
const MAX_START_BYTE = 10_485_760;
const MAX_UTF8_CODE_POINT_BYTES = 4;
const MEDIA_PROBE_BYTES = 4_096;

export type ArtifactExtractQuery = ContractInput<"ArtifactExtractQuery">;
export type ArtifactExtraction = ContractOutput<"ArtifactExtraction">;

type ArtifactExtractionRow = {
  id: string;
  purged_at: Date | null;
  media_type: string;
  size_bytes: number | string;
  content_size_bytes: number | string;
  validated_text_size: number | string;
  content_sha256: string;
  sha256: string;
  media_probe: Uint8Array | null;
  window: Uint8Array | null;
};

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function rejectExtraction(): never {
  throw new StandardError({ code: "UNPROCESSABLE" });
}

function internalFailure(): never {
  throw new StandardError({ code: "INTERNAL" });
}

function bytes(value: Uint8Array | null): Uint8Array {
  if (!(value instanceof Uint8Array)) internalFailure();
  return value;
}

function decode(value: Uint8Array): string {
  try {
    return decoder.decode(value);
  } catch {
    rejectExtraction();
  }
}

function isTextMediaType(value: string): boolean {
  const baseType = value.split(";", 1)[0].trim().toLowerCase();
  return baseType.startsWith("text/") ||
    baseType === "application/json" ||
    baseType === "application/xml";
}

function codePointLength(value: number): number | null {
  if (value >= 0xc2 && value <= 0xdf) return 2;
  if (value >= 0xe0 && value <= 0xef) return 3;
  if (value >= 0xf0 && value <= 0xf4) return 4;
  return null;
}

function assertCanonicalOffset(
  window: Uint8Array,
  prefixLength: number,
  startByte: number,
): void {
  if (prefixLength === 0) return;
  const previous = window[prefixLength - 1];
  if (previous === undefined) internalFailure();
  if (startByte === prefixLength) {
    decode(window.subarray(0, prefixLength));
    return;
  }
  if (previous < 0x80) return;
  if (previous >= 0x80 && previous <= 0xbf) {
    let leadIndex = prefixLength - 1;
    while (
      leadIndex >= 0 && window[leadIndex]! >= 0x80 &&
      window[leadIndex]! <= 0xbf
    ) {
      leadIndex -= 1;
    }
    if (leadIndex < 0) rejectExtraction();
    const length = codePointLength(window[leadIndex]!);
    if (length === null || prefixLength - leadIndex !== length) {
      rejectExtraction();
    }
    decode(window.subarray(leadIndex, prefixLength));
    return;
  }
  rejectExtraction();
}

function incompleteCodePoint(
  candidate: Uint8Array,
): { leadIndex: number; missing: number } | null {
  let leadIndex = candidate.byteLength - 1;
  while (
    leadIndex >= 0 && candidate[leadIndex]! >= 0x80 &&
    candidate[leadIndex]! <= 0xbf
  ) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return null;
  const length = codePointLength(candidate[leadIndex]!);
  if (length === null) return null;
  const present = candidate.byteLength - leadIndex;
  if (present >= length) return null;
  return { leadIndex, missing: length - present };
}
function extractWindow(
  window: Uint8Array,
  prefixLength: number,
  maxBytes: number,
  size: number,
  startByte: number,
): Pick<ArtifactExtraction, "endByteExclusive" | "text" | "hasMore"> {
  if (prefixLength > window.byteLength) internalFailure();
  assertCanonicalOffset(window, prefixLength, startByte);
  const available = window.subarray(prefixLength);
  const candidate = available.subarray(
    0,
    Math.min(maxBytes, available.byteLength),
  );

  let outputLength = candidate.byteLength;
  try {
    decode(candidate);
  } catch {
    const incomplete = incompleteCodePoint(candidate);
    if (!incomplete) rejectExtraction();
    const validationLength = Math.min(
      available.byteLength,
      candidate.byteLength + incomplete.missing,
    );
    decode(available.subarray(0, validationLength));
    outputLength = incomplete.leadIndex;
  }
  if (outputLength === 0 && startByte < size) rejectExtraction();

  const outputBytes = available.subarray(0, outputLength);
  const text = decode(outputBytes);

  const endByteExclusive = startByte + outputBytes.byteLength;
  return {
    endByteExclusive,
    text,
    hasMore: endByteExclusive < size,
  };
}

async function loadArtifactExtractionRow(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string,
  startByte: number,
  maxBytes: number,
): Promise<ArtifactExtractionRow> {
  const lookbehindStart = Math.max(0, startByte - MAX_UTF8_CODE_POINT_BYTES);
  const windowStart = lookbehindStart + 1;
  const prefixLength = startByte - lookbehindStart;
  const windowLength = prefixLength + maxBytes + MAX_UTF8_CODE_POINT_BYTES;
  const result = await transaction.query<ArtifactExtractionRow>(
    `select v.id,v.purged_at,
            v.media_type,
            v.size_bytes,
            octet_length(v.content) as content_size_bytes,
            v.sha256,
            octet_length(convert_from(v.content, 'UTF8')) as validated_text_size,
            encode(sha256(v.content), 'hex') as content_sha256,
            substring(v.content from 1 for $3::integer) as media_probe,
            substring(v.content from $4::integer for $5::integer) as window
       from bakery.artifact_versions v
       join bakery.artifacts a
         on a.organization_id=v.organization_id
        and a.id=v.artifact_id
        and a.task_id=v.task_id
       join bakery.tasks t
         on t.organization_id=v.organization_id and t.id=v.task_id
      where v.organization_id=$1
        and v.id=$2
        and (
          v.run_step_id is null or exists (
            select 1
              from bakery.run_steps rs
              join bakery.workflow_runs wr
                on wr.organization_id=rs.organization_id and wr.id=rs.run_id
             where rs.organization_id=v.organization_id
               and rs.id=v.run_step_id
               and wr.task_id=v.task_id
          )
        )`,
    [
      organizationId,
      versionId,
      MEDIA_PROBE_BYTES,
      windowStart,
      windowLength,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.purged_at !== null) {
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  return row;
}

export async function extractArtifactVersion(
  context: ActionContext,
  input: ArtifactExtractQuery,
): Promise<ArtifactExtraction> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const versionId = context.params.id;
  if (!versionId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const startByte = input.startByte ?? 0;
  const maxBytes = input.maxBytes ?? MAX_EXTRACTION_BYTES;
  if (
    !Number.isSafeInteger(startByte) ||
    startByte < 0 ||
    startByte > MAX_START_BYTE ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_EXTRACTION_BYTES
  ) rejectExtraction();

  let mediaProbe: Uint8Array | undefined;
  let window: Uint8Array | undefined;
  try {
    let row: ArtifactExtractionRow;
    try {
      row = await loadArtifactExtractionRow(
        transaction,
        organizationId,
        versionId,
        startByte,
        maxBytes,
      );
    } catch (error) {
      if (
        error !== null && typeof error === "object" && "code" in error &&
        error.code === "22021"
      ) rejectExtraction();
      throw error;
    }
    const size = Number(row.size_bytes);
    const storedSize = Number(row.content_size_bytes);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_ARTIFACT_BYTES ||
      storedSize !== size ||
      Number(row.validated_text_size) !== size ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      row.content_sha256 !== row.sha256
    ) internalFailure();
    if (startByte > size) rejectExtraction();

    mediaProbe = bytes(row.media_probe);
    window = bytes(row.window);
    const media = classifyArtifactMedia({
      declaredType: row.media_type,
      content: mediaProbe,
    });
    if (
      media === null ||
      media.safety !== "safe" ||
      !media.viewerEligible ||
      !isTextMediaType(media.mediaType)
    ) rejectExtraction();

    const prefixLength = startByte - Math.max(
      0,
      startByte - MAX_UTF8_CODE_POINT_BYTES,
    );
    const extracted = extractWindow(
      window,
      prefixLength,
      maxBytes,
      size,
      startByte,
    );
    return {
      versionId: row.id,
      sha256: row.sha256,
      mediaType: media.mediaType,
      startByte,
      ...extracted,
    };
  } finally {
    mediaProbe = undefined;
    window = undefined;
  }
}
