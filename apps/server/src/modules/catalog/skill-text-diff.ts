/**
 * A line difference between two versions of a text file, written as hunks with
 * three lines of context: a line kept starts with a space, a line removed with
 * "-", a line added with "+". It answers "what changed in this file" for a
 * person reviewing a source update, so it is bounded: a file or a difference
 * past the limits is reported as too large instead of being worked out.
 */

/** The most lines either side may have for a difference to be worked out. */
export const SKILL_TEXT_DIFF_MAX_LINES = 2000;
/** The most lines of difference (hunks included) one file may report. */
export const SKILL_TEXT_DIFF_MAX_OUTPUT_LINES = 400;
/** The largest file, in bytes, a text difference is worked out for. */
export const SKILL_TEXT_DIFF_MAX_BYTES = 256 * 1024;

const CONTEXT = 3;

export type SkillTextDiff =
  | Readonly<{ kind: "diff"; text: string }>
  | Readonly<{ kind: "omitted"; reason: "binary" | "too_large" }>;

/** The file as text, or null when it is not UTF-8 text (it holds a NUL byte or invalid UTF-8). */
export function skillFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Edit = Readonly<{ op: " " | "-" | "+"; line: string }>;

function edits(before: string[], after: string[]): Edit[] | null {
  let start = 0;
  while (
    start < before.length && start < after.length &&
    before[start] === after[start]
  ) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start && endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (
    a.length > SKILL_TEXT_DIFF_MAX_LINES || b.length > SKILL_TEXT_DIFF_MAX_LINES
  ) {
    return null;
  }
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const result: Edit[] = [];
  for (let i = 0; i < start; i++) result.push({ op: " ", line: before[i] });
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      result.push({ op: "-", line: a[i++] });
    } else {
      result.push({ op: "+", line: b[j++] });
    }
  }
  while (i < a.length) result.push({ op: "-", line: a[i++] });
  while (j < b.length) result.push({ op: "+", line: b[j++] });
  for (let k = endBefore; k < before.length; k++) {
    result.push({ op: " ", line: before[k] });
  }
  return result;
}

/**
 * The difference from before to after, or why there is none to show. Text that
 * is identical gives an empty difference. Two sides that are not both text are
 * "binary".
 */
export function diffSkillText(
  before: Uint8Array | null,
  after: Uint8Array | null,
): SkillTextDiff {
  const beforeText = before === null ? "" : skillFileText(before);
  const afterText = after === null ? "" : skillFileText(after);
  if (beforeText === null || afterText === null) {
    return { kind: "omitted", reason: "binary" };
  }
  if (
    (before?.byteLength ?? 0) > SKILL_TEXT_DIFF_MAX_BYTES ||
    (after?.byteLength ?? 0) > SKILL_TEXT_DIFF_MAX_BYTES
  ) return { kind: "omitted", reason: "too_large" };
  const all = edits(splitLines(beforeText), splitLines(afterText));
  if (all === null) return { kind: "omitted", reason: "too_large" };

  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((edit, index) => {
    if (edit.op === " ") return;
    for (
      let k = Math.max(0, index - CONTEXT);
      k <= Math.min(all.length - 1, index + CONTEXT);
      k++
    ) keep[k] = true;
  });
  const out: string[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let index = 0;
  while (index < all.length) {
    if (!keep[index]) {
      if (all[index].op !== "+") beforeLine++;
      if (all[index].op !== "-") afterLine++;
      index++;
      continue;
    }
    let beforeCount = 0;
    let afterCount = 0;
    const lines: string[] = [];
    while (index < all.length && keep[index]) {
      const { op, line } = all[index];
      lines.push(op + line);
      if (op !== "+") beforeCount++;
      if (op !== "-") afterCount++;
      index++;
    }
    out.push(
      "@@ -" + beforeLine + "," + beforeCount + " +" + afterLine + "," +
        afterCount + " @@",
      ...lines,
    );
    beforeLine += beforeCount;
    afterLine += afterCount;
    if (out.length > SKILL_TEXT_DIFF_MAX_OUTPUT_LINES) {
      return { kind: "omitted", reason: "too_large" };
    }
  }
  return { kind: "diff", text: out.join("\n") };
}
