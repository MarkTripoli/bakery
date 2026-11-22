import { assert, assertEquals } from "@std/assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * A vendor's mark is theirs: Bakery may show it, never change it. Every file
 * under assets/provider-marks must be named in that folder's README with the
 * SHA-256 recorded there, and every row of the README must name a file that
 * exists, so a mark cannot be edited, swapped or added without the table
 * (source, guideline and date) changing with it.
 */
const ROOT = new URL("../../assets/provider-marks/", import.meta.url);
const at = (path: string) => fileURLToPath(new URL(path, ROOT));

async function sha256(path: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(at(path)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** The README's rows: file, shown on, source, guideline, date fetched, hash. */
async function rows() {
  const readme = await readFile(at("README.md"), "utf8");
  return readme.split("\n").flatMap((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return cells.length === 6 && /\.svg$/.test(cells[0])
      ? [{
        file: cells[0],
        shownOn: cells[1],
        source: cells[2],
        guideline: cells[3],
        fetched: cells[4],
        sha256: cells[5],
      }]
      : [];
  });
}

Deno.test("each mark's file matches the hash recorded in the README", async () => {
  const recorded = await rows();
  assert(recorded.length > 0);
  for (const row of recorded) {
    assertEquals(await sha256(row.file), row.sha256, row.file);
  }
});

Deno.test("each mark has a source, a guideline and a date, and a light and a dark file", async () => {
  const recorded = await rows();
  for (const row of recorded) {
    assert(/^https:\/\//.test(row.source), `${row.file} source`);
    assert(/^https:\/\//.test(row.guideline), `${row.file} guideline`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.fetched), `${row.file} date`);
  }
  const vendors = new Set(recorded.map((row) => row.file.split("/")[0]));
  for (const vendor of vendors) {
    const shown = recorded.filter((row) => row.file.startsWith(`${vendor}/`))
      .map((row) => row.shownOn).sort();
    assertEquals(shown, ["dark", "light"], vendor);
  }
});

Deno.test("the registry imports exactly the files the README records", async () => {
  const registry = await readFile(
    new URL("../../packages/ui/src/atoms/provider-marks.ts", import.meta.url),
    "utf8",
  );
  const imported = [
    ...registry.matchAll(/assets\/provider-marks\/([^"]+\.svg)"/g),
  ]
    .map((match) => match[1]).sort();
  const recorded = (await rows()).map((row) => row.file).sort();
  assertEquals(imported, recorded);
});
