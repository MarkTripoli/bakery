import type { AnchorHTMLAttributes, ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type SettingsIndexRowProps =
  & Omit<
    SemanticNativeProps<AnchorHTMLAttributes<HTMLAnchorElement>>,
    "children" | "title"
  >
  & {
    /** Destination settings page. */
    href: string;
    /** Section name, e.g. "Appearance". */
    title: ReactNode;
    /** Muted summary of what the section holds. */
    description?: ReactNode;
  };

/**
 * One row of the phone Settings index — Paper O-0 `settings-index-phone`:
 * title, muted summary and a trailing chevron, the whole row a link. The
 * index replaces the section sidebar on narrow screens; sibling rows keep the
 * same ordered model as `SectionNavigation`.
 */
export function SettingsIndexRow(
  { description, title, ...props }: SettingsIndexRowProps,
) {
  return (
    <a
      className="ui-settings-index-row"
      {...props}
      data-state="default"
      data-ui-component="settingsIndexRow"
      data-variant="default"
    >
      <span className="ui-settings-index-row__body">
        <span className="ui-settings-index-row__title">{title}</span>
        {description
          ? (
            <span className="ui-settings-index-row__description">
              {description}
            </span>
          )
          : null}
      </span>
      <span aria-hidden="true" className="ui-settings-index-row__chevron">
        <IconGlyph name="chevron-right" size="medium" />
      </span>
    </a>
  );
}
