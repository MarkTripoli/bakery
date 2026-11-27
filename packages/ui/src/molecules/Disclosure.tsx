import { type HTMLAttributes, type ReactNode, useState } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type DisclosureProps =
  & Omit<
    SemanticNativeProps<HTMLAttributes<HTMLDetailsElement>>,
    "children" | "onToggle"
  >
  & {
    /** What the closed control says, for example "Details". */
    summary: ReactNode;
    /** What opens. It is not read or reached while the control is closed. */
    children: ReactNode;
    /** A row in a list: the control spans it, so every chevron lines up. */
    variant?: "default" | "row";
    /** Starts open. Closed by default. */
    defaultOpen?: boolean;
    /** Told when the person opens or closes it: a read behind it can wait until it is open. */
    onOpenChange?: (open: boolean) => void;
  };

/**
 * A control that shows or hides secondary facts in place: a text button with a
 * chevron, and the facts beneath it when it is open. The platform's own
 * disclosure, so keyboard, focus and the accessible state come with it.
 */
export function Disclosure(
  {
    summary,
    children,
    defaultOpen = false,
    onOpenChange,
    variant = "default",
    ...unsafeProps
  }: DisclosureProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="ui-disclosure"
      open={open}
      {...props}
      data-state={open ? "open" : "closed"}
      data-ui-component="disclosure"
      data-variant={variant}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        onOpenChange?.(event.currentTarget.open);
      }}
    >
      <summary className="ui-disclosure__summary">
        <span>{summary}</span>
        <IconGlyph name="chevron-down" size="small" />
      </summary>
      <div className="ui-disclosure__body">{children}</div>
    </details>
  );
}
