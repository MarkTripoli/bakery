const RULE_CELL = /^:?-+:?$/;
const LONGEST_RULE = 2_000;
const MOST_COLUMNS = 50;

export const MOST_TABLE_CELLS = 5_000;

export const HEADING = /^(#{1,6})\s+(\S.*)$/;

export const INLINE_TOKEN =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^[\]]+\]\((?:[^\s)\]]|\](?!\())+\))/g;

export const INLINE_LINK = /^\[([^[\]]+)\]\(((?:[^\s)\]]|\](?!\())+)\)$/;

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

export function readTable(
  lines: readonly string[],
  index: number,
  cellsLeft: number,
) {
  let end = index + 2;
  while (end < lines.length && lines[end]?.includes("|")) end++;
  const header = tableCells(lines[index] ?? "");
  if (header.length > MOST_COLUMNS || header.length > cellsLeft) {
    return {
      header: [],
      rows: [],
      overflow: lines.slice(index, end),
      cells: 0,
      end,
    };
  }
  const first = index + 2;
  const last = Math.min(
    end,
    first + Math.floor(cellsLeft / header.length) - 1,
  );
  const rows = lines.slice(first, last).map(tableCells);
  return {
    header,
    rows,
    overflow: lines.slice(last, end),
    cells: header.length * (rows.length + 1),
    end,
  };
}
