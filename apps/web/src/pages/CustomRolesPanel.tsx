import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { catalogActions } from "@bakery/contracts/contracts";
import type { MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import type { ApiFailure, OrganizationRoleItem } from "../api/client.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useIdempotentIntent } from "../app/use-idempotent-intent.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** Every permission key the catalog declares, grouped by resource. */
const PERMISSION_GROUPS: ReadonlyMap<string, readonly string[]> = (() => {
  const keys = [
    ...new Set(
      catalogActions.flatMap((action) =>
        action.permission === null ? [] : [action.permission]
      ),
    ),
  ].sort();
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const resource = key.slice(0, key.indexOf(":"));
    groups.set(resource, [...(groups.get(resource) ?? []), key]);
  }
  return groups;
})();

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

type Editor =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly role: OrganizationRoleItem };

function failureMessage(error: ApiFailure): MessageKey {
  if (error.kind !== "problem") return "settings.roles.error.generic";
  switch (error.problem.code) {
    case "AUTH_FORBIDDEN":
      return "settings.roles.error.exceeds";
    case "STATE_CONFLICT":
    case "VERSION_CONFLICT":
      return "settings.roles.error.conflict";
    case "UNPROCESSABLE":
    case "MALFORMED_REQUEST":
      return "settings.roles.error.invalid";
    default:
      return "settings.roles.error.generic";
  }
}

/**
 * Custom roles of one organization: list, create, edit, delete, and hand a
 * role to (or take it from) a member. The server enforces the permission cap and the last-admin rule; this panel
 * only reports its refusals.
 */
