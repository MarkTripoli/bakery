import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type SpacerProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    variant?: "inline" | "block";
  };

/** Flexible layout space that consumes named spacing roles. */
export function Spacer({ variant = "block", ...props }: SpacerProps) {
  return (
    <div
      aria-hidden="true"
      className={["ui-spacer", `ui-spacer--${variant}`].filter(Boolean).join(
        " ",
      )}
      {...props}
      data-state="default"
      data-ui-component="spacer"
      data-variant={variant}
    />
  );
}
