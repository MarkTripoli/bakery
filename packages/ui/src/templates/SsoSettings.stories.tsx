import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, SettingsContent, SsoSettings, StatusBadge } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/SsoSettings",
  parameters: {
    catalogId: "template.ssoSettings",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const providers = [
  {
    id: "okta",
    name: "Okta · OIDC",
    detail: "https://acme.okta.example/oauth2/default",
    status: <StatusBadge status="healthy">Enabled</StatusBadge>,
    action: <Button variant="outline" aria-label="Edit okta">Edit</Button>,
    onSelect: () => undefined,
  },
  {
    id: "entra",
    name: "Entra · SAML",
    detail: "acme.example",
    status: <StatusBadge status="needsInput">Not verified</StatusBadge>,
    action: <Button variant="outline" aria-label="Edit entra">Edit</Button>,
    onSelect: () => undefined,
  },
];

export const Contract: StoryObj = {
  render: () => (
    <SettingsContent>
      <SsoSettings title="Add provider" variant="form">
        <p>The provider form goes here.</p>
      </SsoSettings>
      <SsoSettings
        title="Single sign-on"
        description="Let members sign in with your company's identity provider instead of a password."
        actions={<Button>Add provider</Button>}
        providers={providers}
        providersLabel="Single sign-on providers"
        domain={
          <>
            <h2>Domain verification</h2>
            <p>
              Add this record where you manage DNS for acme.example. It proves
              your organization controls the domain.
            </p>
          </>
        }
        enforcement={
          <>
            <strong>Require SSO for all members</strong>
            <p>
              Break-glass: organization administrators can always sign in with a
              password, so a broken provider never locks you out.
            </p>
          </>
        }
      />
    </SettingsContent>
  ),
};
