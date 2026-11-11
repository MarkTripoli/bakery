import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { ShellFlushMain, ShellSlot } from "../shell/shell-slots.tsx";

export type TaskSessionMessage = {
  id: string;
  author: string;
  body: string;
  time?: string;
  variant?: "person" | "agent" | "system";
};

export type TaskSessionViewProps = {
  /** Top-bar trail, e.g. application / task reference (HU-0). */
  breadcrumbs?: readonly { label: string; href?: string }[];
  /** Top-bar trailing status and actions (HU-0 "Planning", "Preview"). */
  actions?: ReactNode;
  composer?: ReactNode;
  runHeading?: {
    readonly description: string;
    readonly reference?: string;
    readonly status: string;
  };
  meta?: ReactNode;
  messages: readonly TaskSessionMessage[];
  /** Transcript content after the messages (artifacts, notices, states). */
  children?: ReactNode;
  pane?: {
    action?: ReactNode;
    body: ReactNode;
    /** Pane actions pinned to the bottom (HU-0 footer row). */
    footer?: ReactNode;
    summary?: { title: ReactNode; meta?: ReactNode };
    icon: UI.IconGlyphName;
    title: string;
  };
  /**
   * A ready-made `SessionPane` (for example `ArtifactPane`) for the wide
   * inspector slot, used instead of `pane`.
   */
  aside?: ReactNode;
  asidePlacement?: "rail" | "inline";
  presence?: ReactNode;
  /**
   * `sheet` (phones) stacks the pane under the conversation so run state and
   * controls stay reachable without a hidden tab (UI-CONTRACT: no core
   * functionality hidden on mobile).
   */
  layout?: "rail" | "sheet";
  state: NonNullable<UI.TaskDetailProps["state"]>;
  title: string;
};

/** Presentational task session shared by `/tasks/$taskId` and its fixture. */
export function TaskSessionView(
  {
    actions,
    aside,
    asidePlacement = "rail",
    breadcrumbs,
    children,
    composer,
    layout = "rail",
    messages,
    runHeading,
    meta,
    pane,
    presence,
    state,
    title,
  }: TaskSessionViewProps,
) {
  const sheet = layout === "sheet";
  const inlineAside = sheet || asidePlacement === "inline";
  const paneElement = aside ?? (pane && (
    <UI.SessionPane
      label={pane.title}
      header={
        <>
          <UI.IconGlyph name={pane.icon} />
          <UI.Text>{pane.title}</UI.Text>
          {pane.action}
        </>
      }
      footer={pane.footer}
      title={pane.summary?.title}
      meta={pane.summary?.meta}
    >
      {pane.body}
    </UI.SessionPane>
  ));
  const transcript = (
    <>
      {messages.map((message) => (
        <UI.ConversationMessage
          author={message.author}
          key={message.id}
          timestamp={message.time}
          variant={message.variant}
        >
          {message.body}
        </UI.ConversationMessage>
      ))}
      {children}
    </>
  );
  return (
    <>
      <ShellFlushMain />
      {breadcrumbs && (
        <ShellSlot name="breadcrumbs">
          <UI.Breadcrumbs items={[...breadcrumbs]} />
        </ShellSlot>
      )}
      {actions && <ShellSlot name="actions">{actions}</ShellSlot>}
      {paneElement && !inlineAside && (
        <ShellSlot name="inspector" size="wide">{paneElement}</ShellSlot>
      )}
      <UI.TaskDetail
        layout="session"
        title={title}
        headingSummary={runHeading}
        state={state}
        meta={meta}
        presence={presence}
        composer={composer}
        variant={sheet ? "sheet" : "rail"}
      >
        {transcript}
        {inlineAside && paneElement}
      </UI.TaskDetail>
    </>
  );
}
