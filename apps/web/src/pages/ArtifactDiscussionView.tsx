import type { ComponentProps, ReactNode, Ref } from "react";
import * as UI from "@bakery/ui";

export type ArtifactDiscussionViewProps =
  & Omit<ComponentProps<typeof UI.ArtifactDiscussion>, "actions" | "composer">
  & {
    readonly replyAction: {
      readonly label: string;
      readonly onClick: () => void;
      readonly disabled?: boolean;
      /** True while this thread's reply composer is open; pressing closes it. */
      readonly pressed?: boolean;
    };
    readonly resolveAction?: {
      readonly label: string;
      readonly onClick: () => void;
      readonly disabled?: boolean;
    };
    readonly additionalActions?: ReactNode;
    readonly composer?: ArtifactCommentComposerModel;
  };

export function ArtifactDiscussionView(
  { replyAction, resolveAction, additionalActions, composer, ...thread }:
    ArtifactDiscussionViewProps,
) {
  return (
    <UI.ArtifactDiscussion
      {...thread}
      actions={
        <>
          <UI.Button
            variant="outline"
            disabled={replyAction.disabled}
            aria-pressed={replyAction.pressed}
            onClick={replyAction.onClick}
          >
            {replyAction.label}
          </UI.Button>
          {resolveAction
            ? (
              <UI.Button
                variant="outline"
                disabled={resolveAction.disabled}
                onClick={resolveAction.onClick}
              >
                {resolveAction.label}
              </UI.Button>
            )
            : null}
          {additionalActions}
        </>
      }
      composer={composer
        ? <ArtifactCommentComposerView {...composer} />
        : undefined}
    />
  );
}

export type ArtifactCommentComposerModel = {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly agentAction: ReactNode;
  readonly mode:
    | { readonly kind: "comment"; readonly anchor: ReactNode }
    | {
      readonly kind: "reply";
      /** Escape in the field, or pressing Reply again, leaves reply mode. */
      readonly onCancel: () => void;
    };
};

export function ArtifactCommentComposerView(
  composer: ArtifactCommentComposerModel,
) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        composer.onSubmit();
      }}
    >
      <textarea
        id={composer.id}
        ref={composer.inputRef}
        aria-label={composer.label}
        placeholder={composer.placeholder}
        value={composer.value}
        onChange={(event) => composer.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && composer.mode.kind === "reply") {
            event.preventDefault();
            composer.mode.onCancel();
          }
        }}
      />
      {composer.mode.kind === "comment" ? composer.mode.anchor : null}
      <UI.Inline>
        <UI.Button type="submit" disabled={composer.disabled}>
          {composer.submitLabel}
        </UI.Button>
        {composer.agentAction}
      </UI.Inline>
    </form>
  );
}

export function ArtifactAgentControlView(
  { label, disabled, onOpen, unavailable, sent, dialog }: {
    readonly label: string;
    readonly disabled: boolean;
    readonly onOpen: () => void;
    readonly unavailable?: string;
    readonly sent?: string;
    readonly dialog: ReactNode;
  },
) {
  return (
    <>
      <UI.Button variant="outline" disabled={disabled} onClick={onOpen}>
        {label}
      </UI.Button>
      {unavailable ? <UI.Text variant="caption">{unavailable}</UI.Text> : null}
      {sent ? <UI.InlineNotice tone="success">{sent}</UI.InlineNotice> : null}
      {dialog}
    </>
  );
}

export type ArtifactAgentDialogViewProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly dismissLabel: string;
  readonly context: string;
  readonly submit: {
    readonly label: string;
    readonly onClick: () => void;
    readonly disabled?: boolean;
  };
  readonly cancel: { readonly label: string; readonly onClick: () => void };
  readonly message: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
  };
  readonly failure?: string;
  readonly reload?: { readonly label: string; readonly onClick: () => void };
};

export function ArtifactAgentDialogView(props: ArtifactAgentDialogViewProps) {
  return (
    <UI.SendToAgentDialog
      title={props.title}
      description={props.description}
      open={props.open}
      onOpenChange={props.onOpenChange}
      dismissLabel={props.dismissLabel}
      actions={
        <>
          <UI.Button variant="outline" onClick={props.cancel.onClick}>
            {props.cancel.label}
          </UI.Button>
          <UI.Button
            onClick={props.submit.onClick}
            disabled={props.submit.disabled}
          >
            {props.submit.label}
          </UI.Button>
        </>
      }
    >
      <UI.CodeBlock code={props.context} />
      <UI.Field htmlFor={props.message.id} label={props.message.label}>
        <textarea
          id={props.message.id}
          value={props.message.value}
          onChange={(event) =>
            props.message.onChange(event.currentTarget.value)}
        />
      </UI.Field>
      {props.failure
        ? <UI.InlineNotice tone="error">{props.failure}</UI.InlineNotice>
        : null}
      {props.reload
        ? (
          <UI.Button variant="secondary" onClick={props.reload.onClick}>
            {props.reload.label}
          </UI.Button>
        )
        : null}
    </UI.SendToAgentDialog>
  );
}
