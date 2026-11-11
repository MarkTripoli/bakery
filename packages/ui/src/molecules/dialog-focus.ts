import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useEffect } from "react";

export function useNativeDialogOpen(
  dialogRef: RefObject<HTMLDialogElement | null>,
  isOpen: boolean,
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let observer: MutationObserver | undefined;
    const syncOpenState = () => {
      observer?.disconnect();
      if (!isOpen) {
        if (dialog.open) dialog.close();
        return;
      }
      if (dialog.open) return;
      const hiddenAncestor = dialog.closest<HTMLElement>("[hidden]");
      if (hiddenAncestor) {
        observer ??= new MutationObserver(syncOpenState);
        observer.observe(hiddenAncestor, {
          attributes: true,
          attributeFilter: ["hidden"],
        });
        return;
      }
      dialog.showModal();
    };

    syncOpenState();
    return () => observer?.disconnect();
  }, [dialogRef, isOpen]);
}

function isSequentiallyFocusable(element: HTMLElement) {
  if (element.matches(":disabled") || element.closest("[inert]")) return false;
  if (element.tabIndex < 0 && !element.isContentEditable) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" &&
    element.getClientRects().length > 0;
}

function collectFocusable(root: ParentNode) {
  const focusable: HTMLElement[] = [];
  const visit = (parent: ParentNode) => {
    for (const node of parent.childNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (isSequentiallyFocusable(node)) focusable.push(node);
      if (node.shadowRoot) visit(node.shadowRoot);
      visit(node);
    }
  };
  visit(root);
  return focusable;
}

export function containDialogFocus(
  event: ReactKeyboardEvent<HTMLDialogElement>,
) {
  if (event.key !== "Tab") return;
  const focusable = collectFocusable(event.currentTarget);
  if (focusable.length < 2) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (document.activeElement === first && event.shiftKey) {
    event.preventDefault();
    last?.focus();
  } else if (document.activeElement === last && !event.shiftKey) {
    event.preventDefault();
    first.focus();
  }
}
