import type { HTMLAttributes, ReactNode } from "react";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type CapabilityListItem = {
  /** Stable key for the capability. */
  id: string;
  /** Leading glyph; omit for rows that carry only text. */
  icon?: IconGlyphName;
  /** Bold capability name, e.g. "Read work and artifacts". */
  title: ReactNode;
  /** Muted one-sentence scope of the capability. */
  description?: ReactNode;
  /** Trailing level such as "Manage" or "Scoped" (`access` variant). */
  value?: ReactNode;
};

export type CapabilityListProps =
  & SemanticNativeProps<HTMLAttributes<HTMLUListElement>>
  & {
    /** Accessible name of the list, e.g. "Requested access". */
    "aria-label": string;
    items: readonly CapabilityListItem[];
    /**
     * `consent` = the OAuth consent scope list (V-0 consent frames); `access`
     * = the read-only effective-access rows with a trailing level (O-0
     * developer-access frames).
     */
    variant?: "consent" | "access";
  };

/**
 * An ordered list of what a grant or role allows — icon, title, one-line
 * scope and an optional trailing level. A real list so assistive technology
 * announces the count; `DescriptionItem` rows are generic `div`s.
 */
export function CapabilityList(
  { items, variant = "consent", ...props }: CapabilityListProps,
) {
  return (
    <ul
      className={`ui-capability-list ui-capability-list--${variant}`}
      {...props}
      data-state="default"
      data-ui-component="capabilityList"
      data-variant={variant}
    >
      {items.map((item) => (
        <li className="ui-capability-list__item" key={item.id}>
          {item.icon
            ? (
              <span className="ui-capability-list__icon">
                <IconGlyph name={item.icon} size="large" />
              </span>
            )
            : null}
          <span className="ui-capability-list__body">
            <span className="ui-capability-list__title">{item.title}</span>
            {item.description
              ? (
                <span className="ui-capability-list__description">
                  {item.description}
                </span>
              )
              : null}
          </span>
          {item.value
            ? <span className="ui-capability-list__value">{item.value}</span>
            : null}
        </li>
      ))}
    </ul>
  );
}
