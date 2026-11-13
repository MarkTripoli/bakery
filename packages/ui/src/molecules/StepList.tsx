import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

export type StepListProps =
  & SemanticNativeProps<HTMLAttributes<HTMLOListElement>>
  & {
    /** Accessible name of the list, such as "Delivery steps". */
    label: string;
    /** `StepItem`s, in the order the steps happen. */
    children: ReactNode;
  };

/** An ordered list of gates, each a `StepItem` with a status and a result. */
export function StepList({ children, label, ...props }: StepListProps) {
  return (
    <ol
      aria-label={label}
      className="ui-step-list"
      {...props}
      data-state="default"
      data-ui-component="stepList"
      data-variant="default"
    >
      {children}
    </ol>
  );
}
