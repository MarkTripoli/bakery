import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type SpinnerProps = SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>;

export function Spinner(props: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className="ui-spinner"
      {...props}
      data-state="loading"
      data-ui-component="spinner"
      data-variant="default"
    />
  );
}
