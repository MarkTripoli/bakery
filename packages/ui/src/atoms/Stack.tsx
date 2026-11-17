import type { HTMLAttributes, ReactNode, Ref } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type StackProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
    gap?: "none" | "tight" | "compact" | "standard" | "spacious";
    /**
     * The underlying `div`. `HTMLAttributes` carries no `ref`, and React 19
     * forwards it as a normal prop, so a caller that has to measure or track
     * scroll on its own stack asks for it here.
     */
    ref?: Ref<HTMLDivElement>;
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
