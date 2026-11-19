/**
 * The binary frames of the collaboration socket (docs/technical-design/20-
 * collaborative-documents.md): a 52-byte big-endian header, then the payload.
 * This mirrors the server's `encodeBinaryFrame` / `decodeBinaryFrame`; a unit
 * test round-trips every frame through both so the two cannot drift.
 */

/** The kinds of binary frame. */
export const BinaryFrameKind = Object.freeze(
  {
    /** A client's edit, sent with its mutation id. */
    ClientUpdate: 1,
    /** The committed document state a join or sync answers with. */
    ServerSnapshot: 2,
    /** An update another participant committed. */
    ServerUpdate: 3,
  } as const,
);

export const BINARY_HEADER_BYTES = 52;
const BINARY_VERSION = 1;

export type BinaryFrame = {
  readonly kind: number;
  readonly epoch: number;
  readonly draftId: string;
  readonly mutationId: string;
  readonly sequence: bigint;
  readonly payload: Uint8Array;
};

/** Raised for a frame that does not match the protocol exactly. */
export class MalformedFrameError extends Error {
  constructor(reason: string) {
    super(`malformed collaboration frame: ${reason}`);
    this.name = "MalformedFrameError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(value: string): Uint8Array {
  if (!UUID.test(value)) throw new MalformedFrameError("id is not a uuid");
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

/** Encodes one frame: version, kind, epoch, draft id, mutation id, sequence, length, payload. */
export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const output = new Uint8Array(BINARY_HEADER_BYTES + frame.payload.length);
  const view = new DataView(output.buffer);
  view.setUint8(0, BINARY_VERSION);
  view.setUint8(1, frame.kind);
  view.setUint16(2, 0);
  view.setUint32(4, frame.epoch);
  output.set(uuidBytes(frame.draftId), 8);
  output.set(uuidBytes(frame.mutationId), 24);
  view.setBigUint64(40, frame.sequence);
  view.setUint32(48, frame.payload.length);
  output.set(frame.payload, BINARY_HEADER_BYTES);
  return output;
}

/** Decodes a frame; the declared length must match the bytes exactly. */
export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame {
  if (bytes.length < BINARY_HEADER_BYTES) {
    throw new MalformedFrameError("short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BINARY_VERSION) {
    throw new MalformedFrameError("unknown version");
  }
  if (view.getUint16(2) !== 0) throw new MalformedFrameError("reserved bits");
  if (view.getUint32(48) !== bytes.length - BINARY_HEADER_BYTES) {
    throw new MalformedFrameError("length does not match");
  }
  return {
    kind: view.getUint8(1),
    epoch: view.getUint32(4),
    draftId: bytesUuid(bytes.subarray(8, 24)),
    mutationId: bytesUuid(bytes.subarray(24, 40)),
    sequence: view.getBigUint64(40),
    payload: bytes.slice(BINARY_HEADER_BYTES),
  };
}
