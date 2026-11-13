import type { Locator } from "@playwright/test";

/**
 * Where a machine row's one control sits against the row's own text (#338).
 * A visible-and-clickable check cannot see a button that covers its reason
 * line, so this measures: every text box in the row against the control's box.
 */
export type RowActionGeometry = Readonly<{
  /** The control's label, e.g. "Open" or "Fix". */
  label: string;
  width: number;
  height: number;
  /** Text in the row the control's box covers, with the overlapping area. */
  overlaps: ReadonlyArray<Readonly<{ text: string; area: number }>>;
}>;

export async function rowActionGeometry(
  row: Locator,
): Promise<RowActionGeometry> {
  return await row.evaluate((element): RowActionGeometry => {
    const control = [...element.querySelectorAll<HTMLElement>("a, button")]
      .find((candidate) =>
        /^(Open|Fix)\b/.test(candidate.textContent?.trim() ?? "")
      );
    if (control === undefined) {
      return { label: "", width: 0, height: 0, overlaps: [] };
    }
    const box = control.getBoundingClientRect();
    const overlaps: { text: string; area: number }[] = [];
    for (const node of element.querySelectorAll("*")) {
      if (control.contains(node) || node.contains(control)) continue;
      if (node.children.length > 0) continue;
      const text = node.textContent?.trim() ?? "";
      if (text === "") continue;
      const other = node.getBoundingClientRect();
      const width = Math.min(other.right, box.right) -
        Math.max(other.left, box.left);
      const height = Math.min(other.bottom, box.bottom) -
        Math.max(other.top, box.top);
      if (width > 0 && height > 0) {
        overlaps.push({
          text: text.slice(0, 40),
          area: Math.round(width * height),
        });
      }
    }
    return {
      label: control.textContent?.trim() ?? "",
      width: Math.round(box.width),
      height: Math.round(box.height),
      overlaps,
    };
  });
}
