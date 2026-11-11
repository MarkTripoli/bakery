import type { ReactNode } from "react";
import "../navigation.css";

export type ArtboardShellProps = {
  applicationRail: ReactNode;
  header: ReactNode;
  children: ReactNode;
  mainRole?: "main" | "presentation";
};
/**
 * Fixed two-column frame for synthetic Paper artboard templates (worker
 * readiness fixtures) that draw their own static rail artwork. It keeps the
 * pre-Paper-shell AppShell markup their approved baselines were scored
 * against. Product routes use `AppShell`.
 */
export function ArtboardShell(
  { applicationRail, children, header, mainRole = "main" }: ArtboardShellProps,
) {
  return (
    <div
      className="bakery-app-shell bakery-app-shell--artboard"
      data-state="default"
      data-variant="rail"
      data-ui-component="artboardShell"
    >
      <aside className="bakery-app-shell__rail">{applicationRail}</aside>
      <header className="bakery-app-shell__header">{header}</header>
      <div className="bakery-app-shell__body">
        {mainRole === "main"
          ? <main className="bakery-app-shell__main">{children}</main>
          : <div className="bakery-app-shell__main">{children}</div>}
      </div>
    </div>
  );
}
