import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { SkillResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationsListQueryOptions,
} from "../../api/query.ts";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useSession } from "../../app/session-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { clip, copyName, NAME_LIMIT } from "./copy-workflow.ts";

/**
 * A message that outlives the page change after a copy: the copy's page shows
 * it, not the page the person pressed Make a copy on.
 */
const toastStore = (() => {
  let message: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => message,
    set: (next: string | null) => {
      message = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();

/** Says something on the skill page after an action, until it is dismissed. */
export function sayAboutSkill(message: string): void {
  toastStore.set(message);
}

/** What the last skill action said, with its dismiss. */
export function SkillToast() {
  const message = useSyncExternalStore(toastStore.subscribe, toastStore.get);
  if (message === null) return null;
  return (
    <UI.Toast
      data-testid="skill-toast"
      tone="success"
      onDismiss={() => toastStore.set(null)}
    >
      {message}
    </UI.Toast>
  );
}

type Dialog = "copy" | "rename" | "off" | null;
type Failure =
  | "forbidden"
  | "nameTaken"
  | "nameRejected"
  | "conflict"
  | "offline"
  | "failed";

function failureOf(error: unknown): Failure {
  if (asyncKindForError(error) === "offline") return "offline";
  switch (failureStatus(error)) {
    case 403:
      return "forbidden";
    case 409:
      return "nameTaken";
    case 412:
      return "conflict";
    case 422:
      return "nameRejected";
    default:
      return "failed";
  }
}

/**
 * What a person may do with a skill (design-ux #74, revisions 2 to 4): a skill
 * shared by Bakery can only be copied; the owner of a private skill and an
 * administrator for an organization skill may also rename it and turn it off.
 * Copying is open to anyone who can read it, into their own private skill.
 */
export function useSkillActions(
  skill: SkillResponse,
): { readonly actions: ReactNode; readonly below: ReactNode } {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const offline = useConnectivity() === "offline";
  const identity = useSession().identity;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const organizations = useQuery(organizationsListQueryOptions(api, scope));
  const organizationId = scope.organizationId as string;
  const organizationName =
    organizations.data?.items.find((item) => item.id === organizationId)
      ?.name ?? null;
  const admin = access.data?.role === "admin";
  const canChange = skill.scope === "organization"
    ? admin
    : skill.scope === "personal" &&
      identity?.principalId === skill.ownerPrincipalId;

  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState("");
  const [copyScope, setCopyScope] = useState<"organization" | "personal">(
    admin ? "organization" : "personal",
  );
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // One write keeps its idempotency key until it is answered, so a retry after
  // a lost answer cannot make a second copy.
  const intent = useRef<string | null>(null);
  const key = () => (intent.current ??= crypto.randomUUID());

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  const copy = useMutation({
    mutationKey: ["skills.copy"],
    mutationFn: async (
      input: { name: string; scope: "organization" | "personal" },
    ) => {
      const result = await api.copySkill({
        organizationId,
        id: skill.id,
        ...input,
        idempotencyKey: key(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const update = useMutation({
    mutationKey: ["skills.update"],
    mutationFn: async (input: { name?: string; enabled?: boolean }) => {
      const result = await api.updateSkill({
        organizationId,
        id: skill.id,
        input,
        version: skill.version,
        idempotencyKey: key(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const pending = copy.isPending || update.isPending;

  const open = (next: Exclude<Dialog, null>) => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    intent.current = null;
    setFailure(null);
    setTried(false);
    if (next === "copy") {
      setName(
        copyName(
          skill.name,
          organizationName === null
            ? translate("library.copy.suffix" as never)
            : `(${organizationName})`,
        ),
      );
      setCopyScope(admin ? "organization" : "personal");
    }
    if (next === "rename") setName(skill.name);
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
    focusAfterPaint(() => opener.current);
  };
  const run = async (change: () => Promise<unknown>, done: () => void) => {
    setFailure(null);
    try {
      await change();
      intent.current = null;
      done();
    } catch (error) {
      const next = failureOf(error);
      // A definite refusal did not happen: the next try is a new intent.
      const status = failureStatus(error);
      if (status !== null && status < 500) intent.current = null;
      setFailure(next);
    }
  };

  const empty = name.trim() === "";
  const copyAndGo = async () => {
    setTried(true);
    if (empty) return;
    setFailure(null);
    try {
      const made = await copy.mutateAsync({
        name: name.trim(),
        scope: copyScope,
      });
      intent.current = null;
      toastStore.set(translate("library.skill.copied", { name: made.name }));
      setDialog(null);
      void navigate({
        to: "/library/skills/$skillId",
        params: { skillId: made.id },
      });
    } catch (error) {
      const status = failureStatus(error);
      if (status !== null && status < 500) intent.current = null;
      setFailure(failureOf(error));
    }
  };
  const renameNow = () => {
    setTried(true);
    if (empty || name.trim() === skill.name) return;
    void run(() => update.mutateAsync({ name: name.trim() }), close);
  };

  const failureLine = failure === null || failure === "nameTaken" ||
      failure === "nameRejected"
    ? null
    : (
      <UI.InlineNotice tone="error" role="alert">
        {translate(
          `library.skill.failure.${failure}` as never,
          { name: skill.name },
        )}
      </UI.InlineNotice>
    );
  const nameError = tried && empty
    ? translate("library.skill.nameEmpty")
    : failure === "nameTaken"
    ? translate("library.skill.nameTaken")
    : failure === "nameRejected"
    ? translate("library.skill.nameRejected")
    : undefined;

  const copyButton = (
    <UI.Button
      variant={canChange ? "secondary" : "primary"}
      disabled={offline || pending}
      onClick={() => open("copy")}
    >
      {translate("library.skill.makeCopy")}
    </UI.Button>
  );
  const menuItems = [
    {
      id: "rename",
      label: translate("library.skill.rename"),
      disabled: offline || pending,
    },
    {
      id: "copy",
      label: translate("library.skill.makeCopy"),
      disabled: offline || pending,
    },
    {
      id: skill.enabled ? "off" : "on",
      label: translate(
        skill.enabled ? "library.skill.turnOff" : "library.skill.turnOn",
      ),
      disabled: offline || pending,
    },
  ];
  const more = (
    <UI.Popover
      label={translate("library.skill.moreNamed", { name: skill.name })}
      variant="interactive"
      open={menuOpen}
      onOpenChange={setMenuOpen}
      triggerAppearance="toolbar"
      align="end"
      trigger={translate("library.skill.actions.more")}
    >
      <UI.Menu
        aria-label={translate("library.skill.moreNamed", { name: skill.name })}
        items={menuItems}
        onSelect={(id) => {
          setMenuOpen(false);
          if (id === "rename") open("rename");
          else if (id === "copy") open("copy");
          else if (id === "off") open("off");
          else if (id === "on") {
            void run(
              () => update.mutateAsync({ enabled: true }),
              () =>
                toastStore.set(
                  translate("library.skill.turnedOn", { name: skill.name }),
                ),
            );
          }
        }}
      />
    </UI.Popover>
  );
  const bar = (
    <UI.Inline gap="compact" data-testid="skill-actions">
      {canChange ? more : copyButton}
    </UI.Inline>
  );

  const below = (
    <>
      {skill.scope === "global"
        ? (
          <UI.InlineNotice tone="information" data-testid="skill-shared-note">
            {translate("library.skill.sharedNote")}
          </UI.InlineNotice>
        )
        : null}
      {dialog === null ? failureLine : null}
      {dialog === "copy"
        ? (
          <UI.Dialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={pending ? "submitting" : "open"}
            title={translate("library.skill.copy.title")}
            variant="form"
          >
            <form
              noValidate
              data-testid="skill-copy-form"
              onSubmit={(event) => {
                event.preventDefault();
                void copyAndGo();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Stack
                  gap="tight"
                  role="radiogroup"
                  aria-label={translate("library.skill.copy.who")}
                >
                  <UI.Text variant="strong">
                    {translate("library.skill.copy.who")}
                  </UI.Text>
                  <UI.Stack gap="none">
                    <UI.Radio
                      checked={copyScope === "organization"}
                      disabled={!admin || pending}
                      name="skill-copy-scope"
                      onChange={() => setCopyScope("organization")}
                      value="organization"
                    >
                      {translate("library.skill.scope.organization")}
                    </UI.Radio>
                    <UI.Text variant="hint">
                      {admin
                        ? translate("library.skill.copy.organizationHint", {
                          organization: organizationName ?? "",
                        })
                        : translate(
                          "library.skill.copy.organizationOnlyAdmins",
                        )}
                    </UI.Text>
                  </UI.Stack>
                  <UI.Stack gap="none">
                    <UI.Radio
                      checked={copyScope === "personal"}
                      disabled={pending}
                      name="skill-copy-scope"
                      onChange={() => setCopyScope("personal")}
                      value="personal"
                    >
                      {translate("library.skill.scope.personal")}
                    </UI.Radio>
                    <UI.Text variant="hint">
                      {translate("library.skill.copy.personalHint")}
                    </UI.Text>
                  </UI.Stack>
                </UI.Stack>
                <UI.Field
                  label={translate("library.skill.name")}
                  htmlFor="skill-copy-name"
                  required
                  error={nameError}
                >
                  <UI.TextInput
                    id="skill-copy-name"
                    name="name"
                    type="text"
                    autoComplete="off"
                    value={name}
                    invalid={nameError !== undefined || undefined}
                    onChange={(value) => {
                      setName(clip(value, NAME_LIMIT));
                      if (
                        failure === "nameTaken" || failure === "nameRejected"
                      ) {
                        setFailure(null);
                      }
                    }}
                  />
                </UI.Field>
                {failureLine}
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={pending}
                    onClick={close}
                  >
                    {translate("core.actions.cancel")}
                  </UI.Button>
                  <UI.Button type="submit" variant="primary" disabled={pending}>
                    {translate("library.skill.makeCopy")}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </form>
          </UI.Dialog>
        )
        : null}
      {dialog === "rename"
        ? (
          <UI.Dialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={pending ? "submitting" : "open"}
            title={translate("library.skill.rename")}
            variant="form"
          >
            <form
              noValidate
              data-testid="skill-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                renameNow();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Field
                  label={translate("library.skill.name")}
                  htmlFor="skill-rename-name"
                  hint={translate("library.skill.rename.hint")}
                  required
                  error={nameError}
                >
                  <UI.TextInput
                    id="skill-rename-name"
                    name="name"
                    type="text"
                    autoComplete="off"
                    value={name}
                    invalid={nameError !== undefined || undefined}
                    onChange={(value) => {
                      setName(clip(value, NAME_LIMIT));
                      if (
                        failure === "nameTaken" || failure === "nameRejected"
                      ) {
                        setFailure(null);
                      }
                    }}
                  />
                </UI.Field>
                {failureLine}
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={pending}
                    onClick={close}
                  >
                    {translate("core.actions.cancel")}
                  </UI.Button>
                  <UI.Button type="submit" variant="primary" disabled={pending}>
                    {translate("library.skill.rename")}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </form>
          </UI.Dialog>
        )
        : null}
      {dialog === "off"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={update.isPending ? "confirming" : "open"}
            title={translate("library.skill.turnOff.title", {
              name: skill.name,
            })}
            cancelAction={
              <UI.Button variant="secondary" onClick={close}>
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  void run(() => update.mutateAsync({ enabled: false }), close)}
              >
                {translate("library.skill.turnOff")}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>{translate("library.skill.turnOff.body")}</UI.Text>
              {failureLine}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
  return { actions: bar, below };
}
