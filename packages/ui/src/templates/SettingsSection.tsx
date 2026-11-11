import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "../atoms/Heading.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type SettingsSectionProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** The `<h2>` naming the group of rows, e.g. "Account protection". */
    title: ReactNode;
    children: ReactNode;
    /**
     * `plain` (default) is Paper's bare `<section>`: the heading sits directly
     * on the first row, whose own block padding provides the spacing.
     * `stack` is Paper's `<section class="stack">` (auth.css:8 `.stack`): a
     * 20px column, used when notices or buttons follow the rows.
     */
    variant?: "plain" | "stack";
  };

/**
 * A titled group of `DescriptionItem` rows — Paper's `<section><h2>…</h2>` in
 * the settings artboards (auth.js `security`, `two-factor`); the `h2` takes
 * Paper's 24px/32px heading size (auth.css:8 `h2`).
 */
export function SettingsSection(
  { children, title, variant = "plain", ...props }: SettingsSectionProps,
) {
  return (
    <section
      className={[
        "ui-settings-section",
        variant === "stack" ? "ui-settings-section--stack" : "",
      ].filter(Boolean).join(" ")}
      {...props}
      data-state="default"
      data-ui-component="settingsSection"
      data-variant={variant}
    >
      <Heading level="section">{title}</Heading>
      {children}
    </section>
  );
}
