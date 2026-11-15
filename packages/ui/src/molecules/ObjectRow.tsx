import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ObjectRowProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    /**
     * Fixed lanes: all four cells are always drawn and the actions lane has a
     * fixed width, so the rows of one list line up even when a row has no
     * status or metadata, or a different button. Off, the lanes follow what
     * each row holds.
     */
    aligned?: boolean;
    identity: ReactNode;
    metadata?: ReactNode;
    selected?: boolean;
    status?: ReactNode;
    state?: "default" | "selected" | "loading" | "disabled" | "stale";
    variant?: "compact" | "standard" | "comfortable";
  };

export function ObjectRow(
  {
    actions,
    aligned = false,
    identity,
    metadata,
    selected = false,
    status,
    state = selected ? "selected" : "default",
    variant = "standard",
    ...props
  }: ObjectRowProps,
) {
  return (
    <article
      aria-busy={state === "loading" || undefined}
      aria-disabled={state === "disabled" || undefined}
      data-selected={selected || state === "selected" || undefined}
      className={[
        "ui-object-row",
        `ui-object-row--${variant}`,
        aligned && "ui-object-row--aligned",
      ].filter(Boolean).join(" ")}
      {...props}
      data-ui-component="objectRow"
      data-state={state}
      data-variant={variant}
    >
      <div className="ui-object-row__identity">{identity}</div>
      {status || aligned
        ? <div className="ui-object-row__status">{status}</div>
        : null}
      {metadata || aligned
        ? <div className="ui-object-row__metadata">{metadata}</div>
        : null}
      {actions || aligned
        ? <div className="ui-object-row__actions">{actions}</div>
        : null}
    </article>
  );
}
