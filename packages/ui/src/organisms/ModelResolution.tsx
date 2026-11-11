import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type ModelResolutionProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    children?: ReactNode;
    model: ReactNode;
    provider?: ReactNode;
    reason?: ReactNode;
    status?: "resolved" | "overridden" | "unsupported" | "unavailable";
    title?: ReactNode;
    variant?: "summary" | "detailed";
  };

/** Displays a resolved model selection and the context supplied by its owner. */
export function ModelResolution(
  {
    children,
    model,
    provider,
    reason,
    status = "resolved",
    title = "Model resolution",
    variant = "detailed",
    ...props
  }: ModelResolutionProps,
) {
  return (
    <section
      className={[
        "ui-model-resolution",
        `ui-model-resolution--${status}`,
      ]
        .filter(Boolean).join(" ")}
      {...props}
      data-state={status}
      data-ui-component="modelResolution"
      data-variant={variant}
    >
      <h3>{title}</h3>
      <p className="ui-model-resolution__status">{status}</p>
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{model}</dd>
        </div>
        {variant === "detailed" && provider
          ? (
            <div>
              <dt>Provider</dt>
              <dd>{provider}</dd>
            </div>
          )
          : null}
        {variant === "detailed" && reason
          ? (
            <div>
              <dt>Reason</dt>
              <dd>{reason}</dd>
            </div>
          )
          : null}
      </dl>
      {children ? <div>{children}</div> : null}
    </section>
  );
}
