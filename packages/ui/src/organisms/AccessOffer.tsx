import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type AccessOfferAction = {
  /** The button's words: what it does, such as "Ask Dana Lee" or "Undo access". */
  readonly label: string;
  readonly onClick: () => void;
};

export type AccessOfferProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "children">>
  & {
    /** The question or the result, such as "Ana Ruiz can't see this document. Give them access?". */
    question: ReactNode;
    /** What the people would be able to do, or what to do next; left out when the question says it all. */
    detail?: ReactNode;
    /**
     * One more line under what they get, such as how to leave someone out when
     * the offer is for several people. The chips above the offer are the only
     * list of names, so the offer never lists them again.
     */
    caption?: ReactNode;
    /** The words and action of "Don't mention {name}", for a single person. */
    decline?: { label: string; onDecline: () => void };
    /**
     * Buttons that act on the block's own subject, such as "Ask Dana Lee" for a
     * writer who may not share, or "Undo access" after the send. They are
     * read-only while the block is busy.
     */
    actions?: readonly AccessOfferAction[];
    /** A control that belongs in the block, such as the access level select for a document. */
    control?: ReactNode;
    /** `busy` while the send that gives the access is under way: the block is read-only. */
    state?: "default" | "busy";
  };

/**
 * The block under "Will be notified" that offers access to a mentioned person
 * who has none (design-ux #73 revision 3): the question, what they get, and the
 * way out. It never moves the draft or the caret. The yes is the send button
 * itself, so there is no second confirm here; the no removes the mention. The
 * same block says who can be asked when the writer may not share, and what
 * happened after the send, with its Undo.
 */
export function AccessOffer(
  {
    actions,
    caption,
    control,
    decline,
    detail,
    question,
    state = "default",
    ...props
  }: AccessOfferProps,
) {
  return (
    <div
      className="ui-access-offer"
      role="status"
      {...props}
      aria-busy={state === "busy" || undefined}
      data-state={state}
      data-ui-component="accessOffer"
      data-variant="default"
    >
      <p className="ui-access-offer__question">{question}</p>
      {detail ? <p className="ui-access-offer__detail">{detail}</p> : null}
      {caption ? <p className="ui-access-offer__detail">{caption}</p> : null}
      {control}
      {actions !== undefined && actions.length > 0
        ? (
          <div className="ui-access-offer__actions">
            {actions.map((action) => (
              <Button
                disabled={state === "busy"}
                key={action.label}
                onClick={action.onClick}
                type="button"
                variant="secondary"
              >
                {action.label}
              </Button>
            ))}
          </div>
        )
        : null}
      {decline !== undefined
        ? (
          <Button
            disabled={state === "busy"}
            onClick={decline.onDecline}
            type="button"
            variant="text"
          >
            {decline.label}
          </Button>
        )
        : null}
    </div>
  );
}
