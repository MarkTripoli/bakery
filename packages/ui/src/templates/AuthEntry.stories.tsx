import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/AuthEntry",
  parameters: { catalogId: "template.authEntry", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const revealLabels = { hide: "Hide password", show: "Show password" };

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual AuthEntry specimen exposes clipping, wrapping, and overflow defects. !!]";

const STEPS: readonly UI.AuthEntryStep[] = [
  { icon: "idea", label: "Start with an idea" },
  { icon: "activity", label: "Watch your agents work" },
  { icon: "batch", label: "Ship the next batch" },
];

/** Matches the Paper `login--github-disabled--light` artboard (auth.js:142). */
function BrandSignIn({ pseudo }: { pseudo: boolean }) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <UI.AuthEntry
      footer="Your software, made together."
      status={pseudo
        ? <span data-testid="text-specimen-copy">{PSEUDO_COPY}</span>
        : undefined}
      steps={STEPS}
      tagline={
        <>
          Fresh commits,
          <br />
          coming right up.
        </>
      }
      themeToggle={<UI.ThemeToggle label="Switch theme" />}
      variant="brand"
    >
      <UI.Heading level="page">Welcome back</UI.Heading>
      <UI.Text>Sign in to your Bakery account.</UI.Text>
      <UI.Field htmlFor={emailId} label="Email">
        <UI.TextInput
          autoComplete="email"
          disabled={false}
          id={emailId}
          invalid={false}
          name="email"
          onChange={setEmail}
          readOnly={false}
          required
          type="email"
          value={email}
        />
      </UI.Field>
      <UI.Field htmlFor={passwordId} label="Password">
        <UI.PasswordInput
          autoComplete="current-password"
          disabled={false}
          id={passwordId}
          invalid={false}
          name="password"
          onChange={setPassword}
          readOnly={false}
          required
          revealLabels={revealLabels}
          value={password}
        />
      </UI.Field>
      <UI.Link href="#forgot-password" variant="quiet">
        Forgot password?
      </UI.Link>
      <UI.Button type="submit" variant="primary">Sign in</UI.Button>
      <UI.Text>
        New to Bakery?{" "}
        <UI.Link href="#join">Join through an invitation.</UI.Link>
      </UI.Text>
    </UI.AuthEntry>
  );
}

/** Matches the Paper `invite--default--light` context card (auth.js:149). */
function ContextInvitation() {
  return (
    <UI.AuthEntry
      context={
        <UI.Stack gap="compact">
          <UI.Text>Bakery workspace</UI.Text>
          <UI.StatusLabel status="active">Developer</UI.StatusLabel>
          <UI.Text>Invited by Alex</UI.Text>
        </UI.Stack>
      }
      tagline="Join the Bakery workspace."
      variant="context"
    >
      <UI.Heading level="page">Accept the invitation</UI.Heading>
      <UI.Button type="button" variant="primary">Accept invitation</UI.Button>
      <UI.Button type="button" variant="secondary">Decline</UI.Button>
    </UI.AuthEntry>
  );
}

export const Contract: StoryObj = {
  render: (_args, context) => (
    <UI.Stack gap="spacious">
      <BrandSignIn pseudo={context.globals?.locale === "pseudo"} />
      <div inert>
        <ContextInvitation />
      </div>
    </UI.Stack>
  ),
};
