import { useSyncExternalStore } from "react";

export type ShellViewport = "phone" | "tablet" | "desktop";

function subscribeToViewport(onChange: () => void): () => void {
  const phone = globalThis.matchMedia("(max-width: 743px)");
  const desktop = globalThis.matchMedia("(min-width: 1280px)");
  phone.addEventListener("change", onChange);
  desktop.addEventListener("change", onChange);
  return () => {
    phone.removeEventListener("change", onChange);
    desktop.removeEventListener("change", onChange);
  };
}

function currentViewport(): ShellViewport {
  if (globalThis.matchMedia("(max-width: 743px)").matches) return "phone";
  if (globalThis.matchMedia("(min-width: 1280px)").matches) return "desktop";
  return "tablet";
}

export function useShellViewport(): ShellViewport {
  return useSyncExternalStore(
    subscribeToViewport,
    currentViewport,
    () => "desktop",
  );
}
