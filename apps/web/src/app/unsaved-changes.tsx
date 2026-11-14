import { useEffect, useId, useSyncExternalStore } from "react";

/**
 * Which mounted forms hold input the person has not saved. A form registers
 * while it is dirty; the shell reads the count to ask before a switch of
 * organization throws that input away.
 */
const dirtyForms = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = 0;

function publish() {
  snapshot = dirtyForms.size;
  for (const listener of listeners) listener();
}

/** Registers the calling form as holding unsaved input while `dirty` is true. */
export function useUnsavedChanges(dirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!dirty) return;
    dirtyForms.add(id);
    publish();
    return () => {
      dirtyForms.delete(id);
      publish();
    };
  }, [dirty, id]);
}

/** How many mounted forms hold unsaved input right now. */
export function useUnsavedChangeCount(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => 0,
  );
}
