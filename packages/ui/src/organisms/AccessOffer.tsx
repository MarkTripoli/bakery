import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type AccessOfferProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "children">>
  & {
    /** The question, such as "Ana Ruiz can't see this document. Give them access?". */
    question: ReactNode;
    /** What the people would be able to do, and that nothing else is shared. */
    detail: ReactNode;
    /**
     * One more line under what they get, such as how to leave someone out when
     * the offer is for several people. The chips above the offer are the only
     * list of names, so the offer never lists them again.
     */
    caption?: ReactNode;
    /** The words and action of "Don't mention {name}", for a single person. */
    decline?: { label: string; onDecline: () => void };
    /** A control that belongs in the block, such as the access level select for a document. */
    control?: ReactNode;
    /** `busy` while the send that gives the access is under way: the block is read-only. */
    state?: "default" | "busy";
  };

/**
 * The block under "Will be notified" that offers access to a mentioned person
 * who has none (design-ux #73 revision 3): the question, what they get, and the
 * way out. It never moves the draft or the caret. The yes is the send button
 * itself, so there is no second confirm here; the no removes the mention.
 */
export function AccessOffer(
  { caption, control, decline, detail, question, state = "default", ...props }:
    AccessOfferProps,
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
      <p className="ui-access-offer__detail">{detail}</p>
      {caption ? <p className="ui-access-offer__detail">{caption}</p> : null}
      {control}
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
