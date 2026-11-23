import { type HTMLAttributes, useLayoutEffect, useRef } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { Skeleton } from "../atoms/Skeleton.tsx";
import "../steps.css";

/**
 * The bordered surface a workflow diagram is drawn on (#67). It only gives the
 * drawing a box with a definite height, which a pan-and-zoom canvas needs:
 * `page` is as tall as the diagram, so the page scrolls past it; `fill` takes
 * what is left of the window below it, never less than a readable minimum.
 * The heights are measurements, not design values, so they are written on the
 * element rather than declared in the stylesheet.
 */
export type CanvasFrameProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** `page` is a framed block as tall as `height`; `fill` fits the window. */
    variant?: "page" | "fill";
    /** The frame's height in pixels, for `page`. */
    height?: number;
    /**
     * Draws three card-sized skeletons, centred where the cards will land,
     * instead of its children: what a diagram shows while its code is fetched.
     */
    loading?: boolean;
  };

/** The shortest a filled canvas gets, in pixels. */
const FILL_MIN = 480;
/** What a filled canvas leaves below it, in pixels. */
const FILL_GAP = 24;

/** The box a workflow diagram is drawn in. */
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
