import type { MouseEvent, ReactNode } from "react";
import * as UI from "@bakery/ui";

export type ActionLinkProps = {
  /** Where the link would go without script; kept so it stays a real link. */
  readonly href: string;
  /** Runs on a plain click or Enter instead of following `href`. */
  readonly onActivate: () => void;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "data-passkey-opener"?: string;
};

/**
 * A `UI.Link` that performs an in-page action (open the rename view, cancel
 * a form) while keeping link styling and semantics, as Paper draws these
 * (auth.js `link('Rename', …)`). Modified clicks fall through to the browser.
 */
export function ActionLink(
  { href, onActivate, children, ...rest }: ActionLinkProps,
) {
  return (
    <UI.Link
      {...rest}
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.defaultPrevented || event.button !== 0 || event.metaKey ||
          event.ctrlKey || event.shiftKey || event.altKey
        ) return;
        event.preventDefault();
        onActivate();
      }}
    >
      {children}
    </UI.Link>
  );
}
