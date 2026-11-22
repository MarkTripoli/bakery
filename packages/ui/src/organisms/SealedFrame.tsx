import type { IframeHTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../atoms/atoms.css";

export type SealedFrameProps =
  & SemanticNativeProps<
    Omit<
      IframeHTMLAttributes<HTMLIFrameElement>,
      | "allow"
      | "allowFullScreen"
      | "children"
      | "referrerPolicy"
      | "sandbox"
      | "srcDoc"
      | "title"
    >
  >
  & {
    /** The page's address; always a Bakery address, never one the page names. */
    src: string;
    /**
     * The frame's accessible name, such as "Release checklist, provided by the
     * plugin Release helper". The page inside cannot change it.
     */
    title: string;
  };

/**
 * The frame a plugin's own page runs in. It is sealed: scripts may run, and
 * nothing else is granted. It has no sign-in or storage of Bakery's (no
 * same-origin right), cannot open windows, submit forms, navigate the page
 * around it or use a camera or any other device, and sends no referrer.
 * It fills its parent and scrolls inside. Callers draw the strip above it.
 */
export function SealedFrame({ src, title, ...props }: SealedFrameProps) {
  return (
    <iframe
      className="ui-sealed-frame"
      {...props}
      data-state="default"
      data-ui-component="sealedFrame"
      data-variant="default"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={src}
      title={title}
    />
  );
}
