import { useEffect } from "react";

const TAKEN_OVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export function useArrivalScroll(id: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || globalThis.location.hash !== `#${id}`) return;
    const target = globalThis.document.getElementById(id);
    if (target === null) return;
    const settle = () => target.scrollIntoView();
    const observer = new ResizeObserver(settle);
    for (
      let above = target.parentElement;
      above !== null;
      above = above.parentElement
    ) observer.observe(above);
    const stop = () => {
      observer.disconnect();
      TAKEN_OVER.forEach((event) =>
        globalThis.removeEventListener(event, stop)
      );
    };
    TAKEN_OVER.forEach((event) =>
      globalThis.addEventListener(event, stop, { passive: true })
    );
    settle();
    return stop;
  }, [id, ready]);
}
