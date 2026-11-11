/**
 * Turns a QR module matrix into a 1-bit greyscale PNG data URL.
 *
 * A QR symbol is a bitmap, and the browser must be the thing that scales it
 * into the plate: a vector drawing of the same modules antialiases its edges
 * differently from a downscaled raster, which is visible against Paper's
 * `.totp-qr` artboards. So the modules are rasterised at the artboard's own
 * 6px module pitch and handed to an `<img>`, whose `object-fit: contain`
 * downscale is exactly what the design reference recorded.
 *
 * Written by hand rather than through a canvas so the result is a pure
 * function of the matrix — no DOM, no layout, identical on the server — and
 * the whole file stays smaller than the deflate machinery it avoids: the
 * PNG's one IDAT uses stored (uncompressed) deflate blocks, which for a
 * 1-bit 282x282 image is ~10KB of pixels.
 */

/** The artboard's module pitch (`totp-demo.png` is 47 modules at 6px). */
const MODULE_PIXELS = 6;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Largest payload a single stored deflate block can carry. */
const STORED_BLOCK_MAX = 0xffff;
const ADLER_MODULO = 65521;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Zlib stream whose deflate blocks are all stored, never compressed. */
function storedZlib(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let start = 0; start < raw.length; start += STORED_BLOCK_MAX) {
    const slice = raw.subarray(start, start + STORED_BLOCK_MAX);
    const last = start + STORED_BLOCK_MAX >= raw.length;
    out[at] = last ? 1 : 0;
    out[at + 1] = slice.length & 0xff;
    out[at + 2] = (slice.length >>> 8) & 0xff;
    out[at + 3] = ~slice.length & 0xff;
    out[at + 4] = (~slice.length >>> 8) & 0xff;
    out.set(slice, at + 5);
    at += 5 + slice.length;
  }
  let low = 1;
  let high = 0;
  for (const byte of raw) {
    low = (low + byte) % ADLER_MODULO;
    high = (high + low) % ADLER_MODULO;
  }
  new DataView(out.buffer).setUint32(at, ((high << 16) | low) >>> 0);
  return out;
}

/**
 * Encodes the matrix (`true` = dark, quiet zone included) as a `data:` URL
 * holding a 1-bit greyscale PNG, one image pixel per `MODULE_PIXELS`.
 */
export function qrPngDataUrl(
  modules: readonly (readonly boolean[])[],
): string {
  const side = modules.length * MODULE_PIXELS;
  const rowBytes = Math.ceil(side / 8);
  const raw = new Uint8Array(side * (rowBytes + 1));
  for (let row = 0; row < modules.length; row += 1) {
    const cells = modules[row];
    const scanline = new Uint8Array(rowBytes).fill(0xff);
    for (let column = 0; column < cells.length; column += 1) {
      if (!cells[column]) continue;
      for (let pixel = 0; pixel < MODULE_PIXELS; pixel += 1) {
        const at = column * MODULE_PIXELS + pixel;
        scanline[at >> 3] &= ~(0x80 >> (at & 7));
      }
    }
    for (let repeat = 0; repeat < MODULE_PIXELS; repeat += 1) {
      raw.set(scanline, (row * MODULE_PIXELS + repeat) * (rowBytes + 1) + 1);
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, side);
  headerView.setUint32(4, side);
  header[8] = 1;
  const png = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", storedZlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const binary = png.map((part) => {
    let text = "";
    // Chunked so the argument list stays well under the engine's limit.
    for (let offset = 0; offset < part.length; offset += 8192) {
      text += String.fromCharCode(...part.subarray(offset, offset + 8192));
    }
    return text;
  }).join("");
  return `data:image/png;base64,${btoa(binary)}`;
}
