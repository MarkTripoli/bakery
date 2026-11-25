import type { ReactNode, Ref } from "react";
import { Text } from "../atoms/Text.tsx";
import { InlineNotice } from "./InlineNotice.tsx";
import "../feedback.css";

type SetupReason = Readonly<{ id: string; content: ReactNode }>;

export type TaskSetupNoticeProps = Readonly<{
  id?: string;
  heading: ReactNode;
  reasons: readonly SetupReason[];
  nextStep?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}>;

export function TaskSetupNotice(
  { id, heading, reasons, nextStep, ref }: TaskSetupNoticeProps,
) {
  return (
    <div data-ui-component="taskSetupNotice" data-variant="warning">
      <InlineNotice id={id} ref={ref} role="none" tabIndex={-1} tone="warning">
        <div className="ui-task-setup-notice__content">
          <Text variant="strong">{heading}</Text>
          {reasons.length === 1
            ? <Text data-reason={reasons[0].id}>{reasons[0].content}</Text>
            : (
              <ul className="ui-task-setup-notice__reasons">
                {reasons.map((reason) => (
                  <li data-reason={reason.id} key={reason.id}>
                    {reason.content}
                  </li>
                ))}
              </ul>
            )}
          {nextStep ? <Text>{nextStep}</Text> : null}
        </div>
      </InlineNotice>
    </div>
  );
}
