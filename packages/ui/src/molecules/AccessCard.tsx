import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type AccessCardProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "title">>
  & {
    /** Leading mark, e.g. an `Avatar`. */
    leading?: ReactNode;
    /** Bold name of what the card describes, e.g. the role. */
    title: ReactNode;
    /** Muted line under the title. */
    description?: ReactNode;
    /** Trailing status, e.g. a `Badge`. */
    trailing?: ReactNode;
    /** Extra rows under the heading, such as chips and a closing note. */
    children?: ReactNode;
  };

/**
 * A bordered summary card on the Your access page — Paper O-0 role card and
 * external-actions card: an optional leading mark, a title with a muted line,
 * a trailing status and any extra rows below.
 */
export function AccessCard(
  { children, description, leading, title, trailing, ...props }:
    AccessCardProps,
) {
  return (
    <div
      className="ui-access-card"
      {...props}
      data-state="default"
      data-ui-component="accessCard"
      data-variant="card"
    >
      <div className="ui-access-card__heading">
        {leading}
        <span className="ui-access-card__body">
          <span className="ui-access-card__title">{title}</span>
          {description
            ? (
              <span className="ui-access-card__description">
                {description}
              </span>
            )
            : null}
        </span>
        {trailing}
      </div>
      {children}
    </div>
  );
}
