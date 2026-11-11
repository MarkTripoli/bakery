import type { ReactNode } from "react";
import "./access-settings.css";

export type AccessSettingsRow = {
  readonly id: string;
  /** Stable hook for the row element (tests, deep links). */
  readonly testId?: string;
  /** Who or what the row is about: a person, an invitee, an account, a client. */
  readonly identity: ReactNode;
  /** Medium weight for named people and accounts, regular for addresses. */
  readonly emphasis?: boolean;
  /** Scope, role, expiry or token prefix cells, in column order. */
  readonly cells?: readonly ReactNode[];
  /**
   * Cells that read as one line with the identity on a phone instead of a
   * second line, and that stay readable to assistive technology when hidden.
   */
  readonly phoneHiddenCells?: readonly number[];
  /** The row's one action: Edit, Cancel or Revoke. */
  readonly action?: ReactNode;
  /** Edit is link-coloured, Cancel and Revoke are destructive. */
  readonly actionTone?: "link" | "destructive";
};

export type AccessSettingsSection = {
  readonly id: string;
  readonly testId?: string;
  readonly title: ReactNode;
  /** Count text after the title that a phone moves to the page summary. */
  readonly titleDetail?: ReactNode;
  /** Right-aligned text on the title line (pending invitations). */
  readonly aside?: ReactNode;
  /** Right-aligned controls on the title line. */
  readonly actions?: ReactNode;
  /** `role` rows carry two cells (scope and resource), `detail` one wide cell. */
  readonly columns?: "role" | "detail";
  /**
   * How a row reads on a phone: `overlay` stacks the cells under the identity
   * and lets the action cover the whole row, `stacked` also puts the action at
   * the end of the second line, `inline` keeps one line with the action at the
   * right.
   */
  readonly phoneLayout?: "overlay" | "stacked" | "inline";
  readonly rows?: readonly AccessSettingsRow[];
  /** Shown instead of rows when there are none. */
  readonly empty?: ReactNode;
  /** A one-time value shown after the rows, such as a new token. */
  readonly callout?: {
    readonly testId?: string;
    readonly text: ReactNode;
    /** Phone copy in place of `text`, read as one line with the value. */
    readonly textShort?: ReactNode;
    readonly value: ReactNode;
    /** Clears the value from the page; needs `dismissLabel`. */
    readonly onDismiss?: () => void;
    readonly dismissLabel?: string;
  };
  /** Forms and notices that belong under the rows. */
  readonly children?: ReactNode;
  /** Forms and notices that belong between the title line and the rows. */
  readonly before?: ReactNode;
};

export type AccessSettingsProps = {
  readonly title: string;
  /** Desktop and tablet subtitle. */
  readonly description?: string;
  /** Phone subtitle in place of the description. */
  readonly summary?: string;
  /** The page action at the right of the heading. */
  readonly actions?: ReactNode;
  /** Drop the page action on a phone, where the state's own action replaces it. */
  readonly hideActionsOnPhone?: boolean;
  /** A page notice under the heading. */
  readonly notice?: ReactNode;
  readonly sections?: readonly AccessSettingsSection[];
  /** Page content that is not a section, such as the empty card. */
  readonly children?: ReactNode;
  /** Stable hook for the page root. */
  readonly "data-testid"?: string;
  /**
   * `loading` shows placeholder rows, `error` a refusal panel and `empty` the
   * first-invite card in place of the sections.
   */
  readonly state?: "default" | "loading" | "error" | "empty";
  /** The copy and action of the `loading`, `error` and `empty` states. */
  readonly status?: {
    readonly testId?: string;
    readonly title?: ReactNode;
    readonly description?: ReactNode;
    /** Phone copy in place of the description. */
    readonly descriptionShort?: ReactNode;
    readonly action?: ReactNode;
    /** Loading label under the placeholder rows. */
    readonly label?: ReactNode;
  };
};

/**
 * Organization access layout (Paper E16 access frames): a heading with the
 * invite action, then sections of one-line rows (who, scope and role,
 * resource, one action) that stack on a phone. Layout only; the page owns the
 * data, the forms and every action.
 */
