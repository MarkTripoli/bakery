import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type StackProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
    gap?: "none" | "tight" | "compact" | "standard" | "spacious";
  };

export function Stack({ gap = "standard", ...props }: StackProps) {
  return (
    <div
      className={["ui-stack", `ui-stack--${gap}`].filter(Boolean).join(" ")}
      {...props}
      data-state="default"
      data-ui-component="stack"
      data-variant={gap}
    />
  );
}
