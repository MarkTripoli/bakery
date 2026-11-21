#!/usr/bin/env python3
"""Checks a built Linux package the way the operating system will use it.

Installing the package must register the `bakery://` scheme, and the desktop entry must hand the
address to the app (`%u`): without it a click on "Open the Bakery app" in the browser starts the
app but loses the sign-in answer. Exits 1 and names each problem.

    check_bundle.py <package.deb>
"""
import subprocess
import sys
import tarfile
import io

deb = sys.argv[1]
problems = []

control = subprocess.run(["dpkg-deb", "-I", deb], capture_output=True, text=True).stdout
if "Depends:" not in control or "libwebkit2gtk-4.1" not in control:
    problems.append("the package does not depend on the web view library")

archive = subprocess.run(["dpkg-deb", "--fsys-tarfile", deb], capture_output=True).stdout
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    names = tar.getnames()
    binaries = [n for n in names if n.endswith("/bin/bakery-desktop")]
    entries = [n for n in names if n.endswith(".desktop")]
    if not binaries:
        problems.append("the package has no bakery-desktop program")
    if len(entries) != 1:
        problems.append(f"expected one desktop entry, found {entries}")
    else:
        entry = tar.extractfile(entries[0]).read().decode()
        lines = dict(l.split("=", 1) for l in entry.splitlines() if "=" in l)
        if not lines.get("Exec", "").strip().endswith("%u"):
            problems.append(f"the desktop entry does not pass the address to the app: Exec={lines.get('Exec')}")
        if "x-scheme-handler/bakery" not in lines.get("MimeType", ""):
            problems.append(f"the desktop entry does not register bakery://: MimeType={lines.get('MimeType')}")
    icons = [n for n in names if "/icons/" in n and n.endswith(".png")]
    if not icons:
        problems.append("the package has no icon")

for p in problems:
    print("FAIL " + p)
if not problems:
    print("PASS the package registers bakery://, passes the address to the app, and has its program and icon")
sys.exit(1 if problems else 0)