export function AccessSettings(
  {
    title,
    description,
    summary,
    actions,
    hideActionsOnPhone,
    notice,
    sections = [],
    children,
    "data-testid": testId,
    state = "default",
    status,
  }: AccessSettingsProps,
) {
  return (
    <div
      className="ui-access-settings"
      data-state={state}
      data-testid={testId}
      data-variant="default"
      data-ui-component="accessSettings"
    >
      <div className="ui-access-settings__header">
        <div className="ui-access-settings__heading">
          <h1>{title}</h1>
          {description
            ? <p className="ui-access-settings__description">{description}</p>
            : null}
          {summary
            ? <p className="ui-access-settings__summary">{summary}</p>
            : null}
        </div>
        {actions
          ? (
            <div
              className="ui-access-settings__actions"
              data-phone-hidden={hideActionsOnPhone ? "true" : undefined}
            >
              {actions}
            </div>
          )
          : null}
      </div>
      {notice}
      {state === "loading"
        ? (
          <div
            className="ui-access-settings__loading"
            data-testid={status?.testId}
            role="status"
          >
            <span
              aria-hidden="true"
              className="ui-access-settings__skeleton-line"
            />
            <div aria-hidden="true" className="ui-access-settings__skeleton">
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>{status?.label}</p>
          </div>
        )
        : null}
      {state === "error"
        ? (
          <div
            className="ui-access-settings__panel"
            data-testid={status?.testId}
            data-tone="error"
            role="alert"
          >
            <div className="ui-access-settings__panel-copy">
              <h2>{status?.title}</h2>
              <p data-short={status?.descriptionShort ? "false" : undefined}>
                {status?.description}
              </p>
              {status?.descriptionShort
                ? <p data-short="true">{status.descriptionShort}</p>
                : null}
            </div>
            {status?.action}
          </div>
        )
        : null}
      {state === "empty"
        ? (
          <div
            className="ui-access-settings__panel"
            data-testid={status?.testId}
            data-tone="empty"
          >
            <div className="ui-access-settings__panel-copy">
              <h2>{status?.title}</h2>
              <p data-short={status?.descriptionShort ? "false" : undefined}>
                {status?.description}
              </p>
              {status?.descriptionShort
                ? <p data-short="true">{status.descriptionShort}</p>
                : null}
            </div>
            {status?.action}
          </div>
        )
        : null}
      {children}
      {(state === "default" ? sections : []).map((section) => (
        <section
          aria-labelledby={`${section.id}-title`}
          className="ui-access-settings__section"
          key={section.id}
        >
          <div className="ui-access-settings__section-head">
            <h2 id={`${section.id}-title`}>
              {section.title}
              {section.titleDetail
                ? (
                  <span className="ui-access-settings__title-detail">
                    {" "}
                    {section.titleDetail}
                  </span>
                )
                : null}
            </h2>
            {section.aside
              ? (
                <span className="ui-access-settings__aside">
                  {section.aside}
                </span>
              )
              : null}
            {section.actions
              ? (
                <div className="ui-access-settings__section-actions">
                  {section.actions}
                </div>
              )
              : null}
          </div>
          {section.before}
          {section.rows && section.rows.length > 0
            ? (
              <ul
                className="ui-access-settings__rows"
                data-columns={section.columns ?? "role"}
                data-callout={section.callout ? "true" : undefined}
                data-phone={section.phoneLayout ?? "stacked"}
                data-testid={section.testId}
              >
                {section.rows.map((row) => (
                  <li
                    className="ui-access-settings__row"
                    data-testid={row.testId}
                    key={row.id}
                  >
                    <div
                      className="ui-access-settings__identity"
                      data-emphasis={row.emphasis ? "true" : undefined}
                    >
                      {row.identity}
                    </div>
                    {(row.cells ?? []).map((cell, index) => (
                      <div
                        className="ui-access-settings__cell"
                        data-phone-hidden={row.phoneHiddenCells?.includes(index)
                          ? "true"
                          : undefined}
                        key={index}
                      >
                        {cell}
                      </div>
                    ))}
                    {row.action
                      ? (
                        <div
                          className="ui-access-settings__action"
                          data-tone={row.actionTone ?? "link"}
                        >
                          {row.action}
                        </div>
                      )
                      : null}
                  </li>
                ))}
              </ul>
            )
            : section.empty
            ? (
              <div
                className="ui-access-settings__empty"
                data-testid={section.testId}
              >
                {section.empty}
              </div>
            )
            : null}
          {section.callout
            ? (
              <div
                className="ui-access-settings__callout"
                data-testid={section.callout.testId}
                role="status"
              >
                <span
                  data-short={section.callout.textShort ? "false" : undefined}
                >
                  {section.callout.text}
                </span>
                {section.callout.textShort
                  ? <span data-short="true">{section.callout.textShort}</span>
                  : null}
                <code>{section.callout.value}</code>
                {section.callout.onDismiss
                  ? (
                    <button
                      aria-label={section.callout.dismissLabel}
                      className="ui-access-settings__dismiss"
                      onClick={section.callout.onDismiss}
                      type="button"
                    >
                      ×
                    </button>
                  )
                  : null}
              </div>
            )
            : null}
          {section.children}
        </section>
      ))}
    </div>
  );
}
