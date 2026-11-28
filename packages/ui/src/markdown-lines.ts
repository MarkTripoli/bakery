const RULE_CELL = /^:?-+:?$/;
const LONGEST_RULE = 2_000;

export const INLINE_TOKEN =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^[\]]+\]\([^\s)[]+\))/g;

export const INLINE_LINK = /^\[([^[\]]+)\]\(([^\s)[]+)\)$/;

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

export function startsTable(lines: readonly string[], index: number): boolean {
  const rule = lines[index + 1] ?? "";
  return (lines[index] ?? "").includes("|") && rule.includes("|") &&
    rule.length <= LONGEST_RULE &&
    tableCells(rule).every((cell) => RULE_CELL.test(cell));
}
