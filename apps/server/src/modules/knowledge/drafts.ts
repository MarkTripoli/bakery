import { Cursor, encodeFrontiers, LoroDoc } from "loro-crdt";

export const DRAFT_LIMITS = Object.freeze({
  replacementBytes: 65_536,
  updateBytes: 65_536,
  bodyBytes: 1_048_576,
  stateBytes: 16_777_216,
  metadataBytes: 8_192,
  queuedMutations: 100,
  workerMemoryBytes: 268_435_456,
  /**
   * Process launcher bounds (no systemd): RLIMIT_DATA, below which the Deno
   * runtime cannot start, and the V8 heap cap that kills a growing worker.
   */
  processDataBytes: 1_073_741_824,
  processHeapMegabytes: 192,
  processCpuSeconds: 2,
  workerTasks: 32,
  workerRuntimeMs: 1_000,
  workerKillMs: 100,
  staleAttempts: 3,
});

const encoder = new TextEncoder();

export type DraftCandidateFailureKind =
  | "precondition"
  | "unprocessable"
  | "limit";

export class DraftCandidateError extends Error {
  override readonly name = "DraftCandidateError";

  constructor(readonly kind: DraftCandidateFailureKind, message: string) {
    super(message);
  }
}

export type DraftEditCandidateInput = {
  mutationId: string;
  startCursor: string;
  endCursor: string;
  expectedText: string;
  expectedDigest: string;
  replacement: string;
};

export type DraftCandidate = {
  state: Uint8Array;
  update: Uint8Array;
  frontiers: Uint8Array;
  text: string;
  textDigest: string;
  updateDigest: string;
};

