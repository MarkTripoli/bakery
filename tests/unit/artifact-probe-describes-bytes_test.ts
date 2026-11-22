/**
 * The artifact probe describes bytes without decoding them, and refuses what it
 * cannot describe instead of guessing (#437 slice 2).
 *
 * These tests build real headers by hand: a wrong offset here is a wrong
 * thumbnail size in the artifact view, and a fixture blob downloaded from
 * somewhere would not say which byte the reader relied on.
 */
import { assertEquals } from "@std/assert";
import { describeImage } from "../../apps/server/src/modules/knowledge/probe-image.ts";
import { describeMedia } from "../../apps/server/src/modules/knowledge/probe-media.ts";
import { describeText } from "../../apps/server/src/modules/knowledge/probe-text.ts";

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const arrays = parts.map((part) =>
    part instanceof Uint8Array ? part : new Uint8Array(part)
  );
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.byteLength;
  }
  return out;
}

const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
/** An ISO base media box: its size counts its own eight-byte header. */
const box = (type: string, body: Uint8Array) => {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, 8 + body.byteLength);
  head.set(ascii(type), 4);
  return new Uint8Array([...head, ...body]);
};

const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const ascii = (text: string) =>
  Array.from(text, (character) => character.charCodeAt(0));

Deno.test("a PNG is described by the size in its IHDR chunk", () => {
  const png = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    ascii("IHDR"),
    be32(1920),
    be32(1080),
  );
  assertEquals(describeImage(png, "image/png"), { width: 1920, height: 1080 });
});

Deno.test("a PNG whose IHDR is not where it must be is malformed, not 0x0", () => {
  const truncated = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    ascii("HDRI"),
    be32(1920),
    be32(1080),
  );
  assertEquals(describeImage(truncated, "image/png"), undefined);
  // The header must also actually be present.
  assertEquals(
    describeImage(truncated.subarray(0, 16), "image/png"),
    undefined,
  );
});

Deno.test("a PNG that declares a zero dimension is malformed", () => {
  const png = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    ascii("IHDR"),
    be32(0),
    be32(1080),
  );
  assertEquals(describeImage(png, "image/png"), undefined);
});

Deno.test("a GIF is described by its logical screen descriptor", () => {
  const gif = bytes(ascii("GIF89a"), le16(320), le16(200), [0, 0, 0]);
  assertEquals(describeImage(gif, "image/gif"), { width: 320, height: 200 });
});

Deno.test("a BMP is described by its info header, and a negative height is a direction", () => {
  const bottomUp = bytes(
    ascii("BM"),
    le32(0),
    le32(0),
    le32(54),
    le32(40),
    le32(64),
    le32(48),
    le16(1),
    le16(24),
  );
  assertEquals(describeImage(bottomUp, "image/bmp"), { width: 64, height: 48 });

  const topDown = bytes(
    ascii("BM"),
    le32(0),
    le32(0),
    le32(54),
    le32(40),
    le32(64),
    le32(-48 >>> 0),
    le16(1),
    le16(24),
  );
  assertEquals(describeImage(topDown, "image/bmp"), { width: 64, height: 48 });
});

Deno.test("a WebP is described from whichever of its three chunk kinds it uses", () => {
  // Lossy: width and height minus one in the VP8 start-code bytes.
  const lossy = bytes(
    ascii("RIFF"),
    le32(0),
    ascii("WEBP"),
    ascii("VP8 "),
    le32(30),
    // The RIFF payload starts with the frame header, then the VP8 start code.
    [0, 0, 0],
    [0x9d, 0x01, 0x2a],
    le16(499),
    le16(299),
    new Array(20).fill(0),
  );
  // VP8 stores the dimensions minus one, so 499 and 299 are 500 and 300.
  assertEquals(describeImage(lossy, "image/webp"), { width: 500, height: 300 });

  // Lossless: 14 bits each after the 0x2f signature.
  const bits = ((200 - 1) & 0x3fff) | (((100 - 1) & 0x3fff) << 14);
  const lossless = bytes(
    ascii("RIFF"),
    le32(0),
    ascii("WEBP"),
    ascii("VP8L"),
    le32(5),
    [0x2f],
    le32(bits),
    new Array(12).fill(0),
  );
  assertEquals(describeImage(lossless, "image/webp"), {
    width: 200,
    height: 100,
  });

  // Extended: 24-bit widths minus one.
  const extended = bytes(
    ascii("RIFF"),
    le32(0),
    ascii("WEBP"),
    ascii("VP8X"),
    le32(10),
    [0, 0, 0, 0],
    [(640 - 1) & 0xff, ((640 - 1) >>> 8) & 0xff, ((640 - 1) >>> 16) & 0xff],
    [(480 - 1) & 0xff, ((480 - 1) >>> 8) & 0xff, ((480 - 1) >>> 16) & 0xff],
    [0, 0, 0],
  );
  assertEquals(describeImage(extended, "image/webp"), {
    width: 640,
    height: 480,
  });
});

