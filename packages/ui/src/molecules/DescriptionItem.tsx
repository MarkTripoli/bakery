import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type DescriptionItemProps =
  // `title` is the row's bold title below, a node; the native attribute is not it.
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    /** Leading glyph, e.g. `<UI.IconGlyph name="shield" size="large" />`. */
    icon?: ReactNode;
    /**
     * Leading square tile holding a single character — Paper's `.avatar`
     * (auth.css:8), used instead of `icon` for named subjects such as an
     * organization in the membership list.
     */
    initial?: string;
    /** Bold title, e.g. a sign-in method or session device name. */
    title: ReactNode;
    /** Muted single-line detail below the title. */
    description?: ReactNode;
    /** Trailing link, button, or badge. */
    action?: ReactNode;
    /**
     * Makes the whole row the control (Paper's `.item.selectable`): the row
     * becomes a `<button>` and `action` is reserved for the affordance that
     * shows where it leads, e.g. `<UI.IconGlyph name="arrow" size="large" />`.
     */
    onSelect?: () => void;
  };

/**
 * A labelled row — icon or initial, stacked title/description, trailing
 * action — matching the Paper mock's `identity()` helper (settings
 * sign-in-method and protection rows, session device rows) and, with
 * `onSelect`, its `.item.selectable` variant (the organization chooser).
 * Distinct from `ObjectRow` (tabular grid rows for data lists) and
 * `Identity` (person/agent avatar badges): this is a single flex row with
 * no column alignment across siblings.
 */
export function DescriptionItem(
  { action, description, icon, initial, onSelect, title, ...props }:
    DescriptionItemProps,
) {
  const content = (
    <>
      {initial === undefined
        ? icon === undefined
          ? null
          : <div className="ui-description-item__icon">{icon}</div>
        : (
          <span aria-hidden="true" className="ui-description-item__avatar">
            {initial}
          </span>
        )}
      <div className="ui-description-item__body">
        <div className="ui-description-item__title">{title}</div>
        {description
          ? (
            <div className="ui-description-item__description">
              {description}
            </div>
          )
          : null}
      </div>
      {action
        ? <div className="ui-description-item__action">{action}</div>
        : null}
    </>
  );
  if (onSelect) {
    return (
      <button
        className="ui-description-item ui-description-item--selectable"
        {...props}
        onClick={onSelect}
        data-state="default"
        data-ui-component="descriptionItem"
        data-variant="selectable"
        type="button"
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className="ui-description-item"
      {...props}
      data-state="default"
      data-ui-component="descriptionItem"
      data-variant="default"
    >
      {content}
    </div>
  );
}
