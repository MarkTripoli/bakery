import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type TaskDetailProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    aside?: ReactNode;
    /** Session layout: pane title row above `aside` (icon, label, action). */
    asideHeader?: ReactNode;
    children: ReactNode;
    /** Session layout: bottom-of-transcript slot (composer or run controls). */
    composer?: ReactNode;
    /**
     * `session` is the Paper HU-0 two-column task session: transcript column
     * plus a bordered side pane. `document` keeps the stacked detail layout.
     * `conversation` is the Paper p-18-0 shared conversation: title and
     * subtitle, a stage strip, a scrolling transcript and a pinned composer.
     */
    layout?: "document" | "session" | "conversation";
    headingSummary?: {
      readonly description: string;
      readonly reference?: string;
      readonly status: string;
    };
    meta?: ReactNode;
    presence?: ReactNode;
    /** Conversation layout, phone: back control before the title. */
    leading?: ReactNode;
    /** Conversation layout: stage strip under the title block. */
    stages?: ReactNode;
    /** Conversation layout: one muted line under the title. */
    subtitle?: ReactNode;
    state?: "loading" | "ready" | "reconnecting" | "error" | "forbidden";
    title: ReactNode;
    variant?: "sheet" | "pane" | "rail";
  };

/** Route-independent layout for a task's header, content, and supporting detail. */
export function TaskDetail(
  {
    actions,
    aside,
    asideHeader,
    children,
    composer,
    layout = "document",
    headingSummary,
    leading,
    meta,
    presence,
    stages,
    state = "ready",
    subtitle,
    title,
    variant = "rail",
    ...props
  }: TaskDetailProps,
) {
  return (
    <article
      aria-busy={state === "loading" || state === "reconnecting" || undefined}
      className={`ui-task-detail ui-task-detail--${variant} ui-task-detail--${layout}`}
      aria-atomic={state === "error" || state === "forbidden"
        ? "true"
        : undefined}
      aria-live={state === "error" || state === "forbidden"
        ? "polite"
        : undefined}
      {...props}
      data-state={state}
      data-variant={variant}
      data-ui-component="taskDetail"
    >
      {layout === "conversation"
        ? (
          <div className="ui-task-detail__main">
            <header>
              {leading
                ? <div className="ui-task-detail__leading">{leading}</div>
                : null}
              <div className="ui-task-detail__titles">
                <h1>{title}</h1>
                {subtitle
                  ? <p className="ui-task-detail__subtitle">{subtitle}</p>
                  : null}
              </div>
            </header>
            {stages
              ? <div className="ui-task-detail__stages">{stages}</div>
              : null}
            <div className="ui-task-detail__transcript" tabIndex={0}>
              {children}
            </div>
            {composer
              ? <div className="ui-task-detail__composer">{composer}</div>
              : null}
          </div>
        )
        : layout === "session"
        ? (
          <>
            <div className="ui-task-detail__main">
              <header>
                {headingSummary
                  ? (
                    <div className="ui-task-detail__heading-summary">
                      <div className="ui-task-detail__heading-row">
                        {headingSummary.reference && (
                          <span className="ui-task-detail__reference">
                            {headingSummary.reference}
                          </span>
                        )}
                        <span className="ui-task-detail__run-status">
                          {headingSummary.status}
                        </span>
                      </div>
                      <h1>{title}</h1>
                      <p className="ui-task-detail__description">
                        {headingSummary.description}
                      </p>
                    </div>
                  )
                  : <h1>{title}</h1>}
                {meta || presence || actions
                  ? (
                    <div className="ui-task-detail__meta">
                      <div>{meta}</div>
                      {presence ? <div>{presence}</div> : null}
                      {actions
                        ? (
                          <div className="ui-task-detail__actions">
                            {actions}
                          </div>
                        )
                        : null}
                    </div>
                  )
                  : null}
              </header>
              <div className="ui-task-detail__transcript">{children}</div>
              {composer
                ? <div className="ui-task-detail__composer">{composer}</div>
                : null}
            </div>
            {aside
              ? (
                <aside className="ui-task-detail__pane">
                  {asideHeader
                    ? (
                      <div className="ui-task-detail__pane-header">
                        {asideHeader}
                      </div>
                    )
                    : null}
                  <div className="ui-task-detail__pane-body">{aside}</div>
                </aside>
              )
              : null}
          </>
        )
        : (
          <>
            <header>
              <h1>{title}</h1>
              {actions
                ? <div className="ui-task-detail__actions">{actions}</div>
                : null}
            </header>
            <div className="ui-task-detail__layout">
              <div className="ui-task-detail__content">{children}</div>
              {aside ? <aside>{aside}</aside> : null}
            </div>
          </>
        )}
    </article>
  );
}
