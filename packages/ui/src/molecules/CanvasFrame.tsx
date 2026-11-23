import { type HTMLAttributes, useLayoutEffect, useRef } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { Skeleton } from "../atoms/Skeleton.tsx";
import "../steps.css";

export type CanvasFrameProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    variant?: "page" | "fill";
    height?: number;
    loading?: boolean;
  };

const FILL_MIN = 480;
const FILL_GAP = 24;

export function CanvasFrame(
  { children, height, loading = false, variant = "page", ...props }:
    CanvasFrameProps,
) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (variant !== "fill") return;
    const fit = () => {
      const element = frame.current;
      if (element === null) return;
      const top = element.getBoundingClientRect().top;
      element.style.blockSize = `${
        Math.max(globalThis.innerHeight - top - FILL_GAP, FILL_MIN)
      }px`;
    };
    fit();
    globalThis.addEventListener("resize", fit);
    return () => globalThis.removeEventListener("resize", fit);
  }, [variant]);
  return (
    <div
      {...props}
      className="ui-canvas-frame"
      data-state={loading ? "loading" : "default"}
      data-ui-component="canvasFrame"
      data-variant={variant}
      ref={frame}
      style={variant === "page" && height !== undefined
        ? { blockSize: `${height}px` }
        : undefined}
    >
      {loading
        ? (
          <div className="ui-canvas-frame__loading">
            <Skeleton shape="surface" />
            <Skeleton shape="surface" />
            <Skeleton shape="surface" />
          </div>
        )
        : children}
    </div>
  );
}
