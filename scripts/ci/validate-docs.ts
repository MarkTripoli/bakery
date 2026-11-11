const root = Deno.cwd();
const learningDir = `${root}/learnings`;
const xmlFiles: string[] = [];
for await (const entry of Deno.readDir(learningDir)) {
  if (entry.isFile && entry.name.endsWith(".xml")) xmlFiles.push(entry.name);
}
xmlFiles.sort();
const files = ["index.xml", ...xmlFiles.filter((name) => name !== "index.xml")];
const paths = files.map((name) => `${learningDir}/${name}`);
const python = `import os, sys, xml.etree.ElementTree as ET
paths = sys.argv[1:]
for path in paths:
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    if any(line.rstrip(" \\t") != line for line in source.splitlines()):
        raise SystemExit(f"trailing whitespace: {os.path.relpath(path)}")
    try:
        ET.fromstring(source)
    except ET.ParseError as error:
        raise SystemExit(f"invalid XML: {os.path.relpath(path)}: {error}")
index = ET.parse(paths[0]).getroot()
seen = set()
for entry in index.findall("entry"):
    name = entry.get("file")
    if not name or name in seen or not name.endswith(".xml"):
        raise SystemExit("learning index has duplicate or invalid entries")
    seen.add(name)
    if not os.path.isfile(os.path.join(os.path.dirname(paths[0]), name)):
        raise SystemExit(f"learning index references missing file: {name}")
print(f"validated {len(paths)} learning XML files and {len(seen)} index entries")
`;
const result = await new Deno.Command("python3", {
  args: ["-c", python, ...paths],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!result.success) Deno.exit(result.code || 1);
