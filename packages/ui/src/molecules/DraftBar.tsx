import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type DraftBarProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** What is pending, for example "2 unpublished changes". Announced politely when it changes. */
    summary: ReactNode;
    /** One quieter line under the summary, for example what the draft is based on. */
    detail?: ReactNode;
    /** The way out of the draft, such as Discard. Rendered first. */
    secondaryAction?: ReactNode;
    /** The next step for the draft, such as Review and publish. */
    primaryAction: ReactNode;
  };

/**
 * The strip that stays at the bottom of a page while a person has edits that
 * are not applied yet: a summary on the start side, the way out and the next
 * step on the end side. On a narrow screen the summary sits over two equal
 * actions. Only the summary is a live region; the actions are not announced
 * when the count changes.
 */
export function DraftBar(
  { detail, primaryAction, secondaryAction, summary, ...props }: DraftBarProps,
) {
  return (
    <div
      className="ui-draft-bar"
      {...props}
      data-state="default"
      data-ui-component="draftBar"
      data-variant="default"
    >
      <div aria-live="polite" className="ui-draft-bar__text" role="status">
        <span className="ui-draft-bar__summary">{summary}</span>
        {detail ? <span className="ui-draft-bar__detail">{detail}</span> : null}
      </div>
      <div className="ui-draft-bar__actions">
        {secondaryAction}
        {primaryAction}
      </div>
    </div>
  );
}
