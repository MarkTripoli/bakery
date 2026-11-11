import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { ORGANIZATIONS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type AccessGroup = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Already-translated level, e.g. "Manage". */
  readonly level: string;
};

/** One external grant shown as a card; only the design sample supplies these. */
export type ExternalAction = {
  readonly id: string;
  readonly title: string;
  readonly connection: string;
  readonly actions: readonly string[];
  readonly note: string;
};

export type AccessScreenProps = {
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  readonly organizationName: string;
  /** The person's name, for the role card's avatar. */
  readonly displayName: string;
  /** Already-translated role name; `null` when the person holds no role. */
  readonly roleLabel: string | null;
  /** True when there is neither a role nor any grant. */
  readonly noGrant: boolean;
  readonly groups: readonly AccessGroup[];
  readonly externalActions?: readonly ExternalAction[];
  /** Where "View in Integrations" goes; omitted when there is no such page. */
  readonly integrationsHref?: string;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/access`: what the person's role and grants let them do in the
 * selected organization. Read-only; it never offers to change access, only
 * to ask an admin.
 */
export function AccessScreen(
  {
    async,
    displayName,
    externalActions = [],
    groups,
    integrationsHref,
    noGrant,
    onRefresh,
    onReload,
    onRetry,
    organizationName,
    roleLabel,
  }: AccessScreenProps,
) {
  const { translate } = useI18n();
  const help: ReactNode = (
    <UI.DescriptionItem
      data-testid="access-help"
      description={translate("access.help.description")}
      icon={<UI.IconGlyph name="lock" />}
      title={translate("access.help.title")}
    />
  );
  return (
    <UI.SettingsContent data-testid="access-settings" variant="access">
      <UI.AuthHeading
        description={organizationName === ""
          ? translate("access.description.noOrganization")
          : translate("access.description", {
            organization: organizationName,
          })}
        title={translate("access.title")}
      />
      <SecurityAsyncBoundary
        emptyAction={
          <RouterLink to={ORGANIZATIONS_PATH}>
            {translate("core.actions.switchOrganization")}
          </RouterLink>
        }
        emptyDescription={translate("access.empty.description")}
        emptyTitle={translate("access.empty.title")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        {noGrant
          ? (
            <UI.EmptyState
              action={
                <UI.Button onClick={onRefresh} variant="secondary">
                  {translate("access.refresh")}
                </UI.Button>
              }
              data-testid="access-no-grant"
              description={translate("access.noGrant.description")}
              title={translate("access.noGrant.title")}
            />
          )
          : (
            <>
              <UI.AccessCard
                description={translate("access.role.description")}
                leading={<UI.Avatar alt={displayName} size="large" />}
                title={roleLabel ?? translate("access.role.none")}
                trailing={roleLabel === null
                  ? undefined
                  : (
                    <UI.Badge tone="success">
                      {translate("access.role.active")}
                    </UI.Badge>
                  )}
              />
              <UI.SettingsSection title={translate("access.groups.heading")}>
                <UI.CapabilityList
                  aria-label={translate("access.groups.label")}
                  items={groups.map((group) => ({
                    id: group.id,
                    title: group.title,
                    description: group.description,
                    value: group.level,
                  }))}
                  variant="access"
                />
              </UI.SettingsSection>
              {externalActions.length > 0
                ? (
                  <UI.SettingsSection
                    title={translate("access.external.heading")}
                  >
                    {integrationsHref
                      ? (
                        <UI.Link href={integrationsHref}>
                          {translate("access.external.link")}
                          <UI.IconGlyph name="arrow" />
                        </UI.Link>
                      )
                      : null}
                    {externalActions.map((action) => (
                      <UI.AccessCard
                        description={action.connection}
                        key={action.id}
                        title={action.title}
                      >
                        <UI.Inline gap="compact">
                          {action.actions.map((name) => (
                            <UI.Badge key={name}>{name}</UI.Badge>
                          ))}
                        </UI.Inline>
                        <UI.Text variant="hint">{action.note}</UI.Text>
                      </UI.AccessCard>
                    ))}
                  </UI.SettingsSection>
                )
                : null}
              {help}
            </>
          )}
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
