/**
 * Pixel dimensions of an image, read from its own header (chapter 25 §17.6).
 *
 * Deliberately header-only: decoding a large image to learn that it is 8000
 * pixels wide would spend the sandbox's memory to answer a question the first
 * thirty bytes already answer. A format whose header does not hold together
 * yields undefined, and the caller reports the file as malformed rather than
 * guessing a size.
 *
 * Formats the sniffer recognises but this does not describe are still images;
 * they are reported with their media type and no dimensions, because "an image
 * of unknown size" is true and "malformed" would not be.
 */
export type ImageDimensions = Readonly<{ width?: number; height?: number }>;

function uint16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! * 0x1000000) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}

function positive(
  width: number,
  height: number,
): ImageDimensions | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return undefined;
  }
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function png(bytes: Uint8Array): ImageDimensions | undefined {
  // Signature, then the IHDR chunk: length, "IHDR", width, height.
  if (bytes.byteLength < 24) return undefined;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44) {
    return undefined;
  }
  return positive(uint32be(bytes, 16), uint32be(bytes, 20));
}

function gif(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 10) return undefined;
  return positive(uint16le(bytes, 6), uint16le(bytes, 8));
}

function bmp(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 26) return undefined;
  const headerSize = uint32le(bytes, 14);
  if (headerSize === 12) {
    return positive(uint16le(bytes, 18), uint16le(bytes, 20));
  }
  // BITMAPINFOHEADER and later hold a signed height; a negative height means
  // rows are stored top-down, which is a direction rather than a size.
  return positive(uint32le(bytes, 18), Math.abs(uint32le(bytes, 22) | 0));
}

function webp(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 25) return undefined;
  // A VP8 chunk stores width and height minus one in 14 bits each, after the
  // start code; VP8L packs them into 28 bits; VP8X widens them to 24 bits.
  const chunk = String.fromCharCode(
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  );
  // A short VP8L or VP8X header is the file ending early, not a size of zero:
  // say so rather than letting the reads below see undefined bytes.
  if (chunk !== "VP8 " && bytes.byteLength < 30) return undefined;
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    // VP8 stores each dimension minus one.
    return positive(
      (uint16le(bytes, 26) & 0x3fff) + 1,
      (uint16le(bytes, 28) & 0x3fff) + 1,
    );
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = uint32le(bytes, 21);
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    return positive(uint24le(bytes, 24) + 1, uint24le(bytes, 27) + 1);
  }
  return undefined;
}

/** JPEG walks its segments: the frame header is rarely the first one. */
function jpeg(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (
      marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = uint16be(bytes, offset + 2);
    if (length < 2) return undefined;
    // SOF0..SOF15, except the four markers that are not frame headers.
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return positive(uint16be(bytes, offset + 7), uint16be(bytes, offset + 5));
    }
    offset += 2 + length;
  }
  return undefined;
}

export function describeImage(
  bytes: Uint8Array,
  mediaType: string,
): ImageDimensions | undefined {
  switch (mediaType) {
    case "image/png":
      return png(bytes);
    case "image/gif":
      return gif(bytes);
    case "image/bmp":
      return bmp(bytes);
    case "image/webp":
      return webp(bytes);
    case "image/jpeg":
      return jpeg(bytes);
    default:
      // A recognised image whose dimensions this reader does not know how to
      // find is still an image; it is described without a size.
      return {};
  }
}
