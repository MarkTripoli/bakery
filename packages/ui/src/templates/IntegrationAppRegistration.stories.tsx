import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AlertBanner,
  Button,
  CapabilityList,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Field,
  Heading,
  Inline,
  IntegrationAppRegistration,
  type IntegrationAppRegistrationProps,
  PasswordInput,
  SettingsContent,
  Stack,
  Text,
  TextInput,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/IntegrationAppRegistration",
  parameters: {
    catalogId: "template.integrationAppRegistration",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const copy = {
  title: "Integrations",
  description:
    "Connect this installation to GitHub. One GitHub App serves every organization.",
};

const noop = () => {};

type Outcome =
  | "saved"
  | "rejected"
  | "malformed"
  | "stale"
  | "appMismatch"
  | "saving";

const OUTCOME_COPY: Readonly<
  Record<
    Exclude<Outcome, "saving">,
    { tone: "success" | "error"; body: string }
  >
> = {
  saved: {
    tone: "success",
    body: "GitHub confirmed the App. Credentials stored.",
  },
  rejected: {
    tone: "error",
    body:
      "GitHub did not confirm this App ID and client ID with this private key. Nothing was stored. Check the values and paste them again.",
  },
  malformed: {
    tone: "error",
    body:
      "The private key is not an RSA private key in PEM format. Nothing was stored.",
  },
  stale: {
    tone: "error",
    body:
      "The registration changed since this page loaded. Nothing was stored. Review the current App, then paste the credentials again.",
  },
  appMismatch: {
    tone: "error",
    body:
      "A different GitHub App is registered. Only its own credentials can replace the stored ones. Nothing was stored.",
  },
};
const reveal = { show: "Show", hide: "Hide" };

/**
 * The existing-App form the Integrations page renders: write-only secret
 * inputs that start empty and describe a stored secret by revision only.
 */
function ExistingAppForm(
  { mode, outcome }: {
    readonly mode: "register" | "replace";
    readonly outcome?: Outcome;
  },
) {
  const id = (name: string) => `${mode}-${outcome ?? "idle"}-${name}`;
  return (
    <Stack gap="standard">
      <Heading level="section">
        {mode === "register"
          ? "Use an existing GitHub App"
          : "Replace credentials"}
      </Heading>
      <Text variant="muted">
        {mode === "register"
          ? "Already have a GitHub App on github.com? Paste its credentials. Bakery asks GitHub to confirm the App with the private key before storing anything."
          : "Paste a new private key, and any secret you want to replace. Bakery confirms the App with GitHub again before storing anything. Stored values are never shown."}
      </Text>
      {outcome && outcome !== "saving"
        ? (
          <AlertBanner tone={OUTCOME_COPY[outcome].tone}>
            {OUTCOME_COPY[outcome].body}
          </AlertBanner>
        )
        : null}
      <Field
        hint="The number on the App's settings page on GitHub."
        htmlFor={id("app-id")}
        label="App ID"
        required
      >
        <TextInput
          autoComplete="off"
          disabled={outcome === "saving"}
          id={id("app-id")}
          inputMode="numeric"
          name="appId"
          onChange={noop}
          readOnly={mode === "replace"}
          type="text"
          value={mode === "replace" ? "912345" : ""}
        />
      </Field>
      <Field htmlFor={id("client-id")} label="Client ID" required>
        <TextInput
          autoComplete="off"
          id={id("client-id")}
          name="clientId"
          onChange={noop}
          type="text"
          value={mode === "replace" ? "Iv23liPublicClientId" : ""}
        />
      </Field>
      <Field
        hint={mode === "replace"
          ? "Stored (revision 2). Leave empty to keep it."
          : undefined}
        htmlFor={id("client-secret")}
        label="Client secret"
        note={mode === "replace" ? "Optional" : undefined}
        required={mode === "register"}
      >
        <PasswordInput
          autoComplete="new-password"
          id={id("client-secret")}
          name="clientSecret"
          onChange={noop}
          revealLabels={reveal}
          value=""
        />
      </Field>
      <Field
        hint={mode === "replace"
          ? "Stored (revision 1). Paste the key again to confirm the App; it is stored as a new revision."
          : "Paste the whole .pem file GitHub generated, including the BEGIN and END lines."}
        htmlFor={id("private-key")}
        label="Private key"
        required
        variant="textarea"
      >
        <textarea
          id={id("private-key")}
          name="privateKey"
          onChange={noop}
          rows={6}
          spellCheck={false}
          value=""
        />
      </Field>
      <Field
        hint={mode === "replace" ? "Not stored." : undefined}
        htmlFor={id("webhook-secret")}
        label="Webhook secret"
        note="Optional"
      >
        <PasswordInput
          autoComplete="new-password"
          id={id("webhook-secret")}
          name="webhookSecret"
          onChange={noop}
          revealLabels={reveal}
          value=""
        />
      </Field>
      <Inline>
        <Button
          disabled={outcome !== "saving"}
          loading={outcome === "saving"}
          type="submit"
        >
          {outcome === "saving"
            ? "Checking with GitHub"
            : mode === "register"
            ? "Verify and save"
            : "Verify and replace"}
        </Button>
      </Inline>
    </Stack>
  );
}

function Specimen(
  { state, outcome }: {
    readonly state: IntegrationAppRegistrationProps["state"];
    readonly outcome?: Outcome;
  },
) {
  return (
    <SettingsContent>
      <IntegrationAppRegistration
        {...copy}
        notices={state === "loading"
          ? <AlertBanner tone="information">Loading integrations</AlertBanner>
          : state === "forbidden"
          ? (
            <AlertBanner tone="information">
              Only installation administrators can view or change integrations.
            </AlertBanner>
          )
          : state === "error"
          ? (
            <AlertBanner
              action={<Button type="button">Try again</Button>}
              tone="error"
            >
              The GitHub App could not be loaded.
            </AlertBanner>
          )
          : undefined}
        state={state}
      >
        {state === "unregistered"
          ? (
            <EmptyState
              action={<Button type="button">Create GitHub App</Button>}
              description="Create the GitHub App for this installation. GitHub shows its name and permissions and asks you to confirm."
              title="No GitHub App registered"
            />
          )
          : null}
        {state === "unregistered"
          ? <ExistingAppForm mode="register" outcome={outcome} />
          : null}
        {state === "registered"
          ? (
            <>
              <DescriptionList>
                <DescriptionItem
                  description="Bakery Test 912345"
                  title="Name"
                />
                <DescriptionItem description="912345" title="App ID" />
                <DescriptionItem
                  description="bakery-owner (Organization)"
                  title="Owner"
                />
              </DescriptionList>
              <CapabilityList
                aria-label="GitHub App permissions"
                items={[
                  { id: "contents", title: "contents", value: "Write" },
                  { id: "metadata", title: "metadata", value: "Read" },
                ]}
                variant="access"
              />
              <Text variant="muted">
                The client secret, private key and webhook secret are stored
                encrypted and never shown.
              </Text>
              <ExistingAppForm mode="replace" outcome={outcome} />
            </>
          )
          : null}
      </IntegrationAppRegistration>
    </SettingsContent>
  );
}

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      {([
        "unregistered",
        "registered",
        "loading",
        "error",
        "forbidden",
      ] as const).map((state) => <Specimen key={state} state={state} />)}
      <Specimen outcome="rejected" state="unregistered" />
      <Specimen outcome="malformed" state="unregistered" />
      <Specimen outcome="saving" state="unregistered" />
      <Specimen outcome="saved" state="registered" />
      <Specimen outcome="stale" state="registered" />
      <Specimen outcome="appMismatch" state="registered" />
    </Stack>
  ),
};
