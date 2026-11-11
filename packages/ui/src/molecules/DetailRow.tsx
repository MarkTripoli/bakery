import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type DetailRowProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
    label: ReactNode;
    /** `code` sets the value in the data face; `positive` in the success tone. */
    tone?: "default" | "code" | "positive";
  };

/** A label and its value on one line, such as "Role  payments-api". */
export function DetailRow(
  { children, label, tone = "default", ...props }: DetailRowProps,
) {
  return (
    <div
      className="ui-detail-row"
      {...props}
      data-state="default"
      data-ui-component="detailRow"
      data-variant={tone}
    >
      <span className="ui-detail-row__label">{label}</span>
      <span className="ui-detail-row__value">{children}</span>
    </div>
  );
}
