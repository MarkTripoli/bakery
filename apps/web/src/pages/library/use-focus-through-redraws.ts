import { useEffect } from "react";

export function useFocusThroughRedraws(region: string): void {
  useEffect(() => {
    const root = document.querySelector(`[data-ui-region="${region}"]`);
    if (root === null) return;
    let card: string | null = null;
    const follow = (event: Event) => {
      card = (event.target as Element).closest("[data-card]")
        ?.getAttribute("data-card") ?? null;
    };
    const forget = () => {
      card = null;
    };
    const redrawn = new MutationObserver(() => {
      if (card === null || document.activeElement !== document.body) return;
      root.querySelector<HTMLElement>(
        `[data-card="${CSS.escape(card)}"] button`,
      )?.focus({ preventScroll: true });
    });
    root.addEventListener("focusin", follow);
    document.addEventListener("pointerdown", forget, true);
    redrawn.observe(root, { childList: true, subtree: true });
    return () => {
      redrawn.disconnect();
      root.removeEventListener("focusin", follow);
      document.removeEventListener("pointerdown", forget, true);
    };
  }, [region]);
}
