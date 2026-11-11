import { type JSX, useState } from "react";
import { focusFirstInvalidField } from "../../app/auth-form.ts";
import type { SecurityFailure } from "../../app/security-failures.ts";
import {
  ChangePasswordScreen,
  PASSWORD_CURRENT_INPUT_ID,
  PASSWORD_NEW_INPUT_ID,
} from "../../screens/ChangePasswordScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { asyncKindFor, useAsyncHost, useDelayed } from "./security-suite.ts";

/** The shortest new password the fixture accepts (the configured policy). */
const FIXTURE_MIN_LENGTH = 8;

type PasswordSpecimen = {
  readonly state: "form" | "success";
  readonly pending: boolean;
  readonly failure: SecurityFailure | null;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: validates like the server policy (a short new password is
 * rejected, an empty current one is wrong) and otherwise "saves" after a
 * short delay, so the keyboard path default -> invalid -> success runs
 * without an API.
 */
function PasswordHost({ spec }: { readonly spec: PasswordSpecimen }) {
  const { async, settle } = useAsyncHost(spec.async);
  const [state, setState] = useState(spec.state);
  const [pending, setPending] = useState(spec.pending);
  const [failure, setFailure] = useState(spec.failure);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const later = useDelayed();

  const submit = () => {
    if (pending) return;
    const invalidCurrent = current === "";
    const weakNew = next.length < FIXTURE_MIN_LENGTH;
    if (invalidCurrent || weakNew) {
      setFailure({ kind: invalidCurrent ? "invalidPassword" : "weakPassword" });
      setTimeout(() =>
        focusFirstInvalidField([
          { id: PASSWORD_CURRENT_INPUT_ID, invalid: invalidCurrent },
          { id: PASSWORD_NEW_INPUT_ID, invalid: weakNew },
        ]), 0);
      return;
    }
    setFailure(null);
    setPending(true);
    later(() => {
      setPending(false);
      setState("success");
    });
  };

  return (
    <ChangePasswordScreen
      async={async}
      currentPassword={current}
      failure={failure}
      newPassword={next}
      onCurrentChange={setCurrent}
      onNewChange={setNext}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onSubmit={submit}
      pending={pending}
      state={state}
    />
  );
}

function specimen(overrides: Partial<PasswordSpecimen>): () => JSX.Element {
  const spec: PasswordSpecimen = {
    state: "form",
    pending: false,
    failure: null,
    async: null,
    ...overrides,
  };
  return () => <PasswordHost spec={spec} />;
}

/**
 * Specimens for `/__fixtures__/auth/password-<state>`: the four V-0
 * `password` states (`loading` is the pending submit, as in the artboard),
 * `skeleton` for the page-level loading state, and the shared async states.
 */
export const passwordSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen({}),
  invalid: specimen({ failure: { kind: "weakPassword" } }),
  success: specimen({ state: "success" }),
  loading: specimen({ pending: true }),
  skeleton: specimen({ async: "loading" }),
  ...Object.fromEntries(
    [
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
  "long-copy": specimen({
    failure: {
      kind: "notice",
      messageKey: "shell.states.worstCaseDescription",
      retryAfterSeconds: null,
    },
  }),
};
