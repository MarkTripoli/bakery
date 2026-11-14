import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type {
  AccessBindingRecord,
  AccessTokenCreated,
  AccessTokenRecord,
  Invitation,
  Membership,
  PrincipalRecord,
} from "../api/access-client.ts";
import type { ApiFailure, ApiResult } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  connectedClientsListQueryOptions,
  effectiveAccessQueryOptions,
  organizationQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, failureStatus } from "../app/async-state.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";

const PAGE_LIMIT = 100;
const ROLES = ["admin", "developer", "viewer", "guest"] as const;
type Role = (typeof ROLES)[number];
const BINDING_ROLES = ["viewer", "developer"] as const;
type BindingRole = (typeof BINDING_ROLES)[number];
const SCOPE_TYPES = ["application", "repository"] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];
const TOKEN_SCOPES = ["bakery:read", "bakery:operate", "bakery:admin"] as const;
const TOKEN_DAYS = [30, 90, 365] as const;

const ROLE_KEYS: Readonly<Record<Role, MessageKey>> = {
  admin: "access.role.admin",
  developer: "access.role.developer",
  viewer: "access.role.viewer",
  guest: "access.role.guest",
};
const SCOPE_TYPE_KEYS: Readonly<Record<ScopeType, MessageKey>> = {
  application: "settings.orgAccess.scope.application",
  repository: "settings.orgAccess.scope.repository",
};
const TOKEN_SCOPE_KEYS: Readonly<Record<string, MessageKey>> = {
  "bakery:read": "settings.orgAccess.tokenScope.read",
  "bakery:operate": "settings.orgAccess.tokenScope.operate",
  "bakery:admin": "settings.orgAccess.tokenScope.admin",
};

type Confirm =
  | { kind: "removeMember"; membership: Membership; name: string }
  | { kind: "cancelInvitation"; invitation: Invitation }
  | { kind: "revokeToken"; token: AccessTokenRecord }
  | { kind: "removeBinding"; binding: AccessBindingRecord; name: string }
  | { kind: "revokeClient"; id: string; name: string };

/** A mutation attempt kept so a retry after a transport failure replays it. */
function useIntent() {
  const intent = useRef<{ signature: string; key: string } | null>(null);
  return (signature: string) => {
    if (intent.current?.signature !== signature) {
      intent.current = { signature, key: crypto.randomUUID() };
    }
    return intent.current.key;
  };
}

function shortId(id: string) {
  return id.slice(0, 8);
}

/**
 * `/settings/organization/access`. Who can do what in this organization:
 * members and their roles by scope, invitations, service accounts and their
 * tokens, and the caller's connected clients. Everything is a live read of the
 * server's answer and every change is a session-only mutation the server
 * audits; this page never decides who is allowed, it shows the server's
 * answer. A person without the Admin role gets a notice and no data.
 */