export type DraftSliceCandidate = {
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertBoundedText(value: string, limit: number, label: string): void {
  if (bytes(value) > limit) {
    throw new DraftCandidateError("limit", `${label.toUpperCase()}_TOO_LARGE`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new DraftCandidateError("unprocessable", "UNPAIRED_SURROGATE");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new DraftCandidateError("unprocessable", "UNPAIRED_SURROGATE");
    }
  }
}

function assertUtf16Boundary(text: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new DraftCandidateError("precondition", "CURSOR_OUT_OF_RANGE");
  }
  if (
    offset > 0 && offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  ) {
    throw new DraftCandidateError("precondition", "UTF16_SURROGATE_SPLIT");
  }
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const decoded = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    if (toBase64(decoded) !== value) throw new Error("non-canonical");
    return decoded;
  } catch (cause) {
    throw new DraftCandidateError(
      "unprocessable",
      `CURSOR_ENCODING_INVALID:${
        cause instanceof Error ? cause.name : "error"
      }`,
    );
  }
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function digest(value: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        value as unknown as BufferSource,
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function textDigest(value: string): Promise<string> {
  return await digest(encoder.encode(value));
}

function assertStateSize(state: Uint8Array): void {
  if (state.byteLength === 0 || state.byteLength > DRAFT_LIMITS.stateBytes) {
    throw new DraftCandidateError("limit", "STATE_SIZE_INVALID");
  }
}

function importDocument(state: Uint8Array): LoroDoc {
  assertStateSize(state);
  const document = new LoroDoc();
  let status;
  try {
    status = document.import(state);
  } catch (cause) {
    throw new DraftCandidateError(
      "unprocessable",
      `LORO_IMPORT_INVALID:${cause instanceof Error ? cause.name : "error"}`,
    );
  }
  if (status.pending !== null) {
    throw new DraftCandidateError("unprocessable", "LORO_PENDING_DEPENDENCIES");
  }
  const roots = document.getShallowValue();
  const entries = Object.entries(roots);
  if (
    entries.length !== 1 || entries[0]?.[0] !== "body" ||
    entries[0]?.[1] !== "cid:root-body:Text"
  ) {
    throw new DraftCandidateError("unprocessable", "LORO_ROOT_INVALID");
  }
  return document;
}

function peerId(mutationId: string): `${number}` {
  const compact = mutationId.replaceAll("-", "").slice(0, 16);
  const value = BigInt(`0x${compact}`) || 1n;
  return value.toString() as `${number}`;
}

function resolveRange(
  document: LoroDoc,
  startCursor: Cursor,
  endCursor: Cursor,
): readonly [number, number] {
  if (
    startCursor.containerId() !== "cid:root-body:Text" ||
    endCursor.containerId() !== "cid:root-body:Text"
  ) {
    throw new DraftCandidateError("precondition", "CURSOR_ROOT_INVALID");
  }
  const start = document.getCursorPos(startCursor)?.offset;
  const end = document.getCursorPos(endCursor)?.offset;
  if (start === undefined || end === undefined || start > end) {
    throw new DraftCandidateError("precondition", "CURSOR_RANGE_STALE");
  }
  const body = document.getText("body").toString();
  assertUtf16Boundary(body, start);
  assertUtf16Boundary(body, end);
  return [start, end];
}

export async function createInitialDraftCandidate(
  text: string,
): Promise<DraftCandidate> {
  assertBoundedText(text, DRAFT_LIMITS.bodyBytes, "body");
  const document = new LoroDoc();
  const body = document.getText("body");
  if (text.length > 0) body.insert(0, text);
  document.commit();
  const state = document.export({ mode: "snapshot" });
  const imported = importDocument(state);
  const committedText = imported.getText("body").toString();
  return {
    state,
    update: new Uint8Array(),
    frontiers: encodeFrontiers(imported.frontiers()),
    text: committedText,
    textDigest: await textDigest(committedText),
    updateDigest: await digest(new Uint8Array()),
  };
}

export async function applyDraftEditCandidate(
  currentState: Uint8Array,
  sourceState: Uint8Array,
  input: DraftEditCandidateInput,
): Promise<DraftCandidate> {
  assertBoundedText(
    input.expectedText,
    DRAFT_LIMITS.replacementBytes,
    "expected_text",
  );
  assertBoundedText(
    input.replacement,
    DRAFT_LIMITS.replacementBytes,
    "replacement",
  );
  if (await textDigest(input.expectedText) !== input.expectedDigest) {
    throw new DraftCandidateError("unprocessable", "EXPECTED_DIGEST_INVALID");
  }
  const startCursor = Cursor.decode(decodeBase64(input.startCursor));
  const endCursor = Cursor.decode(decodeBase64(input.endCursor));
  const source = importDocument(sourceState);
  const [sourceStart, sourceEnd] = resolveRange(
    source,
    startCursor,
    endCursor,
  );
  if (
    source.getText("body").toString().slice(sourceStart, sourceEnd) !==
      input.expectedText
  ) {
    throw new DraftCandidateError("precondition", "SOURCE_TARGET_CHANGED");
  }
  const document = importDocument(currentState);
  const [start, end] = resolveRange(document, startCursor, endCursor);
  const body = document.getText("body");
  if (body.toString().slice(start, end) !== input.expectedText) {
    throw new DraftCandidateError("precondition", "CURRENT_TARGET_CHANGED");
  }
  const from = document.version();
  document.setPeerId(peerId(input.mutationId));
  if (end > start) body.delete(start, end - start);
  if (input.replacement.length > 0) body.insert(start, input.replacement);
  document.commit();
  const committedText = body.toString();
  assertBoundedText(committedText, DRAFT_LIMITS.bodyBytes, "body");
  const update = document.export({ mode: "update", from });
  if (update.byteLength > DRAFT_LIMITS.updateBytes) {
    throw new DraftCandidateError("limit", "UPDATE_TOO_LARGE");
  }
  const state = document.export({ mode: "snapshot" });
  assertStateSize(state);
  return {
    state,
    update,
    frontiers: encodeFrontiers(document.frontiers()),
    text: committedText,
    textDigest: await textDigest(committedText),
    updateDigest: await digest(update),
  };
}

/**
 * Imports one client Loro update into the committed state, outside the
 * request loop. The update is bounded, must not leave pending dependencies,
 * and must keep the single plain-text `body` root. The stored update is the
 * normalized delta from the committed version, so a redundant update yields
 * an empty one.
 */
export async function importDraftUpdateCandidate(
  currentState: Uint8Array,
  update: Uint8Array,
): Promise<DraftCandidate> {
  if (update.byteLength === 0 || update.byteLength > DRAFT_LIMITS.updateBytes) {
    throw new DraftCandidateError("limit", "UPDATE_SIZE_INVALID");
  }
  const document = importDocument(currentState);
  const from = document.version();
  const before = JSON.stringify(document.frontiers());
  let status;
  try {
    status = document.import(update);
  } catch (cause) {
    throw new DraftCandidateError(
      "unprocessable",
      `LORO_UPDATE_INVALID:${cause instanceof Error ? cause.name : "error"}`,
    );
  }
  if (status.pending !== null) {
    throw new DraftCandidateError("unprocessable", "LORO_PENDING_DEPENDENCIES");
  }
  const state = document.export({ mode: "snapshot" });
  // Re-import the result so extra roots or formatting are rejected exactly
  // as for any stored state.
  const checked = importDocument(state);
  const committedText = checked.getText("body").toString();
  assertBoundedText(committedText, DRAFT_LIMITS.bodyBytes, "body");
  // An update holding only committed changes moves no frontier: nothing new.
  const normalized = JSON.stringify(document.frontiers()) === before
    ? new Uint8Array()
    : document.export({ mode: "update", from });
  if (normalized.byteLength > DRAFT_LIMITS.updateBytes) {
    throw new DraftCandidateError("limit", "UPDATE_TOO_LARGE");
  }
  return {
    state,
    update: normalized,
    frontiers: encodeFrontiers(checked.frontiers()),
    text: committedText,
    textDigest: await textDigest(committedText),
    updateDigest: await digest(normalized),
  };
}

export async function createDraftSliceCandidate(
  state: Uint8Array,
  startUtf16: number,
  endUtf16: number,
): Promise<DraftSliceCandidate> {
  const document = importDocument(state);
  const body = document.getText("body");
  const text = body.toString();
  assertUtf16Boundary(text, startUtf16);
  assertUtf16Boundary(text, endUtf16);
  if (startUtf16 > endUtf16) {
    throw new DraftCandidateError("precondition", "SLICE_RANGE_REVERSED");
  }
  const slice = text.slice(startUtf16, endUtf16);
  assertBoundedText(slice, DRAFT_LIMITS.replacementBytes, "slice");
  const start = body.getCursor(startUtf16);
  const end = body.getCursor(endUtf16);
  if (!start || !end) {
    throw new DraftCandidateError("precondition", "SLICE_CURSOR_UNAVAILABLE");
  }
  return {
    text: slice,
    textDigest: await textDigest(slice),
    startCursor: toBase64(start.encode()),
    endCursor: toBase64(end.encode()),
  };
}
