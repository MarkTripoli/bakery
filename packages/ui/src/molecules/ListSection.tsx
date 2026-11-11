import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ListSectionProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** Trailing control, such as a "Register repository" button. */
    actions?: ReactNode;
    children: ReactNode;
    /** One muted line under the title. */
    description?: ReactNode;
    title: ReactNode;
    /**
     * `table` heads a ruled table on a 24px page inset; `list` heads the
     * phone row list on a 16px inset.
     */
    variant?: "table" | "list";
  };

/** A titled block of a list page: title, optional line, trailing action. */
export function ListSection(
  { actions, children, description, title, variant = "table", ...props }:
    ListSectionProps,
) {
  return (
    <section
      className="ui-list-section"
      {...props}
      data-state="default"
      data-ui-component="listSection"
      data-variant={variant}
    >
      <header className="ui-list-section__header">
        <div className="ui-list-section__lead">
          <h2 className="ui-list-section__title">{title}</h2>
          {description
            ? <p className="ui-list-section__description">{description}</p>
            : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
