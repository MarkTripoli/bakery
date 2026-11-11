import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type PaneSectionProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    children: ReactNode;
    /** Draws a rule under the section, separating it from the next one. */
    ruled?: boolean;
    /** Quiet section label, such as "Participants (2)". */
    title?: ReactNode;
    /** `strong` sets the title in the 14px semibold ink of an inspector card. */
    heading?: "label" | "strong";
    /** Trailing status beside a title, such as a state pill. */
    trailing?: ReactNode;
  };

/** A padded block of a side pane, optionally titled and ruled below. */
export function PaneSection(
  {
    children,
    heading = "label",
    ruled = false,
    title,
    trailing,
    ...props
  }: PaneSectionProps,
) {
  return (
    <section
      className="ui-pane-section"
      {...props}
      data-heading={heading}
      data-state={ruled ? "ruled" : "default"}
      data-ui-component="paneSection"
      data-variant="default"
    >
      {title
        ? (
          <div className="ui-pane-section__heading">
            <h2 className="ui-pane-section__title">{title}</h2>
            {trailing}
          </div>
        )
        : null}
      {children}
    </section>
  );
}
