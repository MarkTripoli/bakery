import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  InstallationSettingsForm,
  type InstallationSettingsFormProps,
  SettingsContent,
  Stack,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/InstallationSettingsForm",
  parameters: {
    catalogId: "template.installationSettingsForm",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

function PolicyForm(
  { state }: { readonly state: InstallationSettingsFormProps["state"] },
) {
  const [registration, setRegistration] = useState("invitation");
  const [organizations, setOrganizations] = useState("installation_admins");
  return (
    <SettingsContent>
      <InstallationSettingsForm
        title="Installation settings"
        description="Apply to every organization. Changes take effect on the next request."
        groups={[
          {
            id: "registration",
            title: "Registration mode",
            description: "Who can create an account.",
            value: registration,
            onChange: setRegistration,
            choices: [{
              value: "invitation",
              label: "Invitation only",
              description: "People can register with an invitation.",
            }, {
              value: "open",
              label: "Open",
              description: "Anyone can create an account.",
              disabled: true,
              disabledHint: "Open registration is not available.",
            }, {
              value: "closed",
              label: "Closed",
              description: "Existing users can still sign in.",
            }],
          },
          {
            id: "organizations",
            title: "Organization creation",
            description: "Who can create new organizations.",
            value: organizations,
            onChange: setOrganizations,
            choices: [{
              value: "any_user",
              label: "Any user",
              description: "Any signed-in user can create an organization.",
            }, {
              value: "installation_admins",
              label: "Installation administrators only",
              description:
                "Only installation administrators can create organizations.",
            }],
          },
        ]}
        state={state}
        dirty={registration !== "invitation" ||
          organizations !== "installation_admins"}
        notice={state === "error"
          ? "Changes couldn’t be saved. Your edits are still here."
          : state === "conflict"
          ? "Someone else updated these settings. Reload before saving."
          : state === "forbidden"
          ? "Only installation administrators can change settings."
          : state === "loading"
          ? "Loading settings…"
          : undefined}
        changedLabel="Last changed 11 Oct 2026"
        noticeTitle={state === "conflict"
          ? "Settings changed while you were editing"
          : "Settings were not saved"}
        keepEditingLabel="Keep editing"
        retryLabel="Try again"
        saveLabel="Save settings"
        discardLabel="Discard"
        onSave={() => {}}
        onDiscard={() => {
          setRegistration("invitation");
          setOrganizations("installation_admins");
        }}
      />
    </SettingsContent>
  );
}

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      {([
        "default",
        "loading",
        "saving",
        "error",
        "conflict",
        "forbidden",
      ] as const).map((state) => <PolicyForm key={state} state={state} />)}
    </Stack>
  ),
};
