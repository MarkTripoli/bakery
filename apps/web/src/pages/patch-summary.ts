export type PatchSummary = Readonly<
  { files: number; added: number; removed: number }
>;

/** Count only unified hunks whose declared old/new line counts are satisfied. */
export function summarizePatch(text: string): PatchSummary | null {
  let files = 0;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldHeader = false;
  let gitSection = false;
  let sectionHasHunk = false;
  for (const line of text.split("\n")) {
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line === "\\ No newline at end of file") continue;
      if (line.startsWith("+")) {
        newRemaining--;
        added++;
      } else if (line.startsWith("-")) {
        oldRemaining--;
        removed++;
      } else if (line.startsWith(" ")) {
        oldRemaining--;
        newRemaining--;
      } else return null;
      if (oldRemaining < 0 || newRemaining < 0) return null;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      if (gitSection && !sectionHasHunk) return null;
      gitSection = true;
      sectionHasHunk = false;
      oldHeader = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (files === 0) return null;
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      if (
        !Number.isSafeInteger(oldRemaining) ||
        !Number.isSafeInteger(newRemaining)
      ) return null;
      hunks++;
      sectionHasHunk = true;
    } else if (line.startsWith("--- ")) oldHeader = true;
    else if (line.startsWith("+++ ") && oldHeader) {
      files++;
      oldHeader = false;
    } else if (line.startsWith("+") || line.startsWith("-")) return null;
  }
  if (gitSection && !sectionHasHunk) return null;
  return hunks > 0 && oldRemaining === 0 && newRemaining === 0
    ? { files, added, removed }
    : null;
}
