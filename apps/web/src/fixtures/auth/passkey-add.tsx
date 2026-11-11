import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { focusFirstInvalidField } from "../../app/auth-form.ts";
import type { SecurityFailure } from "../../app/security-failures.ts";
import {
  AddPasskeyScreen,
  type AddPasskeyStep,
  PASSKEY_ADD_PASSWORD_INPUT_ID,
} from "../../screens/AddPasskeyScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import {
  asyncKindFor,
  SAMPLE_PASSKEY_NAME,
  SUITE_IDENTITY,
  useAsyncHost,
  useDelayed,
} from "./security-suite.ts";

type AddPasskeySpecimen = {
  readonly step: AddPasskeyStep;
  readonly name: string;
  readonly failure: SecurityFailure | null;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: a confirmed password moves form -> device prompt -> success
 * (a stand-in for the browser prompt, which fixtures never open); Cancel on
 * the prompt is the `canceled` outcome and "Try again" returns to the form.
 */
function AddPasskeyHost({ spec }: { readonly spec: AddPasskeySpecimen }) {
  const router = useRouter();
  const { async, settle } = useAsyncHost(spec.async);
  const [step, setStep] = useState(spec.step);
  const [failure, setFailure] = useState(spec.failure);
  const [nameDraft, setNameDraft] = useState(spec.name);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [savedName, setSavedName] = useState(spec.name);
  const later = useDelayed();
  return (
    <AddPasskeyScreen
      async={async}
      email={SUITE_IDENTITY.email}
      failure={failure}
      nameDraft={nameDraft}
      onCancel={() => {
        if (step === "prompt") setStep("canceled");
      }}
      manageTo="/__fixtures__/auth/passkeys-enabled"
      onSignOutThenSignIn={() =>
        router.history.push("/__fixtures__/auth/security-hub-default")}
      onNameChange={setNameDraft}
      onPasswordChange={setPasswordDraft}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onSubmit={() => {
        if (passwordDraft === "") {
          setFailure({ kind: "invalidPassword" });
          setTimeout(() =>
            focusFirstInvalidField([
              { id: PASSKEY_ADD_PASSWORD_INPUT_ID, invalid: true },
            ]), 0);
          return;
        }
        setFailure(null);
        setSavedName(nameDraft.trim() || SAMPLE_PASSKEY_NAME);
        setStep("prompt");
        later(() => setStep("success"), 400);
      }}
      onTryAgain={() => {
        setFailure(null);
        setStep("form");
      }}
      passwordDraft={passwordDraft}
      passwordless={false}
      pending={false}
      savedName={savedName}
      step={step}
    />
  );
}

function specimen(overrides: Partial<AddPasskeySpecimen>): () => JSX.Element {
  const spec: AddPasskeySpecimen = {
    step: "form",
    name: SAMPLE_PASSKEY_NAME,
    failure: null,
    async: null,
    ...overrides,
  };
  return () => <AddPasskeyHost spec={spec} />;
}

const LONG_NAME =
  "Alexandria’s work laptop with the built-in fingerprint reader and the external security key kept in the office drawer";

/**
 * Specimens for `/__fixtures__/auth/passkey-add-<state>`: the five V-0
 * `passkey-add` states (`default`, `prompt`, `canceled`, `unsupported`,
 * `success`), a `failed` ceremony, the shared async states and a worst-case
 * passkey name. The prompt holds until its own timer or Cancel resolves it.
 */
export const passkeyAddSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen({}),
  prompt: specimen({ step: "prompt" }),
  canceled: specimen({ step: "canceled" }),
  unsupported: specimen({ step: "unsupported" }),
  failed: specimen({ step: "failed" }),
  success: specimen({ step: "success" }),
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
  "long-copy": specimen({ name: LONG_NAME, step: "success" }),
};
