import { useId, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { readSamlEntryPoint } from "../api/saml-metadata.ts";
import {
  SAML_METADATA_INVALID,
  ssoApi,
  type SsoOverview,
  type SsoProvider,
} from "../api/sso.ts";
import { useBakeryApi } from "../api/context.tsx";
import { organizationQueryOptions } from "../api/query.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { OrganizationSectionBreadcrumbs } from "../shell/SettingsShellSlots.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";

type View =
  | { readonly kind: "list" }
  | { readonly kind: "oidc" }
  | { readonly kind: "saml" }
  | { readonly kind: "edit"; readonly provider: SsoProvider };

const FORBIDDEN_CODES = new Set(["AUTH_FORBIDDEN", "RESOURCE_NOT_FOUND"]);

type Notice = { tone: "success" | "error" | "information"; key: MessageKey };

/** The TXT record an administrator publishes to prove control of a domain. */
function txtRecord(
  provider: Pick<SsoProvider, "providerId" | "domain">,
  token: string,
) {
  return `_bakery-verify-${provider.providerId}.${provider.domain} TXT ${token}`;
}

/**
 * `/settings/organization/sso`: the organization's single sign-on providers (OIDC and
 * SAML), domain verification and the "require SSO" switch. Every call is a
 * browser-session call the server authorizes (tenant, administrator). A
 * refusal clears the page to the forbidden notice and a bearer-style refusal
 * (`SESSION_REQUIRED`) says a browser session is needed.
 */
export function SsoPage() {
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const queryKey = protectedQueryKey(
    { ...scope, organizationId },
    "sso.overview",
    {},
  );
  const overview = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await ssoApi.overview(organizationId ?? "", signal);
      if (!result.ok) throw result;
      return result.data;
    },
    enabled: organizationId !== null,
    retry: false,
  });
  const failureCode = (overview.error as { code?: string } | null)?.code ?? "";
  const forbidden = overview.isError && FORBIDDEN_CODES.has(failureCode);
  const sessionRequired = overview.isError &&
    failureCode === "SESSION_REQUIRED";
  const data: SsoOverview | undefined = overview.isError
    ? undefined
    : overview.data;

  const api = useBakeryApi();
  const organization = useQuery(
    organizationQueryOptions(api, { ...scope, organizationId }),
  );
  const [confirmingRequire, setConfirmingRequire] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const run = async (id: string, work: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(id);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };
  const failure = (
    result: { status: number; code: string },
    fallback: MessageKey,
  ): Notice => ({
    tone: "error",
    key: result.code === "SESSION_REQUIRED"
      ? "settings.sso.sessionRequired"
      : result.code === SAML_METADATA_INVALID
      ? "settings.sso.dialog.metadataInvalid"
      : fallback,
  });

  // Every provider still waiting for its domain gets its TXT record. The
  // server answers with the pending token it already issued, so asking again
  // never replaces a record an administrator has published.
  const pendingProviders = (data?.providers ?? []).filter((provider) =>
    !provider.domainVerified
  );
  const tokens = useQueries({
    queries: pendingProviders.map((provider) => ({
      queryKey: [...queryKey, "txt", provider.providerId],
      queryFn: async () => {
        const result = await ssoApi.requestVerification(provider.providerId);
        if (!result.ok) throw result;
        return result.data.domainVerificationToken;
      },
      enabled: view.kind === "list" || view.kind === "edit",
      retry: false,
      staleTime: Infinity,
    })),
  });
  const tokenOf = (providerId: string): string | undefined =>
    tokens[pendingProviders.findIndex((p) => p.providerId === providerId)]
      ?.data;
  // Requiring SSO needs a verified provider to require; an enforced
  // organization keeps the switch so it can still be turned off.
  const verifiedProviders = (data?.providers ?? []).filter((provider) =>
    provider.domainVerified
  );
  const canRequire = data !== undefined &&
    (data.enforce ||
      data.providers.some((provider) => provider.domainVerified));
  const checkDomain = (provider: SsoProvider) =>
    run(`check:${provider.providerId}`, async () => {
      const result = await ssoApi.verifyDomain(provider.providerId);
      // A domain someone else already verified (another tab, another
      // administrator) answers 409 DOMAIN_VERIFIED: it is verified, not an error.
      const verified = result.ok ||
        (result.status === 409 && result.code === "DOMAIN_VERIFIED");
      setNotice(
        verified
          ? { tone: "success", key: "settings.sso.verify.done" }
          : result.status === 502
          ? { tone: "information", key: "settings.sso.verify.pending" }
          : failure(result, "settings.sso.verify.error"),
      );
      await refresh();
    });
  const requireSwitchId = useId();
  const returnToRequireSwitch = () =>
    focusAfterPaint(() => document.getElementById(requireSwitchId));
  const toggle = (enforce: boolean) =>
    run("enforce", async () => {
      const result = await ssoApi.setEnforcement(organizationId ?? "", enforce);
      if (!result.ok) {
        setNotice(
          result.code === "SSO_PROVIDER_REQUIRED"
            ? { tone: "error", key: "settings.sso.enforce.needsProvider" }
            : failure(result, "settings.sso.enforce.error"),
        );
      }
      await refresh();
    });

  const pageNotice: Notice | null = organizationId === null
    ? { tone: "information", key: "settings.sso.noOrganization" }
    : forbidden
    ? { tone: "information", key: "settings.sso.forbidden" }
    : sessionRequired
    ? { tone: "error", key: "settings.sso.sessionRequired" }
    : overview.isError
    ? { tone: "error", key: "settings.sso.loadError" }
    : overview.isPending
    ? { tone: "information", key: "settings.sso.loading" }
    : notice;
  const title = view.kind === "oidc"
    ? "settings.sso.dialog.oidc.title"
    : view.kind === "saml"
    ? "settings.sso.dialog.saml.title"
    : view.kind === "edit"
    ? "settings.sso.dialog.edit.title"
    : "settings.sso.title";
  const backToList = () => setView({ kind: "list" });
  const heading = view.kind === "edit"
    ? translate(title, { name: view.provider.providerId })
    : translate(title);

  const banner = (value: Notice | null) =>
    value
      ? (
        <UI.AlertBanner tone={value.tone}>
          {translate(value.key)}
        </UI.AlertBanner>
      )
      : undefined;
  const noticeNode = banner(pageNotice);
  // The form shows its own "not verified yet" line, so the page banner would
  // say the same sentence twice.
  const formNoticeNode = banner(
    pageNotice?.key === "settings.sso.verify.pending" ? null : pageNotice,
  );

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <OrganizationSectionBreadcrumbs section="settings.sso.section" />
      <UI.SettingsContent data-testid="organization-sso">
        {view.kind !== "list"
          ? (
            <UI.SsoSettings
              title={heading}
              variant="form"
              notice={formNoticeNode}
            >
              {organizationId && data
                ? (
                  <ProviderForm
                    key={view.kind === "edit"
                      ? view.provider.providerId
                      : view.kind}
                    view={view.kind === "edit"
                      ? {
                        ...view,
                        // The form follows the stored provider, so a domain
                        // verified while it is open stops offering the check.
                        provider:
                          data.providers.find((provider) =>
                            provider.providerId === view.provider.providerId
                          ) ?? view.provider,
                      }
                      : view}
                    organizationId={organizationId}
                    onCancel={backToList}
                    onSaved={async (saved) => {
                      backToList();
                      setNotice({ tone: "success", key: saved });
                      await refresh();
                    }}
                    onRemoved={async () => {
                      backToList();
                      setNotice({
                        tone: "success",
                        key: "settings.sso.provider.deleted",
                      });
                      await refresh();
                    }}
                    checkDomain={checkDomain}
                    checking={busy?.startsWith("check:") ?? false}
                    token={view.kind === "edit"
                      ? tokenOf(view.provider.providerId)
                      : undefined}
                    failure={failure}
                  />
                )
                : null}
            </UI.SsoSettings>
          )
          : (
            <UI.SsoSettings
              title={heading}
              description={translate("settings.sso.description")}
              notice={noticeNode}
              actions={data
                ? (
                  <>
                    <UI.Button
                      type="button"
                      variant="outline"
                      onClick={() => setView({ kind: "saml" })}
                    >
                      {translate("settings.sso.add.saml")}
                    </UI.Button>
                    <UI.Button
                      type="button"
                      onClick={() => setView({ kind: "oidc" })}
                    >
                      {translate("settings.sso.add.oidc")}
                    </UI.Button>
                  </>
                )
                : undefined}
              providersLabel={translate("settings.sso.providers.caption")}
              emptyMessage={data && data.providers.length === 0
                ? translate("settings.sso.providers.empty")
                : undefined}
              providers={(data?.providers ?? []).map((provider) => ({
                id: provider.providerId,
                name: `${provider.providerId} · ${
                  translate(`settings.sso.protocol.${provider.protocol}`)
                }`,
                detail: provider.protocol === "oidc"
                  ? provider.issuer
                  : provider.domain,
                status: (
                  <UI.StatusBadge
                    status={provider.domainVerified ? "healthy" : "needsInput"}
                  >
                    {translate(
                      provider.domainVerified
                        ? "settings.sso.status.enabled"
                        : "settings.sso.domain.unverified",
                    )}
                  </UI.StatusBadge>
                ),
                action: (
                  <UI.Button
                    type="button"
                    variant="outline"
                    aria-label={translate("settings.sso.provider.editLabel", {
                      name: provider.providerId,
                    })}
                    onClick={() => setView({ kind: "edit", provider })}
                  >
                    {translate("settings.sso.provider.edit")}
                  </UI.Button>
                ),
                onSelect: () => setView({ kind: "edit", provider }),
              }))}
              domain={data && tokens.some((query) => query.data)
                ? (
                  <UI.Stack>
                    <UI.Heading level="section">
                      {translate("settings.sso.verify.title")}
                    </UI.Heading>
                    {pendingProviders.map((provider, index) => {
                      const token = tokens[index]?.data;
                      return token
                        ? (
                          <UI.Stack
                            gap="compact"
                            key={provider.providerId}
                            data-testid={`txt-${provider.providerId}`}
                          >
                            <UI.Text variant="muted">
                              {translate("settings.sso.verify.short", {
                                domain: provider.domain,
                              })}
                            </UI.Text>
                            <UI.SetupKey>
                              {txtRecord(provider, token)}
                            </UI.SetupKey>
                            <UI.Inline>
                              <UI.Button
                                type="button"
                                variant="outline"
                                aria-label={translate(
                                  "settings.sso.verify.checkLabel",
                                  { name: provider.providerId },
                                )}
                                loading={busy ===
                                  `check:${provider.providerId}`}
                                onClick={() => void checkDomain(provider)}
                              >
                                {translate("settings.sso.verify.check")}
                              </UI.Button>
                            </UI.Inline>
                          </UI.Stack>
                        )
                        : null;
                    })}
                  </UI.Stack>
                )
                : undefined}
              enforcement={data
                ? (
                  <div>
                    <UI.Switch
                      checked={data.enforce}
                      disabled={!canRequire}
                      id={requireSwitchId}
                      pending={busy === "enforce"}
                      onChange={(event) => {
                        // Turning it on changes how every member signs in, so it
                        // asks first and the switch only moves once the request
                        // succeeds; turning it off needs no question.
                        if (event.target.checked) setConfirmingRequire(true);
                        else void toggle(false);
                      }}
                    >
                      {translate("settings.sso.enforce.label")}
                    </UI.Switch>
                    {data.enforce
                      ? (
                        <UI.Text>
                          {translate("settings.sso.enforce.breakGlass")}
                        </UI.Text>
                      )
                      : (
                        <UI.Text variant="muted">
                          {translate(
                            canRequire
                              ? "settings.sso.require.help"
                              : "settings.sso.enforce.needsProvider",
                          )}
                        </UI.Text>
                      )}
                  </div>
                )
                : undefined}
            />
          )}
        {data
          ? (
            <UI.AlertDialog
              open={confirmingRequire}
              onOpenChange={(open) => {
                setConfirmingRequire(open);
                if (!open) returnToRequireSwitch();
              }}
              state={busy === "enforce" ? "confirming" : "open"}
              title={translate("settings.sso.require.confirm.title")}
              variant="security"
              cancelAction={
                <UI.Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setConfirmingRequire(false);
                    returnToRequireSwitch();
                  }}
                >
                  {translate("settings.sso.dialog.cancel")}
                </UI.Button>
              }
              confirmAction={
                <UI.Button
                  type="button"
                  loading={busy === "enforce"}
                  onClick={() => {
                    void toggle(true).then(() => {
                      setConfirmingRequire(false);
                      returnToRequireSwitch();
                    });
                  }}
                >
                  {translate("settings.sso.require.confirm.confirm")}
                </UI.Button>
              }
            >
              <UI.Text>
                {verifiedProviders.length === 1
                  ? translate("settings.sso.require.confirm.body", {
                    organization: organization.data?.name ??
                      translate(
                        "settings.sso.require.confirm.thisOrganization",
                      ),
                    provider: verifiedProviders[0]?.providerId ?? "",
                  })
                  : translate("settings.sso.require.confirm.bodyMany", {
                    organization: organization.data?.name ??
                      translate(
                        "settings.sso.require.confirm.thisOrganization",
                      ),
                  })}
              </UI.Text>
            </UI.AlertDialog>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}

