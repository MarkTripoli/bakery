import type { FormHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type MessageComposerProps =
  & SemanticNativeProps<FormHTMLAttributes<HTMLFormElement>>
  & {
    /** Send control, usually a primary button. */
    send: ReactNode;
    /** The message field; a native `textarea` supplied by the page. */
    field: ReactNode;
    /** Short line under the box, such as who can read the message. */
    footnote?: ReactNode;
    /** One line next to the send control, such as what the mode does. */
    hint?: ReactNode;
    /** Mode switch shown in the box toolbar. */
    modes?: ReactNode;
    /** Notices announced above the box. */
    notices?: ReactNode;
    state?: "default" | "sending" | "disabled";
  };

/**
 * A bordered message box: the field, then a toolbar with the mode switch, a
 * hint and the send control. Notices sit above it and the footnote under it.
 */
export function MessageComposer(
  { field, footnote, hint, modes, notices, send, state = "default", ...props }:
    MessageComposerProps,
) {
  return (
    <form
      className="ui-message-composer"
      {...props}
      data-state={state}
      data-ui-component="messageComposer"
      data-variant="default"
    >
      {notices
        ? <div className="ui-message-composer__notices">{notices}</div>
        : null}
      <div className="ui-message-composer__box">
        <div className="ui-message-composer__field">{field}</div>
        <div className="ui-message-composer__toolbar">
          {modes}
          {hint
            ? <span className="ui-message-composer__hint">{hint}</span>
            : null}
          <span className="ui-message-composer__action">{send}</span>
        </div>
      </div>
      {footnote
        ? <p className="ui-message-composer__footnote">{footnote}</p>
        : null}
    </form>
  );
}
