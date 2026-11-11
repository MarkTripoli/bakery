import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { readSamlEntryPoint } from "../api/saml-metadata.ts";
import {
  SAML_METADATA_INVALID,
  ssoApi,
  type SsoOverview,
  type SsoProvider,
} from "../api/sso.ts";
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

  // The first provider still waiting for its domain gets the TXT record.
  const pending = data?.providers.find((provider) => !provider.domainVerified);
  const token = useQuery({
    queryKey: [...queryKey, "txt", pending?.providerId ?? ""],
    queryFn: async () => {
      const result = await ssoApi.requestVerification(pending!.providerId);
      if (!result.ok) throw result;
      return result.data.domainVerificationToken;
    },
    enabled: pending !== undefined && view.kind === "list",
    retry: false,
    staleTime: Infinity,
  });
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

  const noticeNode = pageNotice
    ? (
      <UI.AlertBanner tone={pageNotice.tone}>
        {translate(pageNotice.key)}
      </UI.AlertBanner>
    )
    : undefined;

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <OrganizationSectionBreadcrumbs section="settings.sso.section" />
      <div data-testid="organization-sso">
        {view.kind !== "list"
          ? (
            <UI.SsoSettings
              title={translate(title)}
              variant="form"
              notice={noticeNode}
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
                    token={token.data}
                    failure={failure}
                  />
                )
                : null}
            </UI.SsoSettings>
          )
          : (
            <UI.SsoSettings
              title={translate(title)}
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
                        : "settings.sso.status.disabled",
                    )}
                  </UI.StatusBadge>
                ),
                onSelect: () => setView({ kind: "edit", provider }),
              }))}
              domain={data && pending && token.data
                ? (
                  <div data-testid={`txt-${pending.providerId}`}>
                    <UI.Heading level="section">
                      {translate("settings.sso.verify.title")}
                    </UI.Heading>
                    <UI.Text variant="muted">
                      {translate("settings.sso.verify.short", {
                        domain: pending.domain,
                      })}
                    </UI.Text>
                    <UI.SetupKey>{txtRecord(pending, token.data)}</UI.SetupKey>
                  </div>
                )
                : undefined}
              enforcement={data
                ? (
                  <div>
                    <UI.Switch
                      checked={data.enforce}
                      pending={busy === "enforce"}
                      onChange={(event) => void toggle(event.target.checked)}
                    >
                      {translate("settings.sso.enforce.label")}
                    </UI.Switch>
                    <UI.Text>
                      {translate("settings.sso.enforce.breakGlass")}
                    </UI.Text>
                  </div>
                )
                : undefined}
            />
          )}
      </div>
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
  // A SAML provider saved from this form before its domain check.
  const [created, setCreated] = useState<
    { providerId: string; domain: string; token: string } | null
  >(null);

  const registerSamlProvider = async () => {
    const result = await ssoApi.registerSaml(organizationId, {
      providerId: providerId.trim(),
      domain: domain.trim(),
      metadata: metadata.trim(),
    });
    if (!result.ok) {
      setProblem(failure(result, "settings.sso.dialog.error"));
      return null;
    }
    const next = {
      providerId: providerId.trim(),
      domain: domain.trim(),
      token: result.data.domainVerificationToken ?? "…",
    };
    setCreated(next);
    return next;
  };
  const checkCreated = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      const target = created ?? await registerSamlProvider();
      if (!target) return;
      await checkDomain({
        providerId: target.providerId,
        domain: target.domain,
        issuer: "",
        domainVerified: false,
        protocol: "saml",
      });
    } finally {
      setSaving(false);
    }
  };

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
      if (created) {
        await onSaved("settings.sso.provider.saved");
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

  const showTxt = editing ? !editing.domainVerified : kind === "saml";
  // Before the provider exists there is no token yet: the record shows the
  // name it will have and the token appears once the provider is saved.
  const txtSubject = editing ?? created ??
    { providerId: providerId.trim() || "…", domain: domain.trim() || "…" };
  return (
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
              label={translate("settings.sso.field.clientId")}
            >
              <UI.TextInput
                id={ids.clientId}
                name="clientId"
                autoComplete="off"
                type="text"
                value={clientId}
                onChange={setClientId}
              />
            </UI.Field>
            <UI.Field
              htmlFor={ids.secret}
              label={translate("settings.sso.field.clientSecret")}
            >
              <UI.PasswordInput
                id={ids.secret}
                name="clientSecret"
                autoComplete="new-password"
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
              placeholder={translate("settings.sso.field.metadata.placeholder")}
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
                domain: txtSubject.domain,
              })}
            </UI.Text>
            <UI.SetupKey>
              {txtRecord(
                txtSubject,
                editing ? token ?? "…" : created?.token ?? "…",
              )}
            </UI.SetupKey>
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
              variant="destructive"
              loading={saving}
              onClick={() => void remove()}
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
              onClick={() =>
                void (editing ? checkDomain(editing) : checkCreated())}
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
  );
}
