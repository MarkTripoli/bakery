import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { focusFirstInvalidField } from "../../app/auth-form.ts";
import type { SecurityFailure } from "../../app/security-failures.ts";
import {
  PASSKEY_REMOVE_PASSWORD_INPUT_ID,
  type PasskeyRow,
  PasskeysScreen,
  type PasskeysView,
} from "../../screens/PasskeysScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  asyncKindFor,
  SAMPLE_PASSKEY_CAPTION,
  SAMPLE_PASSKEY_NAME,
  useAsyncHost,
  useDelayed,
} from "./security-suite.ts";

const SAMPLE_PASSKEY: PasskeyRow = {
  id: "passkey-1",
  name: SAMPLE_PASSKEY_NAME,
  description: SAMPLE_PASSKEY_CAPTION,
};

const LONG_NAME =
  "Alexandria’s work laptop with the built-in fingerprint reader and the external security key kept in the office drawer";

/** Worst case: many passkeys, each with a long name and caption. */
const LONG_COPY_PASSKEYS: readonly PasskeyRow[] = Array.from(
  { length: 6 },
  (_, index) => ({
    id: `passkey-long-${index + 1}`,
    name: `${LONG_NAME} (${index + 1})`,
    description: `Added recently · sample passkey · ${LONG_NAME}`,
  }),
);

type PasskeysSpecimen = {
  readonly passkeys: readonly PasskeyRow[];
  readonly view: PasskeysView;
  readonly failure: SecurityFailure | "failed" | null;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: rename and remove run against local state so the list ->
 * rename -> list and list -> remove -> list paths (focus restoration, live
 * confirmations that name the device) work without an API. A blank password
 * is rejected the way the server would reject a wrong one.
 */
function PasskeysHost({ spec }: { readonly spec: PasskeysSpecimen }) {
  const { translate } = useI18n();
  const router = useRouter();
  const { async, settle } = useAsyncHost(spec.async);
  const [passkeys, setPasskeys] = useState(spec.passkeys);
  const [view, setView] = useState(spec.view);
  const [failure, setFailure] = useState(spec.failure);
  const [notice, setNotice] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(() => {
    const initial = spec.view;
    return initial.kind === "rename"
      ? spec.passkeys.find((p) => p.id === initial.passkeyId)?.name ?? ""
      : "";
  });
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pending, setPending] = useState(false);
  const later = useDelayed();

  const targetId = view.kind === "list" ? null : view.passkeyId;
  const close = () => {
    setView({ kind: "list" });
    setFailure(null);
    setPasswordDraft("");
  };

  return (
    <PasskeysScreen
      async={async}
      failure={failure}
      nameDraft={nameDraft}
      notice={notice}
      addTo="/__fixtures__/auth/passkey-add-default"
      codeDraft=""
      codeKind="totp"
      factorRequired={false}
      onToggleCodeKind={() => {}}
      passwordless={false}
      onCodeChange={() => {}}
      onSignOutThenSignIn={() =>
        router.history.push("/__fixtures__/auth/security-hub-default")}
      onCancel={close}
      onNameChange={setNameDraft}
      onPasswordChange={setPasswordDraft}
      onRefresh={settle}
      onReload={settle}
      onRemove={(passkeyId) => {
        setNotice(null);
        setFailure(null);
        setView({ kind: "remove", passkeyId });
      }}
      onRename={(passkeyId) => {
        setNotice(null);
        setFailure(null);
        setNameDraft(passkeys.find((p) => p.id === passkeyId)?.name ?? "");
        setView({ kind: "rename", passkeyId });
      }}
      onRetry={settle}
      onSubmitRemove={() => {
        if (pending || targetId === null) return;
        if (passwordDraft === "") {
          setFailure({ kind: "invalidPassword" });
          setTimeout(() =>
            focusFirstInvalidField([
              { id: PASSKEY_REMOVE_PASSWORD_INPUT_ID, invalid: true },
            ]), 0);
          return;
        }
        const removed = passkeys.find((p) => p.id === targetId);
        setFailure(null);
        setPending(true);
        later(() => {
          setPending(false);
          setPasskeys((current) => current.filter((p) => p.id !== targetId));
          setNotice(
            translate("passkeys.removed", { name: removed?.name ?? "" }),
          );
          close();
        });
      }}
      onSubmitRename={() => {
        const name = nameDraft.trim();
        if (pending || targetId === null || name === "") return;
        setPending(true);
        later(() => {
          setPending(false);
          setPasskeys((current) =>
            current.map((p) => p.id === targetId ? { ...p, name } : p)
          );
          setNotice(translate("passkeys.renamed", { name }));
          close();
        });
      }}
      passkeys={passkeys}
      passwordDraft={passwordDraft}
      pending={pending}
      view={view}
    />
  );
}

function specimen(overrides: Partial<PasskeysSpecimen>): () => JSX.Element {
  const spec: PasskeysSpecimen = {
    passkeys: [SAMPLE_PASSKEY],
    view: { kind: "list" },
    failure: null,
    async: null,
    ...overrides,
  };
  return () => <PasskeysHost spec={spec} />;
}

const removeView: PasskeysView = {
  kind: "remove",
  passkeyId: SAMPLE_PASSKEY.id,
};

/**
 * Specimens for `/__fixtures__/auth/passkeys-<state>`: the six V-0 `passkeys`
 * states (`default` = none added, `enabled` = the sample passkey, `rename`,
 * `remove`, `blocked` = last sign-in method, `failed`), the shared async
 * states and a worst-case list.
 */
export const passkeysSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen({ passkeys: [] }),
  enabled: specimen({}),
  rename: specimen({ view: { kind: "rename", passkeyId: SAMPLE_PASSKEY.id } }),
  remove: specimen({ view: removeView }),
  blocked: specimen({
    view: removeView,
    failure: { kind: "lastSignInMethod" },
  }),
  failed: specimen({ view: removeView, failure: "failed" }),
  ...Object.fromEntries(
    [
      "loading",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
    ].map((token) => [
      token,
      specimen({ async: asyncKindFor(token) }),
    ]),
  ),
  "long-copy": specimen({ passkeys: LONG_COPY_PASSKEYS }),
};
