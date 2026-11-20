#!/usr/bin/env python3
"""Checks a capture run: every shot exists, and each one is light or dark as its name says.

A light capture is mostly the web's light canvas (about 245) and a dark one its dark canvas (about
20), so the mean brightness tells them apart without looking. Exits 1 and names each failure.
"""
import os
import sys

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
    value = float(brightness)
    if theme == "light" and value < 180:
        failures.append(f"{name}: expected light, mean brightness {value}")
    if theme == "dark" and value > 90:
        failures.append(f"{name}: expected dark, mean brightness {value}")
print(f"{len(rows)} captures checked, {len(failures)} problems")
for failure in failures:
    print("  " + failure)
sys.exit(1 if failures else 0)