Deno.test("a JPEG is described from the frame header, whatever segment comes first", () => {
  // SOI, then an APP0 segment the reader must walk past, then SOF0.
  const jpeg = bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x10],
    ascii("JFIF\0"),
    [0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    [0xff, 0xc0, 0x00, 0x11, 0x08],
    [0x02, 0x58],
    [0x03, 0x20],
    [0x03],
  );
  assertEquals(describeImage(jpeg, "image/jpeg"), { width: 800, height: 600 });
});

Deno.test("a JPEG with no frame header is malformed", () => {
  const noFrame = bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  assertEquals(describeImage(noFrame, "image/jpeg"), undefined);
});

Deno.test("an image this reader cannot size is still an image", () => {
  // AVIF is sniffed as an image and has no dimension reader here.
  assertEquals(
    describeImage(bytes(ascii("....ftypavif....")), "image/avif"),
    {},
  );
});

Deno.test("an MP4 is described by its mvhd timescale and duration", () => {
  // mvhd body: version+flags, creation, modification, timescale, duration.
  const mvhdBody = bytes(
    [0, 0, 0, 0],
    be32(0),
    be32(0),
    be32(1000),
    be32(12345),
  );
  const mvhd = box("mvhd", mvhdBody);
  const moov = box("moov", mvhd);
  assertEquals(describeMedia(moov, "video/mp4"), { durationMs: 12345 });
  // The same file behind another box: the walk must reach the moov.
  const file = bytes(box("ftyp", bytes(ascii("isom"), be32(0))), moov);
  assertEquals(describeMedia(file, "video/mp4"), { durationMs: 12345 });
});

Deno.test("an MP4 with no duration anywhere is a media file of unknown length", () => {
  // A moov whose children carry no mvhd: the file is media, its length is not
  // claimed. The child is padded so the box is well formed.
  // A "free" child box with no mvhd anywhere.
  const free = bytes(be32(12), ascii("free"), be32(0));
  const moov = bytes(be32(8 + free.byteLength), ascii("moov"), free);
  const file = bytes(be32(8 + moov.byteLength), moov);
  // A moov with no mvhd is media whose length nobody claimed.
  assertEquals(describeMedia(file, "video/mp4"), {});
});

Deno.test("an MP4 whose mvhd timescale is zero cannot be turned into time", () => {
  const mvhd = bytes(
    ascii("mvhd"),
    [0, 0, 0, 0],
    be32(0),
    be32(0),
    be32(0),
    be32(12345),
  );
  const mvhdBox = bytes(be32(8 + mvhd.byteLength), mvhd);
  const moov = bytes(be32(8 + mvhdBox.byteLength), ascii("moov"), mvhdBox);
  assertEquals(describeMedia(moov, "video/mp4"), undefined);
});

Deno.test("a WebM is described by its Info duration and timecode scale", () => {
  const element = (id: number[], body: number[]) =>
    bytes(id, [0x80 | body.length], body);
  const timeScale = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000
  // A duration is an 8-byte big-endian double: 2500.0.
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 2500);
  const info = bytes(
    [0x15, 0x49, 0xa9, 0x66],
    [0x80 | (timeScale.byteLength + 11)],
    timeScale,
    [0x44, 0x89],
    [0x88],
    duration,
  );
  // An unknown-sized Segment: 0xff means "to the end of the file".
  const segment = bytes([0x18, 0x53, 0x80, 0x67], [0xff], info);
  const header = bytes([0x1a, 0x45, 0xdf, 0xa3], [0x80]);
  assertEquals(describeMedia(bytes(header, segment), "video/webm"), {
    durationMs: 2500,
  });
});

Deno.test("a container this reader does not parse is described without a duration", () => {
  assertEquals(
    describeMedia(bytes(ascii("OggS"), new Array(16).fill(0)), "video/ogg"),
    {},
  );
  assertEquals(
    describeMedia(bytes(ascii("ID3"), new Array(16).fill(0)), "audio/mpeg"),
    {},
  );
  // Too few bytes to even hold a header is malformed, not empty.
  assertEquals(describeMedia(bytes(ascii("ID")), "audio/mpeg"), undefined);
});

Deno.test("text is counted whole, and utf8 is a fact rather than a hope", () => {
  assertEquals(describeText(new TextEncoder().encode("one\ntwo\nthree")), {
    lineCount: 3,
    utf8: true,
  });
  // A trailing newline ends the last line; it does not start an empty one.
  assertEquals(
    describeText(new TextEncoder().encode("alpha\nbeta\ngamma\n")),
    { lineCount: 3, utf8: true },
  );
  // One newline and nothing else is one empty line, not two.
  assertEquals(describeText(new TextEncoder().encode("\n")), {
    lineCount: 1,
    utf8: true,
  });
  assertEquals(describeText(new Uint8Array()), { lineCount: 0, utf8: true });
  assertEquals(
    describeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00])),
    { lineCount: 1, utf8: false },
  );
});
