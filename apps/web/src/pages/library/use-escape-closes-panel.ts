import { useEffect } from "react";
import { focusAfterPaint } from "../../app/focus.ts";

const OWNS_ESCAPE =
  'dialog, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]';

function selectedBlock(): HTMLElement | null {
  const marked = document.querySelector<HTMLElement>(
    '[data-ui-region="editor-work-surface"] [data-selected="true"]',
  );
  if (marked === null || marked.matches("button")) return marked;
  return marked.querySelector<HTMLElement>("button");
}

export function useEscapeClosesPanel(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.(OWNS_ESCAPE)) return;
      event.preventDefault();
      const block = selectedBlock();
      close();
      focusAfterPaint(() => block);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);
}
