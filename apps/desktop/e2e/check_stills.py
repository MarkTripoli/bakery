#!/usr/bin/env python3
"""Checks a capture run: every shot exists, and each one is light or dark as its name says.

A light capture is mostly the web's light canvas (about 245) and a dark one its dark canvas (about
20), so the mean brightness tells them apart without looking. Exits 1 and names each failure.
"""
import os
import struct
import sys
import zlib

def margins(path):
    """The empty space left and right of the panel, read from the picture itself.

    The picture is the PNG this harness wrote (filter 0 rows). The canvas colour is the pixel at the
    top left; the panel starts at the first column with any other colour and ends at the last.
    """
    data = open(path, "rb").read()
    width, height = struct.unpack(">II", data[16:24])
    idat, pos = b"", 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        if kind == b"IDAT":
            idat += data[pos + 8:pos + 8 + length]
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = 1 + 3 * width
    rows = [raw[y * stride + 1:(y + 1) * stride] for y in range(height)]
    canvas = rows[0][:3]
    left, right = width, -1
    for row in rows:
        for x in range(width):
            if row[x * 3:x * 3 + 3] != canvas:
                left = min(left, x)
                right = max(right, x)
    # A panel taller than the window must start at the top and scroll: the top row is still canvas,
    # because the panel starts below the margin. A panel centred past the top edge has no canvas row.
    top_is_canvas = rows[0] == canvas * width
    return left, width - 1 - right, top_is_canvas


out = sys.argv[1]
failures = []
rows = [line.rstrip("\n").split("\t") for line in open(os.path.join(out, "results.tsv"))]
for state, size, theme, result in rows:
    name = f"{state}-{size}-{theme}"
    if not os.path.exists(os.path.join(out, name + ".png")):
        failures.append(f"{name}: no screenshot ({result})")
        continue
    wh, _, brightness = result.partition(" brightness=")
    if wh != size:
        failures.append(f"{name}: the capture is {wh}, not {size}")
    left, right, top_is_canvas = margins(os.path.join(out, name + ".png"))
    if not top_is_canvas:
        failures.append(f"{name}: the top of the panel is cut off, it should start at the top and scroll")
    if abs(left - right) > 2:
        failures.append(f"{name}: the panel is not centred (left {left}, right {right})")
    # Under 480 wide the panel fills the window less 16 on each side; at the default size it is 420 wide.
    want = 16 if int(size.split("x")[0]) < 480 else (int(size.split("x")[0]) - 420) // 2
    if abs(left - want) > 2:
        failures.append(f"{name}: margin is {left}, the design says {want}")
    value = float(brightness)
    if theme == "light" and value < 180:
        failures.append(f"{name}: expected light, mean brightness {value}")
    if theme == "dark" and value > 90:
        failures.append(f"{name}: expected dark, mean brightness {value}")
print(f"{len(rows)} captures checked, {len(failures)} problems")
for failure in failures:
    print("  " + failure)
sys.exit(1 if failures else 0)
