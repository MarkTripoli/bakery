import type { ReactNode } from "react";
import { Dialog } from "../molecules/Dialog.tsx";
import "../artifacts.css";

export type SendToAgentDialogProps = {
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dismissLabel: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly state?: "open" | "submitting" | "error";
};
export function SendToAgentDialog(
  { description, children, actions, state = "open", ...props }:
    SendToAgentDialogProps,
) {
  return (
    <Dialog
      {...props}
      state={state}
      variant="form"
      onClose={(event) => event.stopPropagation()}
      onCancel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="ui-send-to-agent-dialog"
        hidden={!props.open}
        data-ui-component="sendToAgentDialog"
        data-variant="form"
        data-state={props.open ? state : "closed"}
      >
        <p>{description}</p>
        {children}
        <div className="ui-artifact-actions">{actions}</div>
      </div>
    </Dialog>
  );
}
