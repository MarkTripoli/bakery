import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type CellStackProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    /** Muted second line, such as a description. */
    detail?: ReactNode;
    /** Leading glyph before the lines. */
    icon?: ReactNode;
    title: ReactNode;
  };

/** The first cell of a list row: optional glyph, title and one muted line. */
export function CellStack(
  { detail, icon, title, ...props }: CellStackProps,
) {
  return (
    <span
      className="ui-cell-stack"
      {...props}
      data-state="default"
      data-ui-component="cellStack"
      data-variant={icon ? "icon" : "plain"}
    >
      {icon ? <span className="ui-cell-stack__icon">{icon}</span> : null}
      <span className="ui-cell-stack__lines">
        <span className="ui-cell-stack__title">{title}</span>
        {detail
          ? <span className="ui-cell-stack__detail">{detail}</span>
          : null}
      </span>
    </span>
  );
}