export function OrganizationAccessPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const scoped = { ...scope, organizationId };
  const intentKey = useIntent();

  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scoped),
    retry: false,
  });
  const organization = useQuery(organizationQueryOptions(api, scoped));
  const isAdmin = access.data?.role === "admin";
  const enabled = organizationId !== null && isAdmin;
  const read = <T,>(
    name: string,
    load: (id: string, signal: AbortSignal) => Promise<ApiResult<T>>,
  ) => ({
    queryKey: protectedQueryKey(scoped, `access.${name}`, {}),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const result = await load(organizationId ?? "", signal);
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled,
    retry: false,
  });
  const members = useQuery(
    read("members", (id, signal) =>
      api.access.members.list({
        organizationId: id,
        limit: PAGE_LIMIT,
        signal,
      })),
  );
  const invitations = useQuery(
    read("invitations", (id, signal) =>
      api.access.invitations.list({
        organizationId: id,
        limit: PAGE_LIMIT,
        signal,
      })),
  );
  const principals = useQuery(
    read("principals", (id, signal) =>
      api.access.principals.list({
        organizationId: id,
        limit: PAGE_LIMIT,
        signal,
      })),
  );
  const tokens = useQuery(
    read("tokens", (id, signal) =>
      api.access.tokens.list({
        organizationId: id,
        limit: PAGE_LIMIT,
        signal,
      })),
  );
  const bindings = useQuery(
    read("bindings", (id, signal) =>
      api.access.bindings.list({
        organizationId: id,
        limit: PAGE_LIMIT,
        signal,
      })),
  );
  const applications = useQuery(
    read(
      "applications",
      (id, signal) =>
        api.listApplications({ organizationId: id, limit: PAGE_LIMIT, signal }),
    ),
  );
  const repositories = useQuery(
    read(
      "repositories",
      (id, signal) =>
        api.listRepositories({ organizationId: id, limit: PAGE_LIMIT, signal }),
    ),
  );
  const clients = useQuery({
    ...connectedClientsListQueryOptions(api, scoped),
    enabled,
    retry: false,
  });

  const [invite, setInvite] = useState<
    { email: string; role: Role; open: boolean }
  >({ email: "", role: "developer", open: false });
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);
  const [created, setCreated] = useState<AccessTokenCreated | null>(null);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [roleDraft, setRoleDraft] = useState<Role>("developer");
  const [bindingDraft, setBindingDraft] = useState<
    { role: BindingRole; type: ScopeType; scopeId: string }
  >({ role: "viewer", type: "application", scopeId: "" });
  const [accountDraft, setAccountDraft] = useState<
    { open: boolean; name: string; role: Role | "none" }
  >({ open: false, name: "", role: "developer" });
  const [tokenDraft, setTokenDraft] = useState<
    {
      open: boolean;
      principalId: string;
      name: string;
      scope: string;
      days: number;
    }
  >({
    open: false,
    principalId: "",
    name: "",
    scope: "bakery:read",
    days: 30,
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  // The English catalog is British, so its dates read day first.
  const dateLocale = locale === "en" ? "en-GB" : locale;
  const when = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: "medium",
    timeZone,
  });
  const whenShort = new Intl.DateTimeFormat(dateLocale, {
    day: "numeric",
    month: "short",
    timeZone,
  });
  const people = useMemo(() => {
    const byId = new Map<string, PrincipalRecord>();
    for (const principal of principals.data?.items ?? []) {
      byId.set(principal.id, principal);
    }
    return byId;
  }, [principals.data]);
  const nameOf = (principalId: string) =>
    people.get(principalId)?.displayName ?? shortId(principalId);
  const resourceName = (type: string, id: string) => {
    if (type === "application") {
      return applications.data?.items.find((item) => item.id === id)?.name ??
        shortId(id);
    }
    const repository = repositories.data?.items.find((item) => item.id === id);
    return repository ? `${repository.owner}/${repository.name}` : shortId(id);
  };

  const refresh = async (...names: string[]) => {
    await Promise.all(
      names.map((name) =>
        queryClient.invalidateQueries({
          queryKey: protectedQueryKey(scoped, `access.${name}`, {}),
        })
      ),
    );
  };
  const failure = (error: ApiFailure, fallback: MessageKey): string => {
    const status = failureStatus(error);
    const code = error.kind === "problem" ? error.problem.code : null;
    if (code === "SESSION_REQUIRED") {
      return translate("settings.orgAccess.error.sessionRequired");
    }
    if (status === 409 && code === "STATE_CONFLICT") {
      return translate("settings.orgAccess.error.conflict");
    }
    if (status === 409 || status === 412) {
      return translate("settings.orgAccess.error.stale");
    }
    if (asyncKindForError(error) === "forbidden") {
      return translate("settings.orgAccess.error.forbidden");
    }
    return translate(fallback);
  };
  const act = async (
    work: () => Promise<ApiResult<unknown>>,
    done: MessageKey,
    fallback: MessageKey,
    names: string[],
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const result = await work();
      if (result.ok) {
        setNotice({ tone: "success", text: translate(done) });
        await refresh(...names);
        return true;
      }
      setNotice({ tone: "error", text: failure(result.error, fallback) });
      await refresh(...names);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendInvitation = async () => {
    if (organizationId === null || busy) return;
    const email = invite.email.trim();
    if (email === "") {
      setInviteError(translate("settings.orgAccess.invite.emailRequired"));
      return;
    }
    setInviteError(null);
    setBusy(true);
    try {
      const result = await api.access.invitations.create({
        organizationId,
        input: { email, role: invite.role },
        idempotencyKey: intentKey(`invite:${email}:${invite.role}`),
      });
      if (result.ok) {
        setInvite({ email: "", role: "developer", open: false });
        setNotice({
          tone: "success",
          text: translate("settings.orgAccess.invite.sent"),
        });
        await refresh("invitations");
      } else {
        setInviteError(
          failure(result.error, "settings.orgAccess.invite.failed"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const saveRole = async () => {
    if (organizationId === null || editing === null) return;
    const target = editing;
    await act(
      () =>
        api.access.members.update({
          organizationId,
          membershipId: target.id,
          input: { role: roleDraft },
          version: target.version,
          idempotencyKey: intentKey(`role:${target.id}:${roleDraft}`),
        }),
      "settings.orgAccess.member.roleSaved",
      "settings.orgAccess.member.roleFailed",
      ["members"],
    ) && setEditing(null);
  };
  const addBinding = async () => {
    if (organizationId === null || editing === null) return;
    if (bindingDraft.scopeId === "") {
      setNotice({
        tone: "error",
        text: translate("settings.orgAccess.binding.scopeRequired"),
      });
      return;
    }
    const target = editing;
    await act(
      () =>
        api.access.bindings.create({
          organizationId,
          input: {
            principalId: target.principalId,
            roleKey: bindingDraft.role,
            scopeType: bindingDraft.type,
            scopeId: bindingDraft.scopeId,
          },
          idempotencyKey: intentKey(
            `bind:${target.id}:${bindingDraft.role}:${bindingDraft.scopeId}`,
          ),
        }),
      "settings.orgAccess.binding.added",
      "settings.orgAccess.binding.failed",
      ["bindings"],
    );
  };
  const createAccount = async () => {
    if (organizationId === null) return;
    const name = accountDraft.name.trim();
    if (name === "") {
      setNotice({
        tone: "error",
        text: translate("settings.orgAccess.account.nameRequired"),
      });
      return;
    }
    const ok = await act(
      () =>
        api.access.principals.create({
          organizationId,
          input: {
            displayName: name,
            role: accountDraft.role === "none" ? null : accountDraft.role,
          },
          idempotencyKey: intentKey(
            `account:${name}:${accountDraft.role}`,
          ),
        }),
      "settings.orgAccess.account.created",
      "settings.orgAccess.account.failed",
      ["principals", "members"],
    );
    if (ok) setAccountDraft({ open: false, name: "", role: "developer" });
  };
  const createToken = async () => {
    if (organizationId === null) return;
    const name = tokenDraft.name.trim();
    if (name === "" || tokenDraft.principalId === "") {
      setNotice({
        tone: "error",
        text: translate("settings.orgAccess.token.fieldsRequired"),
      });
      return;
    }
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.access.tokens.create({
        organizationId,
        input: {
          principalId: tokenDraft.principalId,
          name,
          scopes: [tokenDraft.scope],
          expiresAt: new Date(Date.now() + tokenDraft.days * 86_400_000)
            .toISOString(),
        },
        idempotencyKey: intentKey(
          `token:${tokenDraft.principalId}:${name}:${tokenDraft.scope}:${tokenDraft.days}`,
        ),
      });
      if (result.ok) {
        setCreated(result.data);
        setTokenDraft({ ...tokenDraft, open: false, name: "" });
        await refresh("tokens");
      } else {
        setNotice({
          tone: "error",
          text: failure(result.error, "settings.orgAccess.token.failed"),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const runConfirmed = async () => {
    if (confirm === null || organizationId === null) return;
    const action = confirm;
    const ok = await (async () => {
      switch (action.kind) {
        case "removeMember":
          return await act(
            () =>
              api.access.members.remove({
                organizationId,
                membershipId: action.membership.id,
                version: action.membership.version,
                idempotencyKey: intentKey(`remove:${action.membership.id}`),
              }),
            "settings.orgAccess.member.removed",
            "settings.orgAccess.member.removeFailed",
            ["members", "bindings", "principals"],
          );
        case "cancelInvitation":
          return await act(
            () =>
              api.access.invitations.cancel({
                organizationId,
                invitationId: action.invitation.id,
                idempotencyKey: intentKey(`cancel:${action.invitation.id}`),
              }),
            "settings.orgAccess.invitation.canceled",
            "settings.orgAccess.invitation.cancelFailed",
            ["invitations"],
          );
        case "revokeToken":
          return await act(
            () =>
              api.access.tokens.revoke({
                organizationId,
                tokenId: action.token.id,
                version: action.token.version,
                idempotencyKey: intentKey(`revoke:${action.token.id}`),
              }),
            "settings.orgAccess.token.revoked",
            "settings.orgAccess.token.revokeFailed",
            ["tokens"],
          );
        case "removeBinding":
          return await act(
            () =>
              api.access.bindings.delete({
                organizationId,
                bindingId: action.binding.id,
                version: action.binding.version,
                idempotencyKey: intentKey(`unbind:${action.binding.id}`),
              }),
            "settings.orgAccess.binding.removed",
            "settings.orgAccess.binding.removeFailed",
            ["bindings"],
          );
        case "revokeClient":
          return await act(
            async () => {
              const result = await api.connectedClients.revoke(action.id);
              await queryClient.invalidateQueries({
                queryKey: connectedClientsListQueryOptions(api, scoped)
                  .queryKey,
              });
              return result;
            },
            "settings.orgAccess.client.revoked",
            "settings.orgAccess.client.revokeFailed",
            [],
          );
      }
    })();
    if (ok) {
      setConfirm(null);
      if (action.kind === "removeMember") setEditing(null);
    } else setConfirm(null);
  };

  // --- derived view -------------------------------------------------------
  const loadFailures = [
    members,
    invitations,
    principals,
    tokens,
    bindings,
    applications,
    repositories,
  ].filter((query) => query.isError);
  // Connected clients decide between the empty card and the sections, so an
  // admin's page waits for them too instead of flashing the empty card.
  const loading = organizationId === null ? restoring : access.isPending ||
    (isAdmin && (members.isPending || invitations.isPending ||
      principals.isPending || tokens.isPending || bindings.isPending ||
      clients.isPending));
  const forbidden = !loading && organizationId !== null &&
    (access.isError || (access.data !== undefined && !isAdmin));
  const pendingInvitations = (invitations.data?.items ?? []).filter((item) =>
    item.status === "pending"
  );
  const memberItems = members.data?.items ?? [];
  const humans = memberItems.filter((item) =>
    people.get(item.principalId)?.principalType !== "service"
  );
  const serviceAccounts = (principals.data?.items ?? []).filter((item) =>
    item.principalType === "service"
  );
  const liveTokens = (tokens.data?.items ?? []).filter((item) =>
    item.revokedAt === null
  );
  const myClients = (clients.data?.items ?? []).filter((item) =>
    item.organizationId === organizationId
  );
  // The empty card replaces every section, so it only shows when no section
  // has anything to manage: no other person, invitation, service account,
  // token or connected client, and no failed client read to report.
  const onlyYou = humans.length <= 1 && pendingInvitations.length === 0 &&
    serviceAccounts.length === 0 && liveTokens.length === 0 &&
    myClients.length === 0 && !clients.isError;
  const bindingsOf = (principalId: string) =>
    (bindings.data?.items ?? []).filter((item) =>
      item.principalId === principalId
    );
  const roleLabel = (role: string | null) =>
    role === null
      ? translate("settings.orgAccess.role.none")
      : ROLE_KEYS[role as Role]
      ? translate(ROLE_KEYS[role as Role])
      : role;
  const organizationName = organization.data?.name ?? "";

  const reloadAll = () => {
    void access.refetch();
    for (
      const query of [
        members,
        invitations,
        principals,
        tokens,
        bindings,
        applications,
        repositories,
      ]
    ) void query.refetch();
  };

  const confirmCopy = (() => {
    if (confirm === null) return null;
    switch (confirm.kind) {
      case "removeMember":
        return {
          title: translate("settings.orgAccess.confirm.removeMember.title", {
            name: confirm.name,
          }),
          body: translate("settings.orgAccess.confirm.removeMember.body"),
          action: translate("settings.orgAccess.member.remove"),
        };
      case "cancelInvitation":
        return {
          title: translate(
            "settings.orgAccess.confirm.cancelInvitation.title",
            {
              email: confirm.invitation.email,
            },
          ),
          body: translate("settings.orgAccess.confirm.cancelInvitation.body"),
          action: translate("settings.orgAccess.invitation.cancel"),
        };
      case "revokeToken":
        return {
          title: translate("settings.orgAccess.confirm.revokeToken.title", {
            name: confirm.token.name,
          }),
          body: translate("settings.orgAccess.confirm.revokeToken.body"),
          action: translate("settings.orgAccess.token.revoke"),
        };
      case "removeBinding":
        return {
          title: translate("settings.orgAccess.confirm.removeBinding.title", {
            name: confirm.name,
          }),
          body: translate("settings.orgAccess.confirm.removeBinding.body"),
          action: translate("settings.orgAccess.binding.remove"),
        };
      case "revokeClient":
        return {
          title: translate("settings.orgAccess.confirm.revokeClient.title", {
            name: confirm.name,
          }),
          body: translate("settings.orgAccess.confirm.revokeClient.body"),
          action: translate("settings.orgAccess.client.revoke"),
        };
    }
  })();

  const resourceOptions = (type: ScopeType) =>
    (type === "application"
      ? applications.data?.items ?? []
      : repositories.data?.items ?? []).map((item) => ({
        value: item.id,
        label: item.name,
      }));

  const editBindings = editing === null ? [] : bindingsOf(editing.principalId);

  const showSections = !loading && !forbidden && loadFailures.length === 0 &&
    isAdmin;
  const pageState = loading
    ? "loading"
    : forbidden
    ? "default"
    : loadFailures.length > 0
    ? "error"
    : showSections && onlyYou
    ? "empty"
    : "default";
  const scopeText = (type: string, role: string) =>
    `${translate(SCOPE_TYPE_KEYS[type as ScopeType])} · ${roleLabel(role)}`;
  const organizationText = (role: string | null, inactive: boolean) =>
    `${translate("settings.orgAccess.scope.organization")} · ${
      roleLabel(role)
    }${
      inactive ? ` · ${translate("settings.orgAccess.member.inactive")}` : ""
    }`;
  const removeBindingButton = (binding: AccessBindingRecord) => (
    <UI.Button
      aria-label={`${translate("settings.orgAccess.binding.remove")} ${
        resourceName(binding.scopeType, binding.scopeId)
      }`}
      onClick={() =>
        setConfirm({
          kind: "removeBinding",
          binding,
          name: resourceName(binding.scopeType, binding.scopeId),
        })}
      type="button"
      variant="text"
    >
      {translate("settings.orgAccess.binding.remove")}
    </UI.Button>
  );
  /**
   * A person with no organization-wide role (a guest) is shown by what a scope
   * grants them: their first scoped role is the row, the rest follow it.
   */
  const memberRows: UI.AccessSettingsRow[] = humans.flatMap((membership) => {
    const name = nameOf(membership.principalId);
    const own = bindingsOf(membership.principalId);
    const scopedOnly = membership.role === "guest" && own.length > 0;
    const lead = scopedOnly ? own[0] : null;
    const rest = scopedOnly ? own.slice(1) : own;
    const rows: UI.AccessSettingsRow[] = [{
      id: membership.id,
      testId: `org-access-member-${membership.id}`,
      identity: name,
      emphasis: true,
      cells: lead
        ? [
          scopeText(lead.scopeType, lead.roleKey),
          resourceName(lead.scopeType, lead.scopeId),
        ]
        : [
          organizationText(membership.role, membership.status === "inactive"),
          membership.role === "guest"
            ? translate("settings.orgAccess.scope.guestOnly")
            : translate("settings.orgAccess.scope.all"),
        ],
      // Paper's phone rows read "Organization · Admin": an organization-wide
      // role's reach is implied there, so a phone keeps "All applications"
      // for assistive technology only. A scoped row keeps its resource, and a
      // guest keeps the note that only a scope grants anything.
      phoneHiddenCells: lead || membership.role === "guest" ? undefined : [1],
      action: (
        <UI.Button
          aria-label={translate("settings.orgAccess.member.editNamed", {
            name,
          })}
          data-testid={`org-access-edit-${membership.id}`}
          onClick={() => {
            setNotice(null);
            setEditing(membership);
            setRoleDraft(membership.role as Role);
            setBindingDraft({
              role: "viewer",
              type: "application",
              scopeId: "",
            });
          }}
          type="button"
          variant="text"
        >
          {translate("settings.orgAccess.member.edit")}
        </UI.Button>
      ),
    }];
    for (const binding of rest) {
      rows.push({
        id: binding.id,
        testId: `org-access-binding-${binding.id}`,
        identity: <UI.VisuallyHidden>{name}</UI.VisuallyHidden>,
        cells: [
          scopeText(binding.scopeType, binding.roleKey),
          resourceName(binding.scopeType, binding.scopeId),
        ],
        action: removeBindingButton(binding),
        actionTone: "destructive",
      });
    }
    return rows;
  });
  const invitationRows: UI.AccessSettingsRow[] = pendingInvitations.map((
    invitation,
  ) => ({
    id: invitation.id,
    testId: `org-access-invitation-${invitation.id}`,
    identity: invitation.email,
    cells: [
      `${translate("settings.orgAccess.scope.organization")} · ${
        roleLabel(invitation.role)
      }`,
      translate("settings.orgAccess.invitation.expires", {
        date: whenShort.format(new Date(invitation.expiresAt)),
      }),
    ],
    action: (
      <UI.Button
        aria-label={`${
          translate("settings.orgAccess.invitation.cancel")
        } ${invitation.email}`}
        data-testid={`org-access-cancel-${invitation.id}`}
        onClick={() => setConfirm({ kind: "cancelInvitation", invitation })}
        type="button"
        variant="text"
      >
        {translate("settings.orgAccess.invitation.cancel")}
      </UI.Button>
    ),
    actionTone: "destructive",
  }));
  const accountRows: UI.AccessSettingsRow[] = serviceAccounts.flatMap(
    (account) => {
      const membership = memberItems.find((item) =>
        item.principalId === account.id
      );
      const mine = liveTokens.filter((token) =>
        token.principalId === account.id
      );
      const own = bindingsOf(account.id);
      const role = membership?.role ?? null;
      const scopedOnly = (role === null || role === "guest") &&
        own.length > 0;
      const inactive = account.disabledAt !== null;
      const grant = scopedOnly
        ? scopeText(own[0].scopeType, own[0].roleKey)
        : organizationText(role, inactive);
      const resources = (scopedOnly ? own : []).map((binding) =>
        resourceName(binding.scopeType, binding.scopeId)
      ).join(", ");
      const grantCell = (
        <span title={resources || undefined}>
          {grant}
          {resources
            ? <UI.VisuallyHidden>{` · ${resources}`}</UI.VisuallyHidden>
            : null}
        </span>
      );
      const named = (
        <span data-testid={`org-access-account-${account.id}`}>
          {account.displayName}
        </span>
      );
      if (mine.length === 0) {
        return [{
          id: account.id,
          identity: named,
          emphasis: true,
          cells: [grantCell, translate("settings.orgAccess.token.none")],
        }];
      }
      return mine.map((token, index) => ({
        id: token.id,
        testId: `org-access-token-${token.id}`,
        identity: index === 0
          ? named
          : <UI.VisuallyHidden>{account.displayName}</UI.VisuallyHidden>,
        emphasis: true,
        cells: [
          index === 0 ? grantCell : "",
          <span
            key="prefix"
            title={`${
              token.scopes.map((scopeName) =>
                TOKEN_SCOPE_KEYS[scopeName]
                  ? translate(TOKEN_SCOPE_KEYS[scopeName])
                  : scopeName
              ).join(", ")
            } · ${
              translate("settings.orgAccess.token.expiresOn", {
                date: when.format(new Date(token.expiresAt)),
              })
            }`}
          >
            <code>{token.prefix}</code>
            <UI.VisuallyHidden>
              {` · ${
                token.scopes.map((scopeName) =>
                  TOKEN_SCOPE_KEYS[scopeName]
                    ? translate(TOKEN_SCOPE_KEYS[scopeName])
                    : scopeName
                ).join(", ")
              } · ${
                translate("settings.orgAccess.token.expiresOn", {
                  date: when.format(new Date(token.expiresAt)),
                })
              }`}
            </UI.VisuallyHidden>
          </span>,
        ],
        phoneHiddenCells: [0],
        action: (
          <UI.Button
            aria-label={`${
              translate("settings.orgAccess.token.revoke")
            } ${token.name}`}
            data-testid={`org-access-revoke-${token.id}`}
            onClick={() => setConfirm({ kind: "revokeToken", token })}
            type="button"
            variant="text"
          >
            {translate("settings.orgAccess.token.revoke")}
          </UI.Button>
        ),
        actionTone: "destructive" as const,
      }));
    },
  );
  const clientRows: UI.AccessSettingsRow[] = myClients.map((client) => ({
    id: client.id,
    identity: client.clientName,
    cells: [
      translate("settings.orgAccess.clients.authorized", {
        date: when.format(new Date(client.authorizedAt)),
      }),
    ],
    action: (
      <UI.Button
        aria-label={`${
          translate("settings.orgAccess.client.revoke")
        } ${client.clientName}`}
        onClick={() =>
          setConfirm({
            kind: "revokeClient",
            id: client.id,
            name: client.clientName,
          })}
        type="button"
        variant="text"
      >
        {translate("settings.orgAccess.client.revoke")}
      </UI.Button>
    ),
    actionTone: "destructive",
  }));

  const accountForm = accountDraft.open
    ? (
      <form
        aria-label={translate("settings.orgAccess.account.new")}
        data-testid="org-access-account-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createAccount();
        }}
      >
        <UI.Field
          htmlFor="org-access-account-name"
          label={translate("settings.orgAccess.account.name")}
        >
          <UI.TextInput
            autoComplete="off"
            id="org-access-account-name"
            name="name"
            onChange={(name) =>
              setAccountDraft((value) => ({ ...value, name }))}
            type="text"
            value={accountDraft.name}
          />
        </UI.Field>
        <UI.Combobox
          label={translate("settings.orgAccess.account.role")}
          onChange={(event) =>
            setAccountDraft((value) => ({
              ...value,
              role: event.target.value as Role | "none",
            }))}
          options={[
            ...ROLES.map((role) => ({
              value: role,
              label: translate(ROLE_KEYS[role]),
            })),
            {
              value: "none",
              label: translate("settings.orgAccess.role.none"),
            },
          ]}
          value={accountDraft.role}
        />
        <UI.Button loading={busy} type="submit">
          {translate("settings.orgAccess.account.create")}
        </UI.Button>
      </form>
    )
    : null;
  const tokenForm = tokenDraft.open
    ? (
      <form
        aria-label={translate("settings.orgAccess.token.new")}
        data-testid="org-access-token-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createToken();
        }}
      >
        <UI.Combobox
          label={translate("settings.orgAccess.token.account")}
          onChange={(event) =>
            setTokenDraft((value) => ({
              ...value,
              principalId: event.target.value,
            }))}
          options={serviceAccounts.map((item) => ({
            value: item.id,
            label: item.displayName,
          }))}
          value={tokenDraft.principalId}
        />
        <UI.Field
          htmlFor="org-access-token-name"
          label={translate("settings.orgAccess.token.name")}
        >
          <UI.TextInput
            autoComplete="off"
            id="org-access-token-name"
            name="tokenName"
            onChange={(name) => setTokenDraft((value) => ({ ...value, name }))}
            type="text"
            value={tokenDraft.name}
          />
        </UI.Field>
        <UI.Combobox
          label={translate("settings.orgAccess.token.scope")}
          onChange={(event) =>
            setTokenDraft((value) => ({
              ...value,
              scope: event.target.value,
            }))}
          options={TOKEN_SCOPES.map((value) => ({
            value,
            label: translate(TOKEN_SCOPE_KEYS[value]),
          }))}
          value={tokenDraft.scope}
        />
        <UI.Combobox
          label={translate("settings.orgAccess.token.expires")}
          onChange={(event) =>
            setTokenDraft((value) => ({
              ...value,
              days: Number(event.target.value),
            }))}
          options={TOKEN_DAYS.map((days) => ({
            value: String(days),
            label: translate("settings.orgAccess.token.days", { days }),
          }))}
          value={String(tokenDraft.days)}
        />
        <UI.Button
          data-testid="org-access-token-create"
          loading={busy}
          type="submit"
        >
          {translate("settings.orgAccess.token.create")}
        </UI.Button>
      </form>
    )
    : null;
  const inviteForm = invite.open
    ? (
      <form
        aria-label={translate("settings.orgAccess.invite.title")}
        data-testid="org-access-invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          void sendInvitation();
        }}
      >
        <UI.Heading level="section">
          {translate("settings.orgAccess.invite.title")}
        </UI.Heading>
        <UI.Field
          htmlFor="org-access-invite-email"
          label={translate("settings.orgAccess.invite.email")}
          error={inviteError ?? undefined}
          state={inviteError ? "invalid" : "default"}
        >
          <UI.TextInput
            autoComplete="off"
            id="org-access-invite-email"
            invalid={inviteError !== null}
            name="email"
            onChange={(email) => setInvite((value) => ({ ...value, email }))}
            type="email"
            value={invite.email}
          />
        </UI.Field>
        <UI.Combobox
          label={translate("settings.orgAccess.invite.role")}
          onChange={(event) =>
            setInvite((value) => ({
              ...value,
              role: event.target.value as Role,
            }))}
          options={ROLES.map((role) => ({
            value: role,
            label: translate(ROLE_KEYS[role]),
          }))}
          value={invite.role}
        />
        <UI.Button
          data-testid="org-access-invite-send"
          loading={busy}
          type="submit"
        >
          {translate("settings.orgAccess.invite.send")}
        </UI.Button>
      </form>
    )
    : null;
  const inviteAction = (
    <UI.Button
      data-testid="org-access-invite"
      onClick={() => setInvite((value) => ({ ...value, open: !value.open }))}
      type="button"
    >
      {translate("settings.orgAccess.invite.action")}
    </UI.Button>
  );

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("shell.states.settingsTitle") },
            { label: translate("settings.orgAccess.title") },
          ]}
        />
      </ShellSlot>
      <UI.AccessSettings
        data-testid="org-access"
        title={translate("settings.orgAccess.title")}
        description={pageState === "default"
          ? translate("settings.orgAccess.description", {
            organization: organizationName,
          })
          : undefined}
        summary={showSections && pageState === "default"
          ? translate("settings.orgAccess.summary", {
            people: humans.length + pendingInvitations.length,
            pending: pendingInvitations.length,
          })
          : undefined}
        actions={showSections ? inviteAction : null}
        hideActionsOnPhone={pageState === "empty"}
        state={pageState}
        status={pageState === "loading"
          ? {
            testId: "org-access-loading",
            label: translate("settings.orgAccess.loading"),
          }
          : pageState === "error"
          ? {
            testId: "org-access-error",
            title: members.isError
              ? translate("settings.orgAccess.error.membersTitle")
              : translate("settings.orgAccess.error.title"),
            description: members.isError
              ? translate("settings.orgAccess.error.membersDescription")
              : translate("settings.orgAccess.error.description"),
            descriptionShort: members.isError
              ? translate("settings.orgAccess.error.membersShort")
              : undefined,
            action: (
              <UI.Button onClick={reloadAll} type="button">
                {translate("settings.orgAccess.error.retry")}
              </UI.Button>
            ),
          }
          : {
            testId: "org-access-empty",
            title: translate("settings.orgAccess.empty.title"),
            description: translate("settings.orgAccess.empty.description"),
            descriptionShort: translate("settings.orgAccess.empty.short"),
            // The card hides the accounts section, so it also offers the first
            // service account (and through it a token) to a lone admin.
            action: (
              <UI.Inline>
                <UI.Button
                  data-testid="org-access-invite-first"
                  onClick={() =>
                    setInvite((value) => ({ ...value, open: !value.open }))}
                  type="button"
                >
                  {translate("settings.orgAccess.empty.action")}
                </UI.Button>
                <UI.Button
                  data-testid="org-access-new-account-first"
                  onClick={() =>
                    setAccountDraft((value) => ({
                      ...value,
                      open: !value.open,
                    }))}
                  type="button"
                  variant="text"
                >
                  {translate("settings.orgAccess.account.new")}
                </UI.Button>
              </UI.Inline>
            ),
          }}
        notice={
          <>
            {forbidden
              ? (
                <UI.AlertBanner
                  tone="warning"
                  data-testid="org-access-forbidden"
                >
                  {translate("settings.orgAccess.forbidden")}
                </UI.AlertBanner>
              )
              : null}
            {notice && editing === null
              ? (
                <UI.AlertBanner
                  data-testid="org-access-notice"
                  tone={notice.tone}
                  onDismiss={() => setNotice(null)}
                >
                  {notice.text}
                </UI.AlertBanner>
              )
              : null}
          </>
        }
        sections={showSections
          ? [{
            id: "org-access-members",
            testId: "org-access-members",
            title: translate("settings.orgAccess.members.heading"),
            titleDetail: translate("settings.orgAccess.members.count", {
              count: humans.length + pendingInvitations.length,
            }),
            aside: translate("settings.orgAccess.members.pending", {
              count: pendingInvitations.length,
            }),
            phoneLayout: "overlay",
            rows: memberRows,
            children: inviteForm,
          }, {
            id: "org-access-invitations",
            testId: "org-access-invitations",
            title: translate("settings.orgAccess.invitations.title"),
            phoneLayout: "stacked",
            rows: invitationRows,
            empty: translate("settings.orgAccess.invitations.none"),
          }, {
            id: "org-access-accounts",
            testId: "org-access-accounts",
            title: translate("settings.orgAccess.accounts.title"),
            phoneLayout: "inline",
            actions: (
              <>
                <UI.Button
                  data-testid="org-access-new-account"
                  onClick={() =>
                    setAccountDraft((value) => ({
                      ...value,
                      open: !value.open,
                    }))}
                  type="button"
                  variant="text"
                >
                  {translate("settings.orgAccess.account.new")}
                </UI.Button>
                <UI.Button
                  data-testid="org-access-new-token-action"
                  disabled={serviceAccounts.length === 0}
                  onClick={() =>
                    setTokenDraft((value) => ({
                      ...value,
                      open: !value.open,
                      principalId: value.principalId ||
                        serviceAccounts[0]?.id || "",
                    }))}
                  type="button"
                  variant="text"
                >
                  {translate("settings.orgAccess.token.new")}
                </UI.Button>
              </>
            ),
            rows: accountRows,
            empty: translate("settings.orgAccess.accounts.none"),
            callout: created
              ? {
                testId: "org-access-new-token",
                text: translate("settings.orgAccess.token.shownOnce"),
                textShort: translate("settings.orgAccess.token.shownOnceShort"),
                value: (
                  <span data-testid="org-access-token-secret">
                    {created.secret}
                  </span>
                ),
                onDismiss: () => setCreated(null),
                dismissLabel: translate("settings.orgAccess.dismiss"),
              }
              : undefined,
            children: (
              <>
                {accountForm}
                {tokenForm}
              </>
            ),
          }, {
            id: "org-access-clients",
            testId: "org-access-clients",
            title: translate("settings.orgAccess.clients.title"),
            columns: "detail",
            phoneLayout: "stacked",
            rows: clientRows,
            empty: clients.isError
              ? translate("settings.orgAccess.clients.error")
              : translate("settings.orgAccess.clients.none"),
          }]
          : []}
      >
        {pageState === "empty"
          ? (
            <>
              {inviteForm}
              {accountForm}
            </>
          )
          : null}
      </UI.AccessSettings>

      <UI.Dialog
        data-testid="org-access-edit-dialog"
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        open={editing !== null}
        state={busy ? "submitting" : "open"}
        title={editing === null
          ? ""
          : translate("settings.orgAccess.member.editTitle", {
            name: nameOf(editing.principalId),
          })}
        variant="form"
      >
        {editing === null ? null : (
          <>
            {notice
              ? (
                <UI.AlertBanner
                  data-testid="org-access-notice"
                  tone={notice.tone}
                  onDismiss={() => setNotice(null)}
                >
                  {notice.text}
                </UI.AlertBanner>
              )
              : null}
            <UI.Combobox
              label={translate("settings.orgAccess.member.role")}
              onChange={(event) => setRoleDraft(event.target.value as Role)}
              options={ROLES.map((role) => ({
                value: role,
                label: translate(ROLE_KEYS[role]),
              }))}
              value={roleDraft}
            />
            <UI.Button
              data-testid="org-access-role-save"
              disabled={roleDraft === editing.role}
              loading={busy}
              onClick={() => void saveRole()}
              type="button"
            >
              {translate("settings.orgAccess.member.saveRole")}
            </UI.Button>
            <UI.Heading level="section">
              {translate("settings.orgAccess.binding.title")}
            </UI.Heading>
            <UI.Text variant="muted">
              {translate("settings.orgAccess.binding.help")}
            </UI.Text>
            {editBindings.map((binding) => (
              <UI.Inline
                data-testid={`org-access-edit-binding-${binding.id}`}
                key={binding.id}
              >
                <UI.Text>
                  {`${
                    translate(SCOPE_TYPE_KEYS[binding.scopeType as ScopeType])
                  } · ${roleLabel(binding.roleKey)} · ${
                    resourceName(binding.scopeType, binding.scopeId)
                  }`}
                </UI.Text>
                <UI.Button
                  aria-label={`${
                    translate("settings.orgAccess.binding.remove")
                  } ${resourceName(binding.scopeType, binding.scopeId)}`}
                  onClick={() =>
                    setConfirm({
                      kind: "removeBinding",
                      binding,
                      name: resourceName(binding.scopeType, binding.scopeId),
                    })}
                  type="button"
                  variant="destructive-quiet"
                >
                  {translate("settings.orgAccess.binding.remove")}
                </UI.Button>
              </UI.Inline>
            ))}
            <UI.Combobox
              label={translate("settings.orgAccess.binding.role")}
              onChange={(event) =>
                setBindingDraft((value) => ({
                  ...value,
                  role: event.target.value as BindingRole,
                }))}
              options={BINDING_ROLES.map((role) => ({
                value: role,
                label: translate(ROLE_KEYS[role]),
              }))}
              value={bindingDraft.role}
            />
            <UI.Combobox
              label={translate("settings.orgAccess.binding.type")}
              onChange={(event) =>
                setBindingDraft((value) => ({
                  ...value,
                  type: event.target.value as ScopeType,
                  scopeId: "",
                }))}
              options={SCOPE_TYPES.map((type) => ({
                value: type,
                label: translate(SCOPE_TYPE_KEYS[type]),
              }))}
              value={bindingDraft.type}
            />
            <UI.Combobox
              label={translate("settings.orgAccess.binding.resource")}
              onChange={(event) =>
                setBindingDraft((value) => ({
                  ...value,
                  scopeId: event.target.value,
                }))}
              options={[
                {
                  value: "",
                  label: translate("settings.orgAccess.binding.choose"),
                },
                ...resourceOptions(bindingDraft.type),
              ]}
              value={bindingDraft.scopeId}
            />
            <UI.Button
              data-testid="org-access-binding-add"
              loading={busy}
              onClick={() => void addBinding()}
              type="button"
              variant="outline"
            >
              {translate("settings.orgAccess.binding.add")}
            </UI.Button>
            <UI.Divider />
            <UI.Button
              data-testid="org-access-member-remove"
              onClick={() =>
                setConfirm({
                  kind: "removeMember",
                  membership: editing,
                  name: nameOf(editing.principalId),
                })}
              type="button"
              variant="destructive"
            >
              {translate("settings.orgAccess.member.remove")}
            </UI.Button>
          </>
        )}
      </UI.Dialog>

      <UI.AlertDialog
        data-testid="org-access-confirm"
        cancelAction={
          <UI.Button
            onClick={() => setConfirm(null)}
            type="button"
            variant="quiet"
          >
            {translate("settings.orgAccess.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            data-testid="org-access-confirm-action"
            loading={busy}
            onClick={() => void runConfirmed()}
            type="button"
            variant="destructive"
          >
            {confirmCopy?.action ?? ""}
          </UI.Button>
        }
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        open={confirm !== null}
        state={busy ? "confirming" : "open"}
        title={confirmCopy?.title ?? ""}
      >
        {confirmCopy?.body}
      </UI.AlertDialog>
    </>
  );
}
