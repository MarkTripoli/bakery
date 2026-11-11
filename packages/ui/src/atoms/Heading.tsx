import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

type HeadingLevel =
  | "page"
  | "section"
  | "subsection"
  | "subsection-compact"
  | "page-plain"
  | "section-plain";
export type HeadingProps =
  & SemanticNativeProps<HTMLAttributes<HTMLHeadingElement>>
  & {
    children: ReactNode;
    level?: HeadingLevel;
    /**
     * Outline rank when it must differ from the visual level: a subsection-
     * sized heading that is the first heading under an h1 is an h2 in the
     * document outline (axe heading-order) while keeping its type scale.
     */
    rank?: 1 | 2 | 3;
  };

export function Heading({ level = "section", rank, ...props }: HeadingProps) {
  const Tag = rank !== undefined
    ? (`h${rank}` as "h1" | "h2" | "h3")
    : level.startsWith("page")
    ? "h1"
    : level.startsWith("section")
    ? "h2"
    : "h3";
  return (
    <Tag
      className={["ui-heading", `ui-heading--${level}`].filter(Boolean).join(
        " ",
      )}
      {...props}
      data-state="default"
      data-ui-component="heading"
      data-variant={level}
    />
  );
}
