import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../controls.css";

type NativeButtonProps =
  & SemanticNativeProps<ButtonHTMLAttributes<HTMLButtonElement>>
  & {
    children: ReactNode;
    busy?: boolean;
    loading?: boolean;
    state?: "default" | "pressed" | "loading" | "disabled" | "busy";
    /**
     * `outline` is the Paper E-0 secondary: surface fill, quiet border.
     * `destructive-outline` is the same frame with destructive text, for a
     * consequential action that is not the primary choice (p-18-0). `text`
     * is a link-styled action in the selection ink (p-18-0 inspector).
     */
    variant?:
      | "primary"
      | "secondary"
      | "outline"
      | "quiet"
      | "text"
      | "destructive"
      | "destructive-outline"
      | "destructive-quiet";
  };

function NativeButton(
  {
    children,
    busy = false,
    disabled,
    loading = false,
    state,
    type = "button",
    variant = "primary",
    ...props
  }: NativeButtonProps,
) {
  const resolvedState = state ??
    (busy ? "busy" : loading ? "loading" : disabled ? "disabled" : "default");
  return (
    <button
      aria-busy={loading || busy || undefined}
      className={["ui-button", `ui-button--${variant}`].filter(Boolean).join(
        " ",
      )}
      {...props}
      data-state={resolvedState}
      data-ui-component="button"
      data-variant={variant}
      disabled={disabled || loading || busy}
      type={type}
    >
      {children}
    </button>
  );
}

/** Static control artwork for visibly labelled prototypes; never an action. */
export type ButtonPreviewProps = {
  children: string;
  variant: "preview-primary" | "preview-secondary";
  /** Standard source control typography; compact artwork remains the default. */
  density?: "standard" | "static-compact";
};

export type ButtonProps = NativeButtonProps | ButtonPreviewProps;

function isButtonPreview(props: ButtonProps): props is ButtonPreviewProps {
  return props.variant === "preview-primary" ||
    props.variant === "preview-secondary";
}

export function Button(props: ButtonProps) {
  if (isButtonPreview(props)) {
    return (
      <span
        className={`ui-button ui-button--${
          props.variant.slice(8)
        } ui-button--preview`}
        data-density={props.density}
        data-ui-component="button"
        data-variant={props.density
          ? `${props.variant}-${props.density}`
          : props.variant}
        data-state="default"
      >
        {props.children}
      </span>
    );
  }
  return <NativeButton {...props} />;
}