function ProviderForm({
  view,
  organizationId,
  token,
  checking,
  checkDomain,
  failure,
  onCancel,
  onSaved,
  onRemoved,
}: {
  readonly view: Exclude<View, { kind: "list" }>;
  readonly organizationId: string;
  readonly token: string | undefined;
  readonly checking: boolean;
  readonly checkDomain: (provider: SsoProvider) => Promise<void>;
  readonly failure: (
    result: { status: number; code: string },
    fallback: MessageKey,
  ) => Notice;
  readonly onCancel: () => void;
  readonly onSaved: (notice: MessageKey) => Promise<void>;
  readonly onRemoved: () => Promise<void>;
}) {
  const { translate } = useI18n();
  const ids = {
    provider: useId(),
    domain: useId(),
    issuer: useId(),
    clientId: useId(),
    secret: useId(),
    clientIdHint: useId(),
    secretHint: useId(),
    metadata: useId(),
  };
  const editing = view.kind === "edit" ? view.provider : null;
  const kind = editing ? editing.protocol : view.kind;
  const [providerId, setProviderId] = useState(editing?.providerId ?? "");
  const [domain, setDomain] = useState(editing?.domain ?? "");
  const [issuer, setIssuer] = useState(editing?.issuer ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [metadata, setMetadata] = useState("");
  const [problem, setProblem] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      if (editing) {
        // New SAML metadata also carries the provider's sign-on URL.
        const samlEntryPoint = kind === "saml" && metadata.trim()
          ? readSamlEntryPoint(metadata.trim())
          : undefined;
        if (samlEntryPoint === null) {
          setProblem({
            tone: "error",
            key: "settings.sso.dialog.metadataInvalid",
          });
          return;
        }
        const result = await ssoApi.updateProvider(editing.providerId, {
          ...(domain.trim() !== editing.domain
            ? { domain: domain.trim() }
            : {}),
          ...(kind === "oidc" && issuer.trim() !== editing.issuer
            ? { issuer: issuer.trim() }
            : {}),
          ...(kind === "oidc" && (clientId.trim() || clientSecret)
            ? {
              oidcConfig: {
                ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
                ...(clientSecret ? { clientSecret } : {}),
              },
            }
            : {}),
          ...(samlEntryPoint
            ? {
              samlConfig: {
                entryPoint: samlEntryPoint,
                idpMetadata: { metadata: metadata.trim() },
              },
            }
            : {}),
        });
        if (!result.ok) {
          setProblem(failure(result, "settings.sso.dialog.error"));
          return;
        }
        await onSaved("settings.sso.provider.updated");
        return;
      }
      const result = kind === "oidc"
        ? await ssoApi.registerOidc(organizationId, {
          providerId: providerId.trim(),
          domain: domain.trim(),
          issuer: issuer.trim(),
          clientId: clientId.trim(),
          clientSecret,
        })
        : await ssoApi.registerSaml(organizationId, {
          providerId: providerId.trim(),
          domain: domain.trim(),
          metadata: metadata.trim(),
        });
      if (!result.ok) {
        setProblem(failure(result, "settings.sso.dialog.error"));
        return;
      }
      await onSaved("settings.sso.provider.saved");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!editing || saving) return;
    setConfirmingRemove(false);
    setSaving(true);
    try {
      const result = await ssoApi.remove(editing.providerId);
      if (!result.ok) {
        setProblem(failure(result, "settings.sso.provider.deleteError"));
        return;
      }
      await onRemoved();
    } finally {
      setSaving(false);
    }
  };

  // Verification belongs to a saved provider: both protocols save, then the
  // list (or this form, when editing) walks the administrator through it.
  const showTxt = editing !== null && !editing.domainVerified;
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {editing ? null : (
          <UI.Field
            htmlFor={ids.provider}
            label={translate("settings.sso.field.providerId")}
          >
            <UI.TextInput
              id={ids.provider}
              name="providerId"
              autoComplete="off"
              type="text"
              value={providerId}
              onChange={setProviderId}
            />
          </UI.Field>
        )}
        {kind === "oidc"
          ? (
            <>
              <UI.Field
                htmlFor={ids.issuer}
                label={translate("settings.sso.field.issuer")}
              >
                <UI.TextInput
                  id={ids.issuer}
                  name="issuer"
                  autoComplete="off"
                  type="text"
                  inputMode="url"
                  value={issuer}
                  onChange={setIssuer}
                />
              </UI.Field>
              <UI.Field
                htmlFor={ids.clientId}
                hint={editing
                  ? (
                    <span id={ids.clientIdHint}>
                      {translate("settings.sso.field.keepClientId")}
                    </span>
                  )
                  : undefined}
                label={translate("settings.sso.field.clientId")}
              >
                <UI.TextInput
                  id={ids.clientId}
                  name="clientId"
                  autoComplete="off"
                  describedBy={editing ? ids.clientIdHint : undefined}
                  type="text"
                  value={clientId}
                  onChange={setClientId}
                />
              </UI.Field>
              <UI.Field
                htmlFor={ids.secret}
                hint={editing
                  ? (
                    <span id={ids.secretHint}>
                      {translate("settings.sso.field.keepSecret")}
                    </span>
                  )
                  : undefined}
                label={translate("settings.sso.field.clientSecret")}
              >
                <UI.PasswordInput
                  id={ids.secret}
                  name="clientSecret"
                  autoComplete="new-password"
                  describedBy={editing ? ids.secretHint : undefined}
                  value={clientSecret}
                  onChange={setClientSecret}
                  revealLabels={{
                    show: translate("settings.sso.field.clientSecret.show"),
                    hide: translate("settings.sso.field.clientSecret.hide"),
                  }}
                />
              </UI.Field>
            </>
          )
          : (
            <UI.Field
              htmlFor={ids.metadata}
              label={translate("settings.sso.field.metadata")}
              variant="textarea"
            >
              <textarea
                id={ids.metadata}
                name="metadata"
                placeholder={translate(
                  "settings.sso.field.metadata.placeholder",
                )}
                value={metadata}
                onChange={(event) => setMetadata(event.target.value)}
              />
            </UI.Field>
          )}
        <UI.Field
          htmlFor={ids.domain}
          label={translate("settings.sso.field.domain")}
        >
          <UI.TextInput
            id={ids.domain}
            name="domain"
            autoComplete="off"
            type="text"
            value={domain}
            onChange={setDomain}
          />
        </UI.Field>
        {showTxt
          ? (
            <UI.Stack gap="compact">
              <UI.Heading level="section">
                {translate("settings.sso.verify.heading")}
              </UI.Heading>
              <UI.Text variant="muted">
                {translate("settings.sso.verify.instructions", {
                  domain: editing!.domain,
                })}
              </UI.Text>
              <UI.SetupKey>{txtRecord(editing!, token ?? "…")}</UI.SetupKey>
              <UI.InlineNotice tone="warning">
                {translate("settings.sso.verify.pending")}
              </UI.InlineNotice>
            </UI.Stack>
          )
          : null}
        {problem
          ? (
            <UI.AlertBanner tone={problem.tone}>
              {translate(problem.key)}
            </UI.AlertBanner>
          )
          : null}
        <UI.Inline variant="actions">
          {editing
            ? (
              <UI.Button
                type="button"
                variant="destructive-outline"
                loading={saving}
                onClick={() => setConfirmingRemove(true)}
              >
                {translate("settings.sso.provider.delete")}
              </UI.Button>
            )
            : null}
          {showTxt
            ? (
              <UI.Button
                type="button"
                variant="outline"
                loading={checking || saving}
                onClick={() => void checkDomain(editing!)}
              >
                {translate("settings.sso.verify.check")}
              </UI.Button>
            )
            : null}
          <UI.Button type="button" variant="outline" onClick={onCancel}>
            {translate("settings.sso.dialog.cancel")}
          </UI.Button>
          <UI.Button type="submit" loading={saving}>
            {translate("settings.sso.dialog.save")}
          </UI.Button>
        </UI.Inline>
      </form>
      {editing
        ? (
          <UI.AlertDialog
            open={confirmingRemove}
            onOpenChange={setConfirmingRemove}
            state={saving ? "confirming" : "open"}
            title={translate("settings.sso.provider.delete.title", {
              name: editing.providerId,
            })}
            variant="destructive"
            cancelAction={
              <UI.Button
                type="button"
                variant="secondary"
                onClick={() => setConfirmingRemove(false)}
              >
                {translate("settings.sso.dialog.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                type="button"
                variant="destructive"
                loading={saving}
                onClick={() => void remove()}
              >
                {translate("settings.sso.provider.delete.confirm")}
              </UI.Button>
            }
          >
            <UI.Text>
              {translate("settings.sso.provider.delete.body", {
                domain: editing.domain,
              })}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
