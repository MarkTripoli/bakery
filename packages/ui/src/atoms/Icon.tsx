import type { ReactNode, SVGAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type IconProps =
  & SemanticNativeProps<SVGAttributes<SVGSVGElement>>
  & {
    children: ReactNode;
    label?: string;
    size?: "small" | "medium" | "large";
  };

const iconSizes = { small: 16, medium: 18, large: 20 } as const;

export function Icon(
  {
    "aria-label": ariaLabel,
    children,
    label,
    size = "medium",
    ...props
  }: IconProps,
) {
  const pixelSize = iconSizes[size];
  const accessibleName = label ?? ariaLabel;
  return (
    <svg
      aria-hidden={accessibleName ? undefined : true}
      aria-label={accessibleName}
      className={`ui-icon ui-icon--${size}`}
      fill="none"
      focusable="false"
      height={pixelSize}
      role={accessibleName ? "img" : undefined}
      viewBox="0 0 24 24"
      width={pixelSize}
      {...props}
      data-state={accessibleName ? "named" : "decorative"}
      data-ui-component="icon"
      data-variant={size}
    >
      {children}
    </svg>
  );
}
