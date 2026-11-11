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
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";

type Credential = ScimConnection["credentials"][number];
type Failure = "error" | "conflict" | "forbidden";
type Pending = "rotate" | "revoke" | null;

const LIFETIMES = [30, 90, 365, 730] as const;
const OVERLAPS = [0, 30, 1440] as const;

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
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <UI.SettingsContent data-testid="scim-connection">
        <UI.Heading level="page">{translate("settings.scim.title")}</UI.Heading>
        <UI.Text variant="muted">
          {translate("settings.scim.description")}
        </UI.Text>
        {notice
          ? (
            <UI.AlertBanner
              tone={connection.isPending || connection.isSuccess && !failure
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
          ? (
            <>
              <UI.DescriptionList>
                <UI.DescriptionItem
                  title={translate("settings.scim.status")}
                  description={translate(`settings.scim.status.${status}`)}
                />
                {data.baseUrl
                  ? (
                    <UI.DescriptionItem
                      title={translate("settings.scim.baseUrl")}
                      description={data.baseUrl}
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
              <UI.AlertBanner tone="information">
                {translate("settings.scim.roles")}
              </UI.AlertBanner>
              {status !== "active"
                ? gated(
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void create();
                    }}
                  >
                    {lifetimeField}
                    <UI.Button type="submit" loading={creating}>
                      {translate("settings.scim.create")}
                    </UI.Button>
                  </form>,
                )
                : null}
              {data.credentials.length > 0
                ? (
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
                          translate(`settings.scim.credential.${row.status}`),
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
                : null}
              {status === "active"
                ? (
                  <UI.Inline>
                    {gated(
                      <UI.Button
                        type="button"
                        variant="secondary"
                        onClick={() => setPending("rotate")}
                      >
                        {translate("settings.scim.rotate")}
                      </UI.Button>,
                    )}
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
