/**
 * Duration of audio and video, read from the container header (chapter 25
 * §17.6).
 *
 * Both readers answer from header fields rather than by decoding: an MP4's
 * `mvhd` box and a WebM's `Segment > Info` element each carry a duration, and a
 * file that runs past the energy this sandbox would spend to decode it is a
 * file a reader will skip scrubbing anyway.
 *
 * A container this does not know yields `{}` — a media file of unknown length,
 * which is true — and a header that ends early yields undefined.
 */
export type MediaDuration = Readonly<{ durationMs?: number }>;

function uint32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! * 0x1000000) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!);
}

function uint64be(bytes: Uint8Array, offset: number): number {
  // Durations are far inside the safe range even when the field is 64 bits.
  return uint32be(bytes, offset) * 0x100000000 + uint32be(bytes, offset + 4);
}

function millis(value: number): MediaDuration | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const durationMs = Math.round(value);
  return Number.isSafeInteger(durationMs) ? { durationMs } : undefined;
}

/**
 * MP4 and friends: walk the top-level boxes for `moov`, then inside it for
 * `mvhd`, which holds the timescale and the duration.
 */
function isoBaseMedia(bytes: Uint8Array): MediaDuration | undefined {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = uint32be(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (size < 8) return undefined;
    if (type === "moov") {
      const end = Math.min(offset + size, bytes.byteLength);
      let inner = offset + 8;
      while (inner + 8 <= end) {
        const innerSize = uint32be(bytes, inner);
        const innerType = String.fromCharCode(
          bytes[inner + 4]!,
          bytes[inner + 5]!,
          bytes[inner + 6]!,
          bytes[inner + 7]!,
        );
        if (innerSize < 8) return undefined;
        if (innerType === "mvhd") {
          // A full box: version and flags are the first four bytes of its body,
          // so both layouts start twenty bytes into the child box.
          const version = bytes[inner + 8]!;
          const timescale = version === 1
            ? uint32be(bytes, inner + 28)
            : uint32be(bytes, inner + 20);
          const duration = version === 1
            ? uint64be(bytes, inner + 32)
            : uint32be(bytes, inner + 24);
          if (timescale === 0) return undefined;
          return millis((duration * 1000) / timescale);
        }
        inner += innerSize;
      }
      return {};
    }
    offset += size;
  }
  return {};
}

/** Reads an EBML element header: id, size, and how many bytes that took. */
function ebmlHeader(
  bytes: Uint8Array,
  offset: number,
): { id: number; size: number; headerLength: number } | undefined {
  if (offset >= bytes.byteLength) return undefined;
  const first = bytes[offset]!;
  let idLength = 1;
  while (idLength <= 4 && !(first & (0x80 >> (idLength - 1)))) idLength += 1;
  if (idLength > 4 || offset + idLength >= bytes.byteLength) return undefined;
  let id = 0;
  for (let index = 0; index < idLength; index += 1) {
    id = id * 256 + bytes[offset + index]!;
  }
  const sizeFirst = bytes[offset + idLength]!;
  let sizeLength = 1;
  while (sizeLength <= 8 && !(sizeFirst & (0x80 >> (sizeLength - 1)))) {
    sizeLength += 1;
  }
  if (sizeLength > 8) return undefined;
  // All ones means "unknown size", which a Segment may legitimately declare.
  let size = sizeFirst & (0xff >> sizeLength);
  let unknownSized = size === (0xff >> sizeLength);
  for (let index = 1; index < sizeLength; index += 1) {
    const byte = bytes[offset + idLength + index]!;
    if (byte !== 0xff) unknownSized = false;
    size = size * 256 + byte;
  }
  return {
    id,
    size: unknownSized ? -1 : size,
    headerLength: idLength + sizeLength,
  };
}

function uintValue(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!;
  }
  return value;
}

function floatValue(bytes: Uint8Array, offset: number, length: number): number {
  if (length === 4) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(
      0,
    );
  }
  if (length === 8) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(
      0,
    );
  }
  throw new Error("unsupported float width");
}

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIME_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

/** WebM and Matroska: `Segment > Info` carries TimecodeScale and Duration. */
function ebml(bytes: Uint8Array): MediaDuration | undefined {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const header = ebmlHeader(bytes, offset);
    if (header === undefined) return {};
    const body = offset + header.headerLength;
    if (header.id === SEGMENT) {
      // An unknown-sized Segment runs to the end of the file.
      const end = header.size < 0
        ? bytes.byteLength
        : Math.min(body + header.size, bytes.byteLength);
      let inner = body;
      while (inner < end) {
        const child = ebmlHeader(bytes, inner);
        if (child === undefined) return {};
        const childBody = inner + child.headerLength;
        if (child.id === INFO) {
          const childEnd = child.size < 0
            ? end
            : Math.min(childBody + child.size, end);
          let field = childBody;
          let timeScale = 1_000_000;
          let duration: number | undefined;
          while (field < childEnd) {
            const element = ebmlHeader(bytes, field);
            if (element === undefined) break;
            const valueAt = field + element.headerLength;
            if (valueAt + element.size > bytes.byteLength) break;
            if (element.id === TIME_SCALE && element.size <= 8) {
              timeScale = uintValue(bytes, valueAt, element.size);
            } else if (element.id === DURATION) {
              duration = floatValue(bytes, valueAt, element.size);
            }
            field = valueAt + element.size;
          }
          if (duration === undefined || timeScale === 0) return {};
          return millis((duration * timeScale) / 1_000_000);
        }
        if (child.size < 0) return {};
        inner = childBody + child.size;
      }
      return {};
    }
    if (header.size < 0) return {};
    offset = body + header.size;
  }
  return {};
}

export function describeMedia(
  bytes: Uint8Array,
  mediaType: string,
): MediaDuration | undefined {
  if (bytes.byteLength < 12) return undefined;
  if (
    mediaType === "video/mp4" || mediaType === "video/quicktime" ||
    mediaType === "video/webm"
  ) {
    const isEbml = bytes[0] === 0x1a && bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3;
    return isEbml ? ebml(bytes) : isoBaseMedia(bytes);
  }
  if (mediaType === "video/ogg" || mediaType === "audio/ogg") {
    // Ogg pages hold the granule position, but the mapping that turns it into
    // time is codec-specific; the file is described without a duration.
    return {};
  }
  return {};
}
