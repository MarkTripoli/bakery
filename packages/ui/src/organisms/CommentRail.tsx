import { type ReactNode, useId } from "react";
import "../artifacts.css";

export type CommentRailProps = {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly state?: "ready" | "empty" | "loading" | "error";
};
export function CommentRail(
  { title, children, actions, state = "ready" }: CommentRailProps,
) {
  const titleId = useId();
  return (
    <aside
      className="ui-comment-rail"
      aria-labelledby={titleId}
      aria-busy={state === "loading" || undefined}
      data-ui-component="commentRail"
      data-variant="rail"
      data-state={state}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      {actions ? <div className="ui-artifact-actions">{actions}</div> : null}
    </aside>
  );
}
