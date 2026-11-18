import { type ReactNode, useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { ScimConnection } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { scimConnectionQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";

type Credential = ScimConnection["credentials"][number];
type Failure = "error" | "conflict" | "forbidden";
type Pending = "rotate" | "revoke" | null;

/** The setup guide's three steps, in the order an administrator does them. */
const GUIDE_STEPS = [
  "settings.scim.guide.copyAddress",
  "settings.scim.guide.createToken",
  "settings.scim.guide.paste",
] as const;

const LIFETIMES = [30, 90, 365, 730] as const;
const OVERLAPS = [0, 30, 1440] as const;
/** A token that expires within this many days is flagged with a Rotate action. */
const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The group names the server maps to a role, and the role each one gives. */
const ROLE_GROUPS = [
  { group: "bakery-admin", role: "admin" },
  { group: "bakery-developer", role: "developer" },
  { group: "bakery-viewer", role: "viewer" },
  { group: "bakery-guest", role: "guest" },
] as const;
type RoleGroup = (typeof ROLE_GROUPS)[number];

/**
 * A person who cannot manage SCIM is refused: a change answers 403, and the
 * real server answers a plain member's read with 404 (observed against the
 * real API in sso-real-api.spec.ts), so a refused read is either.
 */
function isRefusedRead(error: unknown): boolean {
  return isForbiddenFailure(error) || failureStatus(error) === 404;
}

function failureKind(error: unknown): Failure {
  if (isForbiddenFailure(error)) return "forbidden";
  return failureStatus(error) === 409 ? "conflict" : "error";
}

/**
 * `/settings/scim`: the organization's SCIM provisioning connection. Admins
 * create it, rotate its credential and revoke it. The bearer secret exists
 * only in this component's state, once, right after create or rotate; it is
 * never written to the query cache, storage or the URL, and it is cleared on
 * dismissal and on leaving the page.
 */
export function ScimConnectionPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const lifetimeId = useId();
  const [lifetime, setLifetime] = useState<number>(365);
  const [overlap, setOverlap] = useState<number>(0);
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const connectionOptions = scimConnectionQueryOptions(api, scope);
  const connection = useQuery(connectionOptions);
  useEffect(() => () => setSecret(null), []);

  const organizationId = scope.organizationId;
  const data = connection.data;
  const forbidden = failure === "forbidden" ||
    (connection.isError && isRefusedRead(connection.error));
  const phone = useShellViewport() === "phone";
  // The phone list drops the time so a date never wraps: "Nov 12, 2026".
  const shortDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(value))
      : translate("settings.scim.never");

  const apply = (next: ScimConnection) =>
    queryClient.setQueryData(connectionOptions.queryKey, next);

  const [creating, create] = useSingleFlightSubmit(async () => {
    if (!organizationId) return;
    setFailure(null);
    const result = await api.scimConnection.create({
      organizationId,
      input: { expiresInDays: lifetime },
    });
    if (!result.ok) return setFailure(failureKind(result.error));
    apply(result.data.connection);
    setSecret(result.data.token);
    setCopied(false);
  });
  const [rotating, rotate] = useSingleFlightSubmit(async () => {
    if (!organizationId) return;
    setFailure(null);
    const result = await api.scimConnection.rotate({
      organizationId,
      input: {
        expiresInDays: lifetime,
        ...(overlap > 0 ? { previousCredentialsExpireInMinutes: overlap } : {}),
      },
    });
    setPending(null);
    if (!result.ok) return setFailure(failureKind(result.error));
    apply(result.data.connection);
    setSecret(result.data.token);
    setCopied(false);
  });
  const [revoking, revoke] = useSingleFlightSubmit(async () => {
    if (!organizationId) return;
    setFailure(null);
    const result = await api.scimConnection.revoke({ organizationId });
    setPending(null);
    if (!result.ok) return setFailure(failureKind(result.error));
    apply(result.data);
    setSecret(null);
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const status = data?.status ?? "none";
  // The token the identity provider uses is the active credential that
  // expires last. When none is active the connection still exists but
  // provisioning has stopped.
  const activeExpiries = (data?.credentials ?? [])
    .filter((row) => row.status === "active")
    .map((row) => new Date(row.expiresAt).getTime());
  const lastExpiry = activeExpiries.length > 0
    ? Math.max(...activeExpiries)
    : null;
  const tokenExpired = status === "active" && lastExpiry === null;
  const tokenExpiring = status === "active" && lastExpiry !== null &&
    lastExpiry - Date.now() <= EXPIRY_WARNING_DAYS * DAY_MS;
  const badgeStatus = tokenExpired ? "expired" : status;
  // The identity provider has used a token once it has synced; until then the
  // setup guide stays open.
  const hasSynced = (data?.credentials ?? []).some((row) =>
    row.lastUsedAt !== null
  );
  const notice = forbidden
    ? translate("settings.scim.forbidden")
    : connection.isError
    ? translate("settings.scim.loadError")
    : connection.isPending
    ? translate("settings.scim.loading")
    : failure === "conflict"
    ? translate("settings.scim.conflict")
    : failure === "error"
    ? translate("settings.scim.error")
    : undefined;
  const lifetimeField = (
    <UI.Combobox
      id={lifetimeId}
      label={translate("settings.scim.lifetime.label")}
      value={String(lifetime)}
      onChange={(event) => setLifetime(Number(event.target.value))}
      options={LIFETIMES.map((days) => ({
        value: String(days),
        label: translate("settings.scim.lifetime.days", { days }),
      }))}
    />
  );
  const gated = (content: ReactNode) => <div>{content}</div>;
  const createForm = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <UI.Stack>
        {lifetimeField}
        {/* In an Inline, so the button keeps its own width. */}
        <UI.Inline>
          <UI.Button type="submit" loading={creating}>
            {translate("settings.scim.create")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </form>
  );
  const rotateButton = (
    <UI.Button
      type="button"
      variant="secondary"
      onClick={() => setPending("rotate")}
    >
      {translate("settings.scim.rotate")}
    </UI.Button>
  );
  // The credential the identity provider holds: the active one that expires last.
  const shownCredential = (data?.credentials ?? [])
    .filter((row) => row.status === "active")
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
  const credentialsView = data
    ? (
      phone
        ? (
          <div
            aria-label={translate(
              "settings.scim.credentials.caption",
            )}
            data-testid="scim-credentials-list"
            role="list"
          >
            {data.credentials.map((row) => (
              <div key={row.id} role="listitem">
                <UI.ListRow
                  badge={
                    <UI.Badge
                      tone={row.status === "active" ? "success" : "neutral"}
                    >
                      <UI.VisuallyHidden>
                        {`${translate("settings.scim.column.status")}: `}
                      </UI.VisuallyHidden>
                      {translate(
                        `settings.scim.credential.${row.status}`,
                      )}
                    </UI.Badge>
                  }
                  detail={[
                    translate("settings.scim.credential.expires", {
                      date: shortDate(row.expiresAt),
                    }),
                    row.lastUsedAt
                      ? translate(
                        "settings.scim.credential.lastUsed",
                        {
                          date: shortDate(row.lastUsedAt),
                        },
                      )
                      : translate(
                        "settings.scim.credential.neverUsed",
                      ),
                  ].join(" · ")}
                  title={`${row.prefix}…`}
                />
              </div>
            ))}
          </div>
        )
        : (
          <UI.DataTable<Credential>
            caption={translate("settings.scim.credentials.caption")}
            columns={[
              {
                id: "prefix",
                header: translate("settings.scim.column.prefix"),
                cell: (row) => `${row.prefix}…`,
              },
              {
                id: "status",
                header: translate("settings.scim.column.status"),
                cell: (row) =>
                  translate(
                    `settings.scim.credential.${row.status}`,
                  ),
              },
              {
                id: "expires",
                header: translate("settings.scim.column.expires"),
                cell: (row) => date(row.expiresAt),
              },
              {
                id: "lastUsed",
                header: translate("settings.scim.column.lastUsed"),
                cell: (row) => date(row.lastUsedAt),
              },
            ]}
            emptyMessage=""
            error=""
            getRowKey={(row) => row.id}
            rows={data.credentials}
            state="ready"
            variant="table"
          />
        )
    )
    : null;
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <UI.SettingsContent data-testid="scim-connection">
        <UI.Stack gap="tight">
          <UI.Inline>
            <UI.Heading level="page">
              {translate("settings.scim.title")}
            </UI.Heading>
            {data && !forbidden
              ? (
                <UI.Badge
                  data-testid="scim-status"
                  tone={badgeStatus === "active"
                    ? "success"
                    : badgeStatus === "expired"
                    ? "danger"
                    : "neutral"}
                >
                  {translate(`settings.scim.status.${badgeStatus}`)}
                </UI.Badge>
              )
              : null}
          </UI.Inline>
          <UI.Text variant="muted">
            {translate("settings.scim.description")}
          </UI.Text>
        </UI.Stack>
        {notice
          ? (
            <UI.AlertBanner
              tone={forbidden || connection.isPending ||
                  connection.isSuccess && !failure
                ? "information"
                : "error"}
            >
              {notice}
            </UI.AlertBanner>
          )
          : null}
        {secret
          ? (
            <section
              aria-label={translate("settings.scim.token.title")}
              data-testid="scim-token-once"
            >
              <UI.Stack>
                <UI.AlertBanner tone="success">
                  <UI.Stack gap="compact">
                    {translate("settings.scim.token.warning")}
                    <UI.SetupKey>{secret}</UI.SetupKey>
                  </UI.Stack>
                </UI.AlertBanner>
                <UI.Inline>
                  <UI.Button type="button" variant="secondary" onClick={copy}>
                    {copied
                      ? translate("settings.scim.token.copied")
                      : translate("settings.scim.token.copy")}
                  </UI.Button>
                  <UI.Button
                    type="button"
                    onClick={() => {
                      setSecret(null);
                      setCopied(false);
                    }}
                  >
                    {translate("settings.scim.token.done")}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </section>
          )
          : null}
        {data && !forbidden
          ? status === "none"
            ? (
              <UI.EmptyState
                action={createForm}
                description={translate("settings.scim.empty.description")}
                title={translate("settings.scim.empty.title")}
              />
            )
            : (
              <>
                {tokenExpired
                  ? (
                    <UI.InlineNotice
                      action={rotateButton}
                      data-testid="scim-token-expired"
                      tone="error"
                    >
                      {translate("settings.scim.expired")}
                    </UI.InlineNotice>
                  )
                  : tokenExpiring && lastExpiry !== null
                  ? (
                    <UI.InlineNotice
                      action={rotateButton}
                      data-testid="scim-token-expiring"
                      tone="warning"
                    >
                      {translate("settings.scim.expiring", {
                        date: shortDate(new Date(lastExpiry).toISOString()),
                      })}
                    </UI.InlineNotice>
                  )
                  : null}
                {status === "active" && !hasSynced
                  ? (
                    <UI.StepList
                      data-testid="scim-setup-guide"
                      label={translate("settings.scim.guide.label")}
                    >
                      {GUIDE_STEPS.map((step, index) => (
                        <UI.StepItem
                          key={step}
                          number={index + 1}
                          status="upcoming"
                          statusLabel={translate("settings.scim.guide.step", {
                            number: index + 1,
                          })}
                          title={translate(step)}
                        />
                      ))}
                    </UI.StepList>
                  )
                  : null}
                <UI.DescriptionList>
                  {data.baseUrl
                    ? (
                      <UI.DescriptionItem
                        action={
                          <CopyValueButton
                            label={translate("settings.scim.baseUrl.copy")}
                            value={data.baseUrl}
                          />
                        }
                        description={
                          <UI.DataText state="wrapped" variant="code">
                            {data.baseUrl}
                          </UI.DataText>
                        }
                        title={translate("settings.scim.baseUrl")}
                      />
                    )
                    : null}
                  {status === "active" && !secret && shownCredential
                    ? (
                      <UI.DescriptionItem
                        description={`${shownCredential.prefix}… ${
                          translate("settings.scim.token.hidden")
                        }`}
                        title={translate("settings.scim.token.label")}
                      />
                    )
                    : null}
                  {data.createdAt
                    ? (
                      <UI.DescriptionItem
                        title={translate("settings.scim.created")}
                        description={date(data.createdAt)}
                      />
                    )
                    : null}
                </UI.DescriptionList>
                <UI.Stack gap="compact">
                  <UI.Heading level="section">
                    {translate("settings.scim.roles.title")}
                  </UI.Heading>
                  <UI.DataTable<RoleGroup>
                    caption={translate("settings.scim.roles.caption")}
                    captionHidden
                    columns={[
                      {
                        id: "group",
                        header: translate("settings.scim.roles.group"),
                        cell: (row) => (
                          <UI.DataText variant="code">{row.group}</UI.DataText>
                        ),
                      },
                      {
                        id: "role",
                        header: translate("settings.scim.roles.role"),
                        cell: (row) => translate(`access.role.${row.role}`),
                      },
                    ]}
                    emptyMessage=""
                    error=""
                    getRowKey={(row) => row.group}
                    rows={[...ROLE_GROUPS]}
                    state="ready"
                    variant="table"
                  />
                  <UI.Text variant="muted">
                    {translate("settings.scim.roles.default")}
                  </UI.Text>
                </UI.Stack>
                {status !== "active" ? gated(createForm) : null}
                {data.credentials.length > 0 ? credentialsView : null}
                {status === "active"
                  ? (
                    <UI.Inline>
                      {gated(rotateButton)}
                      <UI.Button
                        type="button"
                        variant="destructive-outline"
                        onClick={() => setPending("revoke")}
                      >
                        {translate("settings.scim.revoke")}
                      </UI.Button>
                    </UI.Inline>
                  )
                  : null}
              </>
            )
          : null}
        <UI.AlertDialog
          open={pending === "rotate"}
          onOpenChange={(open) => !open && setPending(null)}
          state={rotating ? "confirming" : "open"}
          title={translate("settings.scim.rotate.title")}
          variant="security"
          cancelAction={
            <UI.Button
              type="button"
              variant="secondary"
              onClick={() => setPending(null)}
            >
              {translate("settings.scim.cancel")}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              type="button"
              loading={rotating}
              onClick={() => void rotate()}
            >
              {translate("settings.scim.rotate.confirm")}
            </UI.Button>
          }
        >
          <UI.Stack>
            <UI.Text>{translate("settings.scim.rotate.body")}</UI.Text>
            {lifetimeField}
            <UI.Combobox
              label={translate("settings.scim.overlap.label")}
              value={String(overlap)}
              onChange={(event) => setOverlap(Number(event.target.value))}
              options={OVERLAPS.map((minutes) => ({
                value: String(minutes),
                label: translate(`settings.scim.overlap.${minutes}`),
              }))}
            />
          </UI.Stack>
        </UI.AlertDialog>
        <UI.AlertDialog
          open={pending === "revoke"}
          onOpenChange={(open) => !open && setPending(null)}
          state={revoking ? "confirming" : "open"}
          title={translate("settings.scim.revoke.title")}
          variant="destructive"
          cancelAction={
            <UI.Button
              type="button"
              variant="secondary"
              onClick={() => setPending(null)}
            >
              {translate("settings.scim.cancel")}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              type="button"
              variant="destructive"
              loading={revoking}
              onClick={() => void revoke()}
            >
              {translate("settings.scim.revoke.confirm")}
            </UI.Button>
          }
        >
          <UI.Text>{translate("settings.scim.revoke.body")}</UI.Text>
        </UI.AlertDialog>
      </UI.SettingsContent>
    </>
  );
}
