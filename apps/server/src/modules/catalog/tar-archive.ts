import {
  MAX_DECODED_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PATH_LENGTH,
  MAX_UPLOAD_FILES,
} from "./validation.ts";
import { unicodeDefaultCaseFold } from "./unicode-case-fold.ts";

export const MAX_SKILL_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_EXPANDED_BYTES = 12 * 1024 * 1024;
export const MAX_USTAR_HEADER_BYTES = 4 * 1024;

export type SkillArchiveFile = Readonly<{
  path: string;
  content: Uint8Array;
  isExecutable: boolean;
}>;

export type SkillArchiveInventory = Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  manifestBytes: Uint8Array;
  files: readonly SkillArchiveFile[];
}>;

export type TarArchiveErrorCode =
  | "ARCHIVE_COMPRESSED_LIMIT"
  | "ARCHIVE_EXPANDED_LIMIT"
  | "ARCHIVE_GZIP_HEADER"
  | "ARCHIVE_GZIP_STREAM"
  | "ARCHIVE_GZIP_TRAILER"
  | "ARCHIVE_TAR_HEADER"
  | "ARCHIVE_ENTRY_TYPE"
  | "ARCHIVE_ENTRY_COUNT"
  | "ARCHIVE_ENTRY_LIMIT"
  | "ARCHIVE_MANIFEST_LIMIT"
  | "ARCHIVE_PATH"
  | "ARCHIVE_PATH_COLLISION"
  | "ARCHIVE_TRUNCATED"
  | "ARCHIVE_END"
  | "ARCHIVE_INVENTORY";

export class TarArchiveError extends Error {
  readonly code: TarArchiveErrorCode;

  constructor(code: TarArchiveErrorCode) {
    super(code);
    this.name = "TarArchiveError";
    this.code = code;
  }
}

function fail(code: TarArchiveErrorCode): never {
  throw new TarArchiveError(code);
}

function readLittleEndianUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] |
    bytes[offset + 1] << 8 |
    bytes[offset + 2] << 16 |
    bytes[offset + 3] << 24) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ value >>> 8;
  }
  return value >>> 0;
}

function boundedZeroTerminatedField(
  bytes: Uint8Array,
  start: number,
  length: number,
): Uint8Array {
  const field = bytes.subarray(start, start + length);
  const zero = field.indexOf(0);
  if (zero < 0) return field;
  for (let index = zero; index < field.length; index++) {
    if (field[index] !== 0) fail("ARCHIVE_TAR_HEADER");
  }
  return field.subarray(0, zero);
}

function decodeHeaderText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("ARCHIVE_TAR_HEADER");
  }
}

function parseOctal(
  header: Uint8Array,
  start: number,
  length: number,
): number {
  const field = header.subarray(start, start + length);
  if (field[0] !== undefined && (field[0] & 0x80) !== 0) {
    fail("ARCHIVE_TAR_HEADER");
  }
  let first = 0;
  while (
    first < field.length && (field[first] === 0 || field[first] === 0x20)
  ) {
    first++;
  }
  let last = field.length;
  while (last > first && (field[last - 1] === 0 || field[last - 1] === 0x20)) {
    last--;
  }
  if (first === last) return 0;
  let value = 0;
  for (let index = first; index < last; index++) {
    const byte = field[index];
    if (byte < 0x30 || byte > 0x37) fail("ARCHIVE_TAR_HEADER");
    value = value * 8 + byte - 0x30;
    if (!Number.isSafeInteger(value)) fail("ARCHIVE_TAR_HEADER");
  }
  return value;
}

function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function validateHeaderChecksum(header: Uint8Array): void {
  const expected = parseOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("ARCHIVE_TAR_HEADER");
}

function normalizeArchivePath(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) fail("ARCHIVE_PATH");
  const path = raw.normalize("NFC");
  if (
    path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.endsWith("/") || path.includes("//") ||
    path.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    ) ||
    path.length > MAX_PATH_LENGTH
  ) {
    fail("ARCHIVE_PATH");
  }
  return path;
}

function normalizeSelectedPath(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "";
  return normalizeArchivePath(raw);
}

function selectedArchivePath(path: string, selectedPath: string): string {
  if (selectedPath === "") return path;
  const prefix = `${selectedPath}/`;
  if (!path.startsWith(prefix)) fail("ARCHIVE_PATH");
  return normalizeArchivePath(path.slice(prefix.length));
}

function parseHeaderPath(header: Uint8Array): string {
  const name = decodeHeaderText(boundedZeroTerminatedField(header, 0, 100));
  const prefix = decodeHeaderText(
    boundedZeroTerminatedField(header, 345, 155),
  );
  return normalizeArchivePath(prefix === "" ? name : `${prefix}/${name}`);
}

