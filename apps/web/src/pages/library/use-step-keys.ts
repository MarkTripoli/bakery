import { useEffect, useRef } from "react";

const OWNS_KEYS =
  'dialog, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]';
const TYPES_TEXT = 'input, textarea, select, [contenteditable="true"]';

export type StepKeys = Readonly<{
  move: (id: string, by: -1 | 1) => void;
  remove: (id: string) => void;
  undo: () => void;
  redo: () => void;
}>;

export function useStepKeys(enabled: boolean, keys: StepKeys): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.defaultPrevented || event.isComposing) return;
      if (target?.closest?.(OWNS_KEYS)) return;
      const typing = !!target?.closest?.(TYPES_TEXT);
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) latest.current.redo();
        else latest.current.undo();
        return;
      }
      const id = target?.closest?.("[data-card]")?.getAttribute("data-card");
      if (!id || id === "start" || typing || command) return;
      if (event.altKey && /^Arrow(Up|Down)$/.test(event.key)) {
        event.preventDefault();
        latest.current.move(id, event.key === "ArrowUp" ? -1 : 1);
      } else if (event.key === "Delete") {
        event.preventDefault();
        latest.current.remove(id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
