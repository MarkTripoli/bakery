import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { focusFirstInvalidField } from "../../app/auth-form.ts";
import type { SecurityFailure } from "../../app/security-failures.ts";
import {
  REAUTH_PASSWORD_INPUT_ID,
  ReauthScreen,
} from "../../screens/ReauthScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import {
  asyncKindFor,
  SUITE_IDENTITY,
  useAsyncHost,
  useDelayed,
} from "./security-suite.ts";

/** The fixture treats this one password as the wrong one. */
export const REAUTH_FIXTURE_WRONG_PASSWORD = "wrong-password";

type ReauthSpecimen = {
  readonly pending: boolean;
  readonly failure: SecurityFailure | null;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: an empty or `wrong-password` entry fails, anything else
 * "confirms" and returns to the saved security hub, the way the real page
 * returns to the page that sent the person here.
 */
function ReauthHost({ spec }: { readonly spec: ReauthSpecimen }) {
  const { async, settle } = useAsyncHost(spec.async);
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(spec.pending);
  const [failure, setFailure] = useState(spec.failure);
  const later = useDelayed();
  return (
    <ReauthScreen
      async={async}
      cancelTo="/__fixtures__/auth/security-hub-default"
      displayName={SUITE_IDENTITY.displayName}
      email={SUITE_IDENTITY.email}
      failure={failure}
      onPasswordChange={setPassword}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onSignOutThenSignIn={() =>
        router.history.push("/__fixtures__/auth/security-hub-default")}
      onSubmit={() => {
        if (pending) return;
        if (password === "" || password === REAUTH_FIXTURE_WRONG_PASSWORD) {
          setFailure({ kind: "invalidPassword" });
          setTimeout(() =>
            focusFirstInvalidField([
              { id: REAUTH_PASSWORD_INPUT_ID, invalid: true },
            ]), 0);
          return;
        }
        setFailure(null);
        setPending(true);
        later(() => {
          setPending(false);
          router.history.push("/__fixtures__/auth/security-hub-saved");
        });
      }}
      password={password}
      pending={pending}
    />
  );
}

function specimen(overrides: Partial<ReauthSpecimen>): () => JSX.Element {
  const spec: ReauthSpecimen = {
    pending: false,
    failure: null,
    async: null,
    ...overrides,
  };
  return () => <ReauthHost spec={spec} />;
}

/**
 * Specimens for `/__fixtures__/auth/reauth-<state>`: the three V-0 `reauth`
 * states (`loading` is the pending confirm, as in the artboard), `skeleton`
 * for the page-level loading state, and the shared async states.
 */
export const reauthSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen({}),
  invalid: specimen({ failure: { kind: "invalidPassword" } }),
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