type PendingEntry = {
  path: string;
  size: number;
  isExecutable: boolean;
  content: Uint8Array;
  offset: number;
  padding: number;
};

class UstarInventoryParser {
  readonly #selectedPath: string;
  readonly #header = new Uint8Array(512);
  #headerOffset = 0;
  #entry: PendingEntry | undefined;
  #zeroBlocks = 0;
  #ended = false;
  #entryCount = 0;
  #fileBytes = 0;
  #manifestBytes: Uint8Array | undefined;
  #files: SkillArchiveFile[] = [];
  #identities = new Set<string>();
  #deferredError: TarArchiveError | undefined;

  constructor(selectedPath: string | undefined) {
    this.#selectedPath = normalizeSelectedPath(selectedPath);
  }

  push(chunk: Uint8Array): void {
    if (this.#deferredError) return;
    try {
      this.#consume(chunk);
    } catch (error) {
      if (error instanceof TarArchiveError) {
        this.#deferredError = error;
        return;
      }
      throw error;
    }
  }

  #consume(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#ended) fail("ARCHIVE_END");
      if (this.#entry) {
        const entry = this.#entry;
        if (entry.offset < entry.size) {
          const count = Math.min(
            entry.size - entry.offset,
            chunk.length - offset,
          );
          entry.content.set(
            chunk.subarray(offset, offset + count),
            entry.offset,
          );
          entry.offset += count;
          offset += count;
          continue;
        }
        if (entry.padding > 0) {
          const count = Math.min(entry.padding, chunk.length - offset);
          if (
            !chunk.subarray(offset, offset + count).every((byte) => byte === 0)
          ) {
            fail("ARCHIVE_TAR_HEADER");
          }
          entry.padding -= count;
          offset += count;
          if (entry.padding > 0) continue;
        }
        this.#finishEntry(entry);
        this.#entry = undefined;
        continue;
      }
      const count = Math.min(512 - this.#headerOffset, chunk.length - offset);
      this.#header.set(
        chunk.subarray(offset, offset + count),
        this.#headerOffset,
      );
      this.#headerOffset += count;
      offset += count;
      if (this.#headerOffset !== 512) continue;
      this.#headerOffset = 0;
      if (isZeroBlock(this.#header)) {
        this.#zeroBlocks++;
        if (this.#zeroBlocks === 2) this.#ended = true;
        continue;
      }
      if (this.#zeroBlocks !== 0) fail("ARCHIVE_END");
      this.#startEntry(this.#header);
    }
  }

  #startEntry(header: Uint8Array): void {
    validateHeaderChecksum(header);
    const magic = header.subarray(257, 263);
    const version = header.subarray(263, 265);
    if (
      !magic.every((byte, index) =>
        byte === [0x75, 0x73, 0x74, 0x61, 0x72, 0][index]
      ) ||
      version[0] !== 0x30 || version[1] !== 0x30
    ) {
      fail("ARCHIVE_TAR_HEADER");
    }
    const type = header[156];
    if (type !== 0 && type !== 0x30) fail("ARCHIVE_ENTRY_TYPE");
    if (boundedZeroTerminatedField(header, 157, 100).length !== 0) {
      fail("ARCHIVE_ENTRY_TYPE");
    }
    const mode = parseOctal(header, 100, 8);
    parseOctal(header, 108, 8);
    parseOctal(header, 116, 8);
    const size = parseOctal(header, 124, 12);
    parseOctal(header, 136, 12);
    parseOctal(header, 329, 8);
    parseOctal(header, 337, 8);
    if (mode > 0o7777) fail("ARCHIVE_TAR_HEADER");

    const sourcePath = parseHeaderPath(header);
    const path = selectedArchivePath(sourcePath, this.#selectedPath);
    const identity = unicodeDefaultCaseFold(path);
    if (this.#identities.has(identity)) fail("ARCHIVE_PATH_COLLISION");
    this.#identities.add(identity);
    this.#entryCount++;
    if (this.#entryCount > MAX_UPLOAD_FILES + 1) fail("ARCHIVE_ENTRY_COUNT");

    if (path === "manifest.json") {
      if (size > MAX_MANIFEST_BYTES) fail("ARCHIVE_MANIFEST_LIMIT");
    } else {
      if (
        size > MAX_DECODED_FILE_BYTES ||
        this.#fileBytes > MAX_DECODED_FILE_BYTES - size
      ) {
        fail("ARCHIVE_ENTRY_LIMIT");
      }
      this.#fileBytes += size;
    }
    this.#entry = {
      path,
      size,
      isExecutable: (mode & 0o111) !== 0,
      content: new Uint8Array(size),
      offset: 0,
      padding: (512 - size % 512) % 512,
    };
  }

  #finishEntry(entry: PendingEntry): void {
    if (entry.path === "manifest.json") {
      if (this.#manifestBytes) fail("ARCHIVE_INVENTORY");
      this.#manifestBytes = entry.content;
      return;
    }
    this.#files.push(Object.freeze({
      path: entry.path,
      content: entry.content,
      isExecutable: entry.isExecutable,
    }));
  }

  finish(): SkillArchiveInventory {
    if (this.#deferredError) throw this.#deferredError;
    if (this.#entry || this.#headerOffset !== 0) fail("ARCHIVE_TRUNCATED");
    if (!this.#ended || this.#zeroBlocks !== 2) fail("ARCHIVE_END");
    if (!this.#manifestBytes) fail("ARCHIVE_INVENTORY");
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(this.#manifestBytes),
      );
    } catch {
      return fail("ARCHIVE_INVENTORY");
    }
    if (
      manifest === null || typeof manifest !== "object" ||
      Array.isArray(manifest)
    ) {
      fail("ARCHIVE_INVENTORY");
    }
    if (this.#files.length > MAX_UPLOAD_FILES) fail("ARCHIVE_ENTRY_COUNT");
    return Object.freeze({
      manifest: Object.freeze(manifest as Record<string, unknown>),
      manifestBytes: this.#manifestBytes,
      files: Object.freeze(this.#files),
    });
  }
}

function consumeOptionalGzipHeader(bytes: Uint8Array): number {
  if (
    bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b ||
    bytes[2] !== 8
  ) {
    fail("ARCHIVE_GZIP_HEADER");
  }
  const flags = bytes[3];
  if ((flags & 0xe0) !== 0) fail("ARCHIVE_GZIP_HEADER");
  let offset = 10;
  const bounded = () => {
    if (offset > MAX_USTAR_HEADER_BYTES || offset > bytes.length - 8) {
      fail("ARCHIVE_GZIP_HEADER");
    }
  };
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length - 8) fail("ARCHIVE_GZIP_HEADER");
    const length = bytes[offset] | bytes[offset + 1] << 8;
    offset += 2 + length;
    bounded();
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    while (offset < bytes.length - 8 && bytes[offset] !== 0) {
      offset++;
      bounded();
    }
    if (offset >= bytes.length - 8) fail("ARCHIVE_GZIP_HEADER");
    offset++;
    bounded();
  }
  if ((flags & 0x02) !== 0) {
    if (offset + 2 > bytes.length - 8) fail("ARCHIVE_GZIP_HEADER");
    const expected = bytes[offset] | bytes[offset + 1] << 8;
    const actual = (updateCrc32(0xffffffff, bytes.subarray(0, offset)) ^
      0xffffffff) & 0xffff;
    if (actual !== expected) fail("ARCHIVE_GZIP_HEADER");
    offset += 2;
  }
  bounded();
  if (offset >= bytes.length - 8) fail("ARCHIVE_GZIP_HEADER");
  return offset;
}

/** Parses one bounded gzip POSIX USTAR member and inventories every entry. */
export async function parseGzipUstarArchive(
  compressed: Uint8Array,
  selectedPath?: string,
): Promise<SkillArchiveInventory> {
  if (compressed.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    fail("ARCHIVE_COMPRESSED_LIMIT");
  }
  const deflateOffset = consumeOptionalGzipHeader(compressed);
  const trailerOffset = compressed.byteLength - 8;
  const expectedCrc = readLittleEndianUint32(compressed, trailerOffset);
  const expectedSize = readLittleEndianUint32(compressed, trailerOffset + 4);
  const parser = new UstarInventoryParser(selectedPath);
  let crc = 0xffffffff;
  let expandedBytes = 0;
  try {
    const deflate = new Uint8Array(
      compressed.subarray(deflateOffset, trailerOffset),
    );
    const stream = new Blob([deflate]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    for await (const chunk of stream) {
      expandedBytes += chunk.byteLength;
      if (expandedBytes > MAX_SKILL_ARCHIVE_EXPANDED_BYTES) {
        fail("ARCHIVE_EXPANDED_LIMIT");
      }
      crc = updateCrc32(crc, chunk);
      parser.push(chunk);
    }
  } catch (error) {
    if (error instanceof TarArchiveError) throw error;
    return fail("ARCHIVE_GZIP_STREAM");
  }
  const actualCrc = (crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== expectedCrc || (expandedBytes >>> 0) !== expectedSize) {
    fail("ARCHIVE_GZIP_TRAILER");
  }
  return parser.finish();
}
