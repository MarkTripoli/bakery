import type { ReactNode } from "react";
import "./sso-settings.css";

export type SsoProviderEntry = {
  readonly id: string;
  /** Provider name and protocol, e.g. "Okta · OIDC". */
  readonly name: string;
  /** Issuer URL or domain under the name. */
  readonly detail: string;
  /** The verified / not verified badge. */
  readonly status: ReactNode;
  /** An action beside the badge, such as an Edit button. */
  readonly action?: ReactNode;
  /** Opens the provider for editing. */
  readonly onSelect: () => void;
};

export type SsoSettingsProps = {
  readonly title: string;
  readonly description?: string;
  /** Add actions at the right of the heading (list only). */
  readonly actions?: ReactNode;
  /** A page notice under the heading. */
  readonly notice?: ReactNode;
  /** `list` shows providers, domain verification and enforcement; `form` wraps an add or edit form. */
  readonly variant?: "list" | "form";
  readonly providers?: readonly SsoProviderEntry[];
  readonly providersLabel?: string;
  readonly emptyMessage?: string;
  /** Domain verification section content (list). */
  readonly domain?: ReactNode;
  /** The require-SSO control (list). */
  readonly enforcement?: ReactNode;
  /** The form body (form). */
  readonly children?: ReactNode;
};

/**
 * Single sign-on settings (Paper E16 mocks): heading with add actions, the
 * provider rows, the domain-verification record and the require-SSO card, or
 * the in-page provider form. Layout only; the page owns data and actions.
 */
export function SsoSettings(
  {
    title,
    description,
    actions,
    notice,
    variant = "list",
    providers = [],
    providersLabel,
    emptyMessage,
    domain,
    enforcement,
    children,
  }: SsoSettingsProps,
) {
  return (
    <div
      className="ui-sso-settings"
      data-state="default"
      data-ui-component="ssoSettings"
      data-variant={variant}
    >
      <div className="ui-sso-settings__header">
        <div className="ui-sso-settings__heading">
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions
          ? <div className="ui-sso-settings__actions">{actions}</div>
          : null}
      </div>
      {notice}
      {variant === "form"
        ? <div className="ui-sso-settings__form">{children}</div>
        : (
          <>
            {providers.length > 0
              ? (
                <ul
                  aria-label={providersLabel}
                  className="ui-sso-settings__providers"
                >
                  {providers.map((provider) => (
                    <li className="ui-sso-settings__provider" key={provider.id}>
                      <div className="ui-sso-settings__provider-copy">
                        <button
                          className="ui-sso-settings__provider-name"
                          onClick={provider.onSelect}
                          type="button"
                        >
                          {provider.name}
                        </button>
                        <span>{provider.detail}</span>
                      </div>
                      <div className="ui-sso-settings__provider-end">
                        {provider.status}
                        {provider.action}
                      </div>
                    </li>
                  ))}
                </ul>
              )
              : emptyMessage
              ? <p className="ui-sso-settings__empty">{emptyMessage}</p>
              : null}
            {domain
              ? <section className="ui-sso-settings__domain">{domain}</section>
              : null}
            {enforcement
              ? (
                <section className="ui-sso-settings__enforcement">
                  {enforcement}
                </section>
              )
              : null}
            {children}
          </>
        )}
    </div>
  );
}
