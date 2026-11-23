#!/usr/bin/env python3
"""Converts an X window dump (xwd) to a PNG, with no imaging library.

Reads 24-bit true-colour dumps (what a virtual display gives) and writes an 8-bit RGB PNG. Also
prints the mean brightness (0 to 255) so a capture can be checked for light or dark.

    xwd2png.py in.xwd out.png [WIDTHxHEIGHT]

With a size, only that part of the screen, from its top left corner, is written.
"""
import struct
import sys
import zlib


def read_xwd(path):
    data = open(path, "rb").read()
    names = ("header_size file_version pixmap_format pixmap_depth width height xoffset byte_order "
             "bitmap_unit bitmap_bit_order bitmap_pad bits_per_pixel bytes_per_line visual_class "
             "red_mask green_mask blue_mask bits_per_rgb colormap_entries ncolors window_width "
             "window_height window_x window_y window_bdrwidth").split()
    values = struct.unpack(">25I", data[:100])
    h = dict(zip(names, values))
    if h["file_version"] != 7:
        raise SystemExit(f"unsupported xwd version {h['file_version']}")
    if h["bits_per_pixel"] not in (24, 32) or h["visual_class"] not in (4, 5):
        raise SystemExit(f"unsupported pixel format: {h['bits_per_pixel']} bpp, class {h['visual_class']}")
    offset = h["header_size"] + h["ncolors"] * 12
    return h, data[offset:offset + h["bytes_per_line"] * h["height"]]


def shift_of(mask):
    shift = 0
    while mask and not mask & 1:
        mask >>= 1
        shift += 1
    return shift


def to_rows(h, pixels):
    width, height, bpp = h["width"], h["height"], h["bits_per_pixel"] // 8
    order = "little" if h["byte_order"] == 0 else "big"
    masks = [(h[k], shift_of(h[k])) for k in ("red_mask", "green_mask", "blue_mask")]
    rows = []
    for y in range(height):
        line = pixels[y * h["bytes_per_line"]:y * h["bytes_per_line"] + width * bpp]
        row = bytearray()
        for x in range(width):
            value = int.from_bytes(line[x * bpp:(x + 1) * bpp], order)
            for mask, shift in masks:
                row.append((value & mask) >> shift)
        rows.append(bytes(row))
    return rows


def write_png(path, width, height, rows):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    raw = b"".join(b"\x00" + row for row in rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def mean_brightness(rows):
    total = count = 0
    for row in rows:
        for i in range(0, len(row), 3):
            total += (row[i] + row[i + 1] + row[i + 2]) // 3
            count += 1
    return total / count if count else 0


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    header, pixels = read_xwd(sys.argv[1])
    rows = to_rows(header, pixels)
    width, height = header["width"], header["height"]
    if len(sys.argv) == 4:
        want_width, want_height = (int(part) for part in sys.argv[3].split("x"))
        width, height = min(width, want_width), min(height, want_height)
        rows = [row[:width * 3] for row in rows[:height]]
    write_png(sys.argv[2], width, height, rows)
    print(f"{width}x{height} brightness={mean_brightness(rows):.1f}")
