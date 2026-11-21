import {
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
} from "react";
import { Button } from "../atoms/Button.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
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
    /**
     * This is the suggestion the person chose, so the text it would change is
     * in view. Only one card of a list is selected.
     */
    selected?: boolean;
    /** Choose this card; the whole card is the target, its buttons keep their own. */
    onSelect?: () => void;
    /** "Suggested by the agent". */
    heading: ReactNode;
    /** What it does, in one sentence. */
    summary: ReactNode;
    /** Where it came from ("From “shorten this”, asked by Ana · 5 min ago"). */
    origin: ReactNode;
    /** The sentence for `outdated` or `unknown`; not shown otherwise. */
    message?: ReactNode;
    /** What went wrong deciding this card, said inside it ("could not be accepted"). */
    error?: ReactNode;
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
    error,
    heading,
    message,
    onAccept,
    onCheckAgain,
    onReject,
    onSelect,
    origin,
    rejectLabel,
    selected = false,
    state = "default",
    summary,
    ...props
  }: SuggestionCardProps,
) {
  const busy = state === "working";
  const headingId = useId();
  const summaryId = useId();
  // A click on a button inside the card is that button's, not a selection.
  const select = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target as HTMLElement).closest("button")) onSelect?.();
  };
  const selectByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.();
    }
  };
  return (
    <article
      aria-current={selected ? "true" : undefined}
      aria-labelledby={`${headingId} ${summaryId}`}
      className="ui-suggestion-card"
      onClick={onSelect ? select : undefined}
      onKeyDown={onSelect ? selectByKey : undefined}
      tabIndex={onSelect ? 0 : undefined}
      {...props}
      data-state={state}
      data-ui-component="suggestionCard"
      data-variant={selected ? "selected" : "default"}
    >
      <h3 className="ui-suggestion-card__heading" id={headingId}>{heading}</h3>
      <div className="ui-suggestion-card__summary" id={summaryId}>
        {summary}
      </div>
      <p className="ui-suggestion-card__origin">{origin}</p>
      {state === "outdated" || state === "unknown"
        ? (
          <p className="ui-suggestion-card__message" role="status">
            <IconGlyph name="caution" size="small" />
            <span>{message}</span>
          </p>
        )
        : null}
      {error
        ? (
          <p
            className="ui-suggestion-card__message"
            data-tone="error"
            role="alert"
          >
            <IconGlyph name="caution" size="small" />
            <span>{error}</span>
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
