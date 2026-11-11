import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type SettingsContentProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /**
     * The "back to the parent page" link a child settings page opens with
     * (Paper renders `link(icon('back') + 'Account and security')` first
     * whenever the active page is not the account root). Rendered as the
     * first column child with no wrapper.
     */
    back?: ReactNode;
    children: ReactNode;
    /**
     * `personal` is the Paper O-0 column of the personal settings pages
     * (Profile, Appearance, Your access): 24px page title, 14px muted
     * subtitle, 720px measure, content-sized buttons. `preferences` is the
     * same column for forms with 44px buttons (Appearance). `access` is the
     * read-only Your access column: personal measure, platform UI font.
     */
    variant?: "default" | "personal" | "preferences" | "access";
  };

/**
 * The column a settings page lays its content in — Paper's `.settings-content`
 * (auth.css:10, phone auth.css:13) minus the page padding, which the app
 * shell's `<main>` gutter already supplies: 28px gaps (24px on phone) inside a
 * 760px measure, plus the 8px of block padding the phone artboards have over
 * the shell's 16px gutter. Controls inside keep Paper's fixed 44px targets and
 * full-width buttons regardless of pointer type.
 */
export function SettingsContent(
  { back, children, variant = "default", ...props }: SettingsContentProps,
) {
  return (
    <div
      className="ui-settings-content"
      {...props}
      data-state="default"
      data-ui-component="settingsContent"
      data-variant={variant}
    >
      {back}
      {children}
    </div>
  );
}
