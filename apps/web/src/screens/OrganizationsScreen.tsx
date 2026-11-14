import * as UI from "@bakery/ui";
import { SIGN_OUT_PATH } from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type OrganizationChoice = {
  readonly id: string;
  readonly name: string;
  /** Already-translated role hint, or `null` for a membership with no role. */
  readonly role: string | null;
  /** The single character shown in the row's tile. */
  readonly initial: string;
};

export type OrganizationsScreenProps = {
  readonly state: "loading" | "ready" | "empty" | "removed" | "error";
  /** `ready` only. */
  readonly organizations: readonly OrganizationChoice[];
  /**
   * `ready` only: the previously selected organization stopped granting
   * access, so the chooser reopened with an explanation.
   */
  readonly forbidden: boolean;
  /**
   * `ready` only, and only when another page exists — the artboard's two
   * illustrative memberships have none, a real installation can.
   */
  readonly loadMore:
    | { readonly state: "ready" | "loading" | "error" }
    | null;
  /**
   * `paused`: organization creation is switched off for this installation,
   * so "Create organization" shows disabled with the reason. `hidden` shows
   * nothing (open or not yet known).
   */
  readonly creation?: "hidden" | "paused";
  readonly onSelect: (organizationId: string) => void;
  /** Retries the membership query (`empty`/`removed`/`error`). */
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
};

/**
 * `/organizations` presenter — Paper `organizations` (auth.js L176). With
 * memberships it is the chooser: one selectable row per organization, then
 * "Use a different account". Without them (`empty`, or `removed` after the
 * current one went away) it states why and offers a re-check and sign-out.
 */
export function OrganizationsScreen(
  {
    creation = "hidden",
    forbidden,
    loadMore,
    onLoadMore,
    onRefresh,
    onSelect,
    organizations,
    state,
  }: OrganizationsScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  if (state === "empty" || state === "removed") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid={`organizations-${state}`}
          description={translate("auth.organizations.emptyDescription")}
          title={translate(
            state === "removed"
              ? "auth.organizations.removedTitle"
              : "auth.organizations.empty",
          )}
        />
        <UI.InlineNotice tone="warning">
          {translate("auth.organizations.noAccessNotice")}
        </UI.InlineNotice>
        <UI.Button onClick={onRefresh} variant="secondary">
          {translate("auth.organizations.refresh")}
        </UI.Button>
        <UI.Link href={SIGN_OUT_PATH}>
          {translate("auth.organizations.signOut")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-paged-heading="organizations"
        data-testid="organizations-page"
        description={translate("auth.organizations.description")}
        title={translate("auth.organizations.title")}
      />
      {forbidden
        ? (
          <UI.InlineNotice tone="warning">
            {translate("auth.organizations.forbiddenNotice")}
          </UI.InlineNotice>
        )
        : null}
      {state === "loading"
        ? (
          <UI.Stack data-testid="organizations-loading" gap="compact">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRefresh}>
                {translate("core.actions.retry")}
              </UI.Button>
            }
            data-testid="organizations-error"
            description={translate("problems.UNKNOWN.description")}
            title={translate("shell.states.errorTitle")}
            variant="region"
          />
        )
        : (
          <UI.DescriptionList
            data-paged-list="organizations"
            data-testid="organizations-list"
          >
            {organizations.map((organization) => (
              <UI.DescriptionItem
                action={<UI.IconGlyph name="arrow" size="large" />}
                description={organization.role ?? undefined}
                initial={organization.initial}
                key={organization.id}
                onSelect={() => onSelect(organization.id)}
                title={organization.name}
              />
            ))}
          </UI.DescriptionList>
        )}
      {loadMore
        ? (
          <UI.CursorControls
            hasNext
            labels={{
              controls: translate("core.pagination.controls"),
              end: translate("core.pagination.endOfResults"),
              loadMore: translate("core.pagination.loadMore"),
              loading: translate("core.pagination.loading"),
              next: translate("core.pagination.next"),
              previous: translate("core.pagination.previous"),
              retry: translate("core.pagination.retry"),
            }}
            name="organizations"
            onNext={onLoadMore}
            onRetry={onLoadMore}
            state={loadMore.state}
          />
        )
        : null}
      {creation === "paused"
        ? (
          <UI.Stack data-testid="organization-creation-paused" gap="compact">
            <UI.Button
              aria-describedby="organization-creation-reason"
              disabled
              variant="secondary"
            >
              {translate("features.createOrganization.label")}
            </UI.Button>
            <UI.Text id="organization-creation-reason" variant="muted">
              {translate("features.createOrganization.paused")}
            </UI.Text>
          </UI.Stack>
        )
        : null}
      <UI.Link href={SIGN_OUT_PATH}>
        {translate("auth.organizations.useDifferentAccount")}
      </UI.Link>
    </UI.AuthEntry>
  );
}
