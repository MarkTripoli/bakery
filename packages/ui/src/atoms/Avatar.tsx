import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type AvatarProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLSpanElement>, "children">>
  & {
    alt: string;
    fallback?: ReactNode;
    size?: "small" | "medium" | "large";
    src?: string;
    state?: "default" | "fallback";
    variant?: "image" | "initials" | "icon";
  };

export function Avatar(
  {
    alt,
    fallback,
    size = "medium",
    src,
    state = src ? "default" : "fallback",
    variant = src ? "image" : "initials",
    ...props
  }: AvatarProps,
) {
  // A photo that fails to load falls back to the initials; a new `src` retries.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => setFailedSrc(null), [src]);
  const broken = src !== undefined && failedSrc === src;
  const initials = alt.split(/\s+/).map((word) => word[0]).join("").slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-label={alt}
      className={[
        "ui-avatar",
        `ui-avatar--${size}`,
        `ui-avatar--${variant}`,
      ].filter(Boolean).join(" ")}
      {...props}
      data-state={broken ? "fallback" : state}
      data-ui-component="avatar"
      data-variant={broken ? "initials" : variant}
      role="img"
    >
      {variant === "image" && src && state === "default" && !broken
        ? <img alt="" onError={() => setFailedSrc(src)} src={src} />
        : fallback ?? initials}
    </span>
  );
}
