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
  };

/**
 * One ruled row of a narrow list: a title with its status on the first line
 * and short detail lines below. It is the phone form of a table row.
 */
export function StackedRow(
  { children, status, title, ...props }: StackedRowProps,
) {
  return (
    <article
      className="ui-stacked-row"
      {...props}
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
