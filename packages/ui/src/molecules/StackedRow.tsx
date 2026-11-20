import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type StackedRowProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    /** Detail lines under the head, each a short text or a link. */
    children?: ReactNode;
    /** Status shown at the end of the head line. */
    status?: ReactNode;
    /** Row title: plain text or a single control such as the row's link. */
    title: ReactNode;
    /** Drops the side inset, so the row starts where the page's own heading does. */
    flush?: boolean;
    /** Marks the row whose detail is open beside the list. */
    selected?: boolean;
  };

/**
 * One ruled row of a narrow list: a title with its status on the first line
 * and short detail lines below. It is the phone form of a table row.
 */
export function StackedRow(
  { children, flush = false, selected = false, status, title, ...props }:
    StackedRowProps,
) {
  return (
    <article
      className="ui-stacked-row"
      {...props}
      data-inset={flush ? "none" : undefined}
      data-selected={selected ? "true" : undefined}
      data-state="default"
      data-ui-component="stackedRow"
      data-variant="default"
    >
      <div className="ui-stacked-row__head">
        <span className="ui-stacked-row__title">{title}</span>
        {status}
      </div>
      {children}
    </article>
  );
}
