import type { ReactNode } from "react";
import { Icon } from "../atoms/Icon.tsx";
import { LogoMark } from "../atoms/LogoMark.tsx";
import "../navigation.css";

export type AuthEntryStep = {
  icon: "idea" | "activity" | "batch";
  label: ReactNode;
};

export type AuthEntryProps = {
  /**
   * `brand` = Paper `authShell` (sign-in family, join, setup, organizations,
   * totp/backup challenge): 44%/56% split, brand pane left. `context` =
   * Paper `contextShell` (invite, register, invite-login): centered card,
   * columns 300px/440px. auth.css:9 (`.auth-layout`), :10 (`.context-layout`).
   */
  variant: "brand" | "context";
  /**
   * Brand pane `<h2>`, e.g. `<>Fresh commits,<br />coming right up.</>`;
   * brand variant only (the context variant shows the small top-left brand
   * mark instead, auth.js `brandSmall()`).
   */
  tagline?: ReactNode;
  /** `.brand-steps` list (3 items in the design); brand variant only. */
  steps?: readonly AuthEntryStep[];
  /** `.brand-footer`, e.g. "Your software, made together."; brand only. */
  footer?: ReactNode;
  /** Context variant's left column content (invitation summary etc.). */
  context?: ReactNode;
  /** Live region above the form. */
  status?: ReactNode;
  /**
   * `<UI.ThemeToggle label={…} />`: rendered in the brand variant's
   * form-bottom row, or in the context variant's footer row below the card
   * (auth.css:10 `.context-footer`).
   */
  themeToggle?: ReactNode;
  /** The 380px form column. */
  children: ReactNode;
};

const STEP_ICON_PATHS: Record<AuthEntryStep["icon"], ReactNode> = {
  idea: (
    <path
      d="M21 12a8 8 0 0 1-8 8H5l-4 3V11a9 9 0 0 1 20 1Z"
      transform="translate(1 -2) scale(.92)"
    />
  ),
  activity: (
    <path d="m3 17 5-5 5 3 7-10M4.5 17a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM9.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM14.5 15a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM21.5 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
  ),
  batch: (
    <path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 8h6m-6 4h6m-6 4h4" />
  ),
};

/** Route-independent layout for sign-in, invitation, and account-assurance entry screens. */
export function AuthEntry(
  { children, context, footer, status, steps, tagline, themeToggle, variant }:
    AuthEntryProps,
) {
  const themeRow = themeToggle
    ? <div className="ui-auth-entry__form-bottom">{themeToggle}</div>
    : null;
  return (
    <div
      className={`ui-auth-entry ui-auth-entry--${variant}`}
      data-state="default"
      data-ui-component="authEntry"
      data-variant={variant}
    >
      {variant === "brand"
        ? (
          <>
            <aside className="ui-auth-entry__brand-pane" aria-label="Bakery">
              <div className="ui-auth-entry__brand-content">
                <LogoMark variant="wordmark" />
                <p className="ui-auth-entry__tagline">{tagline}</p>
                {steps && steps.length > 0
                  ? (
                    <ul className="ui-auth-entry__steps">
                      {steps.map((step, index) => (
                        <li className="ui-auth-entry__step" key={index}>
                          <Icon size="large">
                            {STEP_ICON_PATHS[step.icon]}
                          </Icon>
                          <span>{step.label}</span>
                        </li>
                      ))}
                    </ul>
                  )
                  : null}
              </div>
              {footer
                ? <p className="ui-auth-entry__brand-footer">{footer}</p>
                : null}
            </aside>
            <main className="ui-auth-entry__form-pane">
              <span className="ui-auth-entry__mobile-logo">
                <LogoMark variant="wordmark" />
              </span>
              <div className="ui-auth-entry__content">
                <div className="ui-auth-entry__status" role="status">
                  {status}
                </div>
                {children}
              </div>
              {themeRow}
            </main>
          </>
        )
        : (
          <>
            <header className="ui-auth-entry__small-brand" aria-label="Bakery">
              <LogoMark variant="compact" />
              <span aria-hidden="true">Bakery</span>
            </header>
            <div className="ui-auth-entry__context-shell">
              <aside className="ui-auth-entry__context-summary">
                {context}
              </aside>
              <main className="ui-auth-entry__content">
                <div className="ui-auth-entry__status" role="status">
                  {status}
                </div>
                {children}
              </main>
            </div>
            {themeToggle
              ? (
                <div className="ui-auth-entry__context-footer">
                  {themeToggle}
                </div>
              )
              : null}
          </>
        )}
    </div>
  );
}
