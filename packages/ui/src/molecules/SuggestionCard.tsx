import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

/**
 * `default`: it can be accepted or rejected. `outdated`: the text under it
 * changed, so only Reject is offered. `unknown`: whether it was applied is
 * not known, so Check again is offered and it is never shown as accepted.
 * `working`: an answer is in flight.
 */
export type SuggestionCardState =
  | "default"
  | "outdated"
  | "unknown"
  | "working";

export type SuggestionCardProps =
  & Omit<
    SemanticNativeProps<
      Omit<HTMLAttributes<HTMLElement>, "title" | "children">
    >,
    "role"
  >
  & {
    state?: SuggestionCardState;
    /** "Suggested by the agent". */
    heading: ReactNode;
    /** What it does, in one sentence. */
    summary: ReactNode;
    /** Where it came from ("From “shorten this”, asked by Ana · 5 min ago"). */
    origin: ReactNode;
    /** The sentence for `outdated` or `unknown`; not shown otherwise. */
    message?: ReactNode;
    acceptLabel: string;
    rejectLabel: string;
    checkAgainLabel: string;
    onAccept?: () => void;
    onReject?: () => void;
    onCheckAgain?: () => void;
  };

/**
 * One suggestion from an agent, beside the text it would change. The agent
 * never changes the shared text itself: a person accepts it, which applies it
 * as their own ordinary edit.
 */
export function SuggestionCard(
  {
    acceptLabel,
    checkAgainLabel,
    heading,
    message,
    onAccept,
    onCheckAgain,
    onReject,
    origin,
    rejectLabel,
    state = "default",
    summary,
    ...props
  }: SuggestionCardProps,
) {
  const busy = state === "working";
  return (
    <article
      className="ui-suggestion-card"
      {...props}
      data-state={state}
      data-ui-component="suggestionCard"
      data-variant="default"
    >
      <h3 className="ui-suggestion-card__heading">{heading}</h3>
      <p className="ui-suggestion-card__summary">{summary}</p>
      <p className="ui-suggestion-card__origin">{origin}</p>
      {state === "outdated" || state === "unknown"
        ? (
          <p className="ui-suggestion-card__message" role="status">
            {message}
          </p>
        )
        : null}
      <div className="ui-suggestion-card__actions">
        {state === "default" || state === "working"
          ? (
            <Button
              disabled={busy}
              loading={busy}
              onClick={onAccept}
              variant="primary"
            >
              {acceptLabel}
            </Button>
          )
          : null}
        {state === "unknown"
          ? (
            <Button onClick={onCheckAgain} variant="secondary">
              {checkAgainLabel}
            </Button>
          )
          : null}
        <Button
          disabled={busy}
          onClick={onReject}
          variant="secondary"
        >
          {rejectLabel}
        </Button>
      </div>
    </article>
  );
}