export function CustomRolesPanel({ organizationId, title }: {
  readonly organizationId: string;
  /** The panel's own heading, when the page above already names the page. */
  readonly title?: string;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const scoped = { ...scope, organizationId };
  const rolesKey = protectedQueryKey(scoped, "organizationRoles.list", {});
  const roles = useQuery({
    queryKey: rolesKey,
    queryFn: async ({ signal }) => {
      const result = await api.organizationRoles.list({
        organizationId,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });
  const members = useQuery({
    queryKey: protectedQueryKey(scoped, "principals.list", {}),
    queryFn: async ({ signal }) => {
      const result = await api.principals.list({ organizationId, signal });
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });
  const names = useMemo(
    () =>
      new Map(
        (members.data?.items ?? []).map((
          member,
        ) => [member.id, member.displayName]),
      ),
    [members.data],
  );

  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<
    { readonly tone: "error" | "information"; readonly key: MessageKey } | null
  >(null);
  const [invalid, setInvalid] = useState(false);
  const intent = useIdempotentIntent();

  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  /** One write at a time: a second click while one runs is ignored. */
  const guard = async (run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: rolesKey });
  const report = (failure: ApiFailure) =>
    setNotice({ tone: "error", key: failureMessage(failure) });
  const done = (messageKey: MessageKey) => {
    setNotice({ tone: "information", key: messageKey });
    intent.reset();
    return refresh();
  };

  const open = (next: Editor) => {
    setNotice(null);
    setInvalid(false);
    setEditor(next);
    if (next.mode === "edit") {
      setName(next.role.name);
      setKey(next.role.key);
      setDescription(next.role.description);
      setSelected(new Set(next.role.permissions));
    } else {
      setName("");
      setKey("");
      setDescription("");
      setSelected(new Set());
    }
  };

  const save = () =>
    guard(async () => {
      if (editor === null) return;
      const valid = name.trim() !== "" && selected.size > 0 &&
        (editor.mode === "edit" || KEY_PATTERN.test(key));
      setInvalid(!valid);
      if (!valid) return;
      setNotice(null);
      const permissions = [...selected].sort();
      const result = editor.mode === "create"
        ? await api.organizationRoles.create({
          organizationId,
          input: {
            key,
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            permissions,
          },
          idempotencyKey: intent.keyFor(
            JSON.stringify([key, name, description, permissions]),
          ),
        })
        : await api.organizationRoles.update({
          organizationId,
          id: editor.role.id,
          version: editor.role.version,
          input: {
            name: name.trim(),
            description: description.trim(),
            permissions,
          },
          idempotencyKey: intent.keyFor(
            JSON.stringify([editor.role.id, name, description, permissions]),
          ),
        });
      if (!result.ok) return report(result.error);
      setEditor(null);
      await done("settings.roles.saved");
    });

  const remove = (role: OrganizationRoleItem) =>
    guard(async () => {
      setNotice(null);
      const result = await api.organizationRoles.delete({
        organizationId,
        id: role.id,
        version: role.version,
        idempotencyKey: intent.keyFor(`delete:${role.id}:${role.version}`),
      });
      if (!result.ok) return report(result.error);
      await done("settings.roles.deleted");
    });

  const assign = (role: OrganizationRoleItem) =>
    guard(async () => {
      const principalId = assignTo[role.id];
      if (!principalId) return;
      setNotice(null);
      const result = await api.organizationRoles.assign({
        organizationId,
        id: role.id,
        principalId,
        idempotencyKey: intent.keyFor(`assign:${role.id}:${principalId}`),
      });
      if (!result.ok) return report(result.error);
      setAssignTo((current) => ({ ...current, [role.id]: "" }));
      await done("settings.roles.assigned");
    });

  const unassign = (role: OrganizationRoleItem, principalId: string) =>
    guard(async () => {
      setNotice(null);
      const result = await api.organizationRoles.unassign({
        organizationId,
        id: role.id,
        principalId,
        idempotencyKey: intent.keyFor(`unassign:${role.id}:${principalId}`),
      });
      if (!result.ok) return report(result.error);
      await done("settings.roles.unassigned");
    });

  const items = roles.data?.items ?? [];

  return (
    <UI.SettingsSection
      data-testid="custom-roles"
      title={title ?? translate("settings.roles.title")}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("settings.roles.description")}
      </UI.Text>
      {notice
        ? (
          <UI.AlertBanner tone={notice.tone}>
            {translate(notice.key)}
          </UI.AlertBanner>
        )
        : null}
      {roles.isPending
        ? (
          <UI.Text variant="muted">
            {translate("settings.roles.loading")}
          </UI.Text>
        )
        : roles.isError
        ? (
          <UI.AlertBanner
            tone="error"
            action={
              <UI.Button
                variant="secondary"
                onClick={() => void roles.refetch()}
              >
                {translate("settings.roles.retry")}
              </UI.Button>
            }
          >
            {translate("settings.roles.loadError")}
          </UI.AlertBanner>
        )
        : items.length === 0
        ? (
          <UI.EmptyState
            title={translate("settings.roles.empty.title")}
            description={translate("settings.roles.empty.description")}
          />
        )
        : (
          <ul aria-label={translate("settings.roles.list")}>
            {items.map((role) => {
              const holders = role.memberIds;
              const candidates = [...names].filter(([id]) =>
                !holders.includes(id)
              );
              return (
                <li key={role.id} data-testid={`custom-role-${role.key}`}>
                  <UI.ObjectRow
                    identity={
                      <>
                        <UI.Text>{role.name}</UI.Text>
                        <UI.DataText>{role.key}</UI.DataText>
                      </>
                    }
                    metadata={translate("settings.roles.summary", {
                      permissions: role.permissions.length,
                      members: role.memberCount,
                    })}
                    actions={
                      <UI.Inline gap="compact">
                        <UI.Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => open({ mode: "edit", role })}
                        >
                          {translate("settings.roles.edit")}
                        </UI.Button>
                        <UI.Button
                          variant="destructive"
                          disabled={busy || role.memberCount > 0}
                          onClick={() => void remove(role)}
                        >
                          {translate("settings.roles.delete")}
                        </UI.Button>
                      </UI.Inline>
                    }
                  />
                  {holders.length > 0
                    ? (
                      <ul
                        aria-label={translate("settings.roles.holders", {
                          role: role.name,
                        })}
                      >
                        {holders.map((id) => (
                          <li key={id}>
                            <UI.Inline gap="compact">
                              <UI.Text>
                                {names.get(id) ??
                                  translate("settings.roles.unknownMember")}
                              </UI.Text>
                              <UI.Button
                                variant="quiet"
                                disabled={busy}
                                aria-label={translate(
                                  "settings.roles.unassign",
                                  { member: names.get(id) ?? id },
                                )}
                                onClick={() => void unassign(role, id)}
                              >
                                {translate("settings.roles.unassignAction")}
                              </UI.Button>
                            </UI.Inline>
                          </li>
                        ))}
                      </ul>
                    )
                    : null}
                  {candidates.length > 0
                    ? (
                      <UI.Inline gap="compact">
                        <UI.Combobox
                          label={translate("settings.roles.assign.label", {
                            role: role.name,
                          })}
                          value={assignTo[role.id] ?? ""}
                          onChange={(event) =>
                            setAssignTo((current) => ({
                              ...current,
                              [role.id]: event.target.value,
                            }))}
                          options={[
                            {
                              value: "",
                              label: translate("settings.roles.assign.none"),
                            },
                            ...candidates.map(([id, label]) => ({
                              value: id,
                              label,
                            })),
                          ]}
                        />
                        <UI.Button
                          variant="secondary"
                          disabled={busy || !assignTo[role.id]}
                          onClick={() => void assign(role)}
                        >
                          {translate("settings.roles.assign.action")}
                        </UI.Button>
                      </UI.Inline>
                    )
                    : null}
                </li>
              );
            })}
          </ul>
        )}
      <div>
        {editor === null
          ? (
            <UI.Button
              disabled={busy}
              onClick={() => open({ mode: "create" })}
            >
              {translate("settings.roles.create")}
            </UI.Button>
          )
          : (
            <form
              aria-label={translate(
                editor.mode === "create"
                  ? "settings.roles.create"
                  : "settings.roles.edit",
              )}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <UI.Stack gap="compact">
                <UI.Field
                  htmlFor="custom-role-name"
                  label={translate("settings.roles.field.name")}
                  error={invalid && name.trim() === ""
                    ? translate("settings.roles.error.name")
                    : undefined}
                >
                  <UI.TextInput
                    id="custom-role-name"
                    name="name"
                    type="text"
                    autoComplete="off"
                    value={name}
                    onChange={setName}
                  />
                </UI.Field>
                <UI.Field
                  htmlFor="custom-role-key"
                  label={translate("settings.roles.field.key")}
                  hint={translate("settings.roles.field.keyHint")}
                  error={invalid && editor.mode === "create" &&
                      !KEY_PATTERN.test(key)
                    ? translate("settings.roles.error.key")
                    : undefined}
                >
                  <UI.TextInput
                    id="custom-role-key"
                    name="key"
                    type="text"
                    autoComplete="off"
                    readOnly={editor.mode === "edit"}
                    value={key}
                    onChange={setKey}
                  />
                </UI.Field>
                <UI.Field
                  htmlFor="custom-role-description"
                  label={translate("settings.roles.field.description")}
                >
                  <UI.TextInput
                    id="custom-role-description"
                    name="description"
                    type="text"
                    autoComplete="off"
                    value={description}
                    onChange={setDescription}
                  />
                </UI.Field>
                <fieldset data-testid="custom-role-permissions">
                  <legend>
                    {translate("settings.roles.field.permissions")}
                  </legend>
                  {invalid && selected.size === 0
                    ? (
                      <UI.Text variant="hint">
                        {translate("settings.roles.error.permissions")}
                      </UI.Text>
                    )
                    : null}
                  {[...PERMISSION_GROUPS].map(([resource, keys]) => (
                    <fieldset key={resource}>
                      <legend>{resource}</legend>
                      {keys.map((permission) => (
                        <UI.Checkbox
                          key={permission}
                          checked={selected.has(permission)}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(permission);
                              else next.delete(permission);
                              return next;
                            })}
                        >
                          {permission}
                        </UI.Checkbox>
                      ))}
                    </fieldset>
                  ))}
                </fieldset>
                <UI.Inline gap="compact">
                  <UI.Button type="submit" loading={busy}>
                    {translate("settings.roles.save")}
                  </UI.Button>
                  <UI.Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setEditor(null)}
                  >
                    {translate("settings.roles.cancel")}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </form>
          )}
      </div>
    </UI.SettingsSection>
  );
}
