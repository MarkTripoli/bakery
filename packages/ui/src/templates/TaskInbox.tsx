import { type HTMLAttributes, type ReactNode, useId } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Menu } from "../molecules/Menu.tsx";
import { Popover } from "../molecules/Popover.tsx";
import { Tabs } from "../molecules/Tabs.tsx";
import "../collaboration.css";

export type TaskInboxState =
  | "loading"
  | "empty"
  | "ready"
  | "error"
  | "forbidden"
  | "offline"
  | "reconnecting";

export type TaskInboxView = {
  id: string;
  label: string;
};

export type TaskInboxProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    action?: ReactNode;
    children?: ReactNode;
    cursorControls?: ReactNode;
    description?: ReactNode;
    filters?: ReactNode;
    filtersLabel: string;
    /** Selected-task inspector, rendered beside the queue on wide layouts. */
    inspector?: ReactNode;
    /** Show at most this many view tabs; the rest open from a chevron menu. */
    maxVisibleViews?: number;
    /** Accessible name of the overflow views menu. */
    moreViewsLabel?: string;
    onSelectView?: (id: string) => void;
    resultSummary?: ReactNode;
    selectedView?: string;
    state?: TaskInboxState;
    stateContent?: ReactNode;
    title: ReactNode;
    variant?: "queue" | "sheet";
    /** Status views shown as tabs; the selected view's panel holds the queue. */
    views?: readonly TaskInboxView[];
    viewsLabel?: string;
  };

/**
 * Route-independent task queue layout. Callers own filtering, cursor state,
 * authorization, navigation, and all data operations.
 */
export function TaskInbox({
  action,
  children,
  cursorControls,
  description,
  filters,
  filtersLabel,
  inspector,
  maxVisibleViews,
  moreViewsLabel,
  onSelectView,
  resultSummary,
  selectedView,
  state = "ready",
  stateContent,
  title,
  variant = "queue",
  views,
  viewsLabel,
  ...props
}: TaskInboxProps) {
  const headingId = useId();
  const retainsResults = state === "ready" || state === "offline" ||
    state === "reconnecting";
  const announcesState = state === "error" || state === "forbidden" ||
    state === "offline";

  const body = (
    <>
      {filters
        ? (
          <div
            aria-label={filtersLabel}
            className="ui-task-inbox__filters"
            role="group"
          >
            {filters}
          </div>
        )
        : null}

      {stateContent
        ? (
          <div
            aria-atomic={announcesState || undefined}
            aria-live={announcesState ? "polite" : undefined}
            className="ui-task-inbox__state"
          >
            {stateContent}
          </div>
        )
        : null}

      {retainsResults && children
        ? <div className="ui-task-inbox__results">{children}</div>
        : null}

      {cursorControls
        ? <div className="ui-task-inbox__cursor">{cursorControls}</div>
        : null}
    </>
  );

  return (
    <section
      aria-busy={state === "loading" || state === "reconnecting" || undefined}
      aria-labelledby={headingId}
      className={`ui-task-inbox ui-task-inbox--${variant}`}
      {...props}
      data-state={state}
      data-variant={variant}
      data-ui-component="taskInbox"
    >
      <div className="ui-task-inbox__work">
        <header className="ui-task-inbox__header">
          <div>
            <h1 id={headingId}>{title}</h1>
            {description
              ? <div className="ui-task-inbox__description">{description}</div>
              : null}
          </div>
          {resultSummary
            ? (
              <div className="ui-task-inbox__summary" role="status">
                {resultSummary}
              </div>
            )
            : null}
          {action
            ? <div className="ui-task-inbox__action">{action}</div>
            : null}
        </header>

        {views && views.length > 0 && onSelectView
          ? (
            <ViewTabs
              body={body}
              label={viewsLabel ?? filtersLabel}
              maxVisible={maxVisibleViews}
              moreLabel={moreViewsLabel ?? viewsLabel ?? filtersLabel}
              onSelect={onSelectView}
              selected={selectedView ?? views[0]!.id}
              views={views}
            />
          )
          : body}
      </div>
      {inspector
        ? <aside className="ui-task-inbox__inspector">{inspector}</aside>
        : null}
    </section>
  );
}

function ViewTabs(
  { body, label, maxVisible, moreLabel, onSelect, selected, views }: {
    body: ReactNode;
    label: string;
    maxVisible?: number;
    moreLabel: string;
    onSelect: (id: string) => void;
    selected: string;
    views: readonly TaskInboxView[];
  },
) {
  const limit = Math.max(1, maxVisible ?? views.length);
  // The selected view always keeps a tab, so the panel stays labelled: it
  // replaces the last visible slot when it would otherwise overflow.
  const leading = views.slice(0, limit);
  const current = views.find((view) => view.id === selected);
  const shown = current && !leading.includes(current)
    ? [...leading.slice(0, limit - 1), current]
    : leading;
  const hidden = views.filter((view) => !shown.includes(view));
  return (
    <Tabs
      aria-label={label}
      onSelect={onSelect}
      selectedId={selected}
      tabs={shown.map((view) => ({ ...view, content: body }))}
      trailing={hidden.length > 0
        ? (
          <Popover
            label={moreLabel}
            trigger={
              <>
                <IconGlyph name="chevron-down" size="small" />
                <span className="ui-task-inbox__more-label">{moreLabel}</span>
              </>
            }
            variant="interactive"
          >
            <Menu
              aria-label={moreLabel}
              items={hidden.map((view) => ({ id: view.id, label: view.label }))}
              onSelect={onSelect}
              variant="selection"
            />
          </Popover>
        )
        : undefined}
      variant="view"
    />
  );
}
