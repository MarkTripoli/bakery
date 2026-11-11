import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccessSettings, Button } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/AccessSettings",
  parameters: {
    catalogId: "template.accessSettings",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const revoke = (
  <Button aria-label="Revoke ci-deployer" variant="text">Revoke</Button>
);

export const Contract: StoryObj = {
  render: () => (
    <>
      <AccessSettings
        title="Access"
        description="Members, roles by scope, service accounts and connected clients for Acme Bakeries."
        summary="4 people · 1 pending invitation"
        actions={<Button>Invite member</Button>}
        sections={[
          {
            id: "story-members",
            title: "Members",
            titleDetail: "· 4 people",
            aside: "1 pending invitation",
            phoneLayout: "overlay",
            rows: [
              {
                id: "ada",
                identity: "Ada Rivera",
                emphasis: true,
                cells: ["Organization · Admin", "All applications"],
                action: (
                  <Button aria-label="Edit Ada Rivera" variant="text">
                    Edit
                  </Button>
                ),
              },
              {
                id: "jon",
                identity: "Jon Okafor",
                emphasis: true,
                cells: ["Application · Developer", "storefront"],
                action: (
                  <Button aria-label="Edit Jon Okafor" variant="text">
                    Edit
                  </Button>
                ),
              },
            ],
          },
          {
            id: "story-accounts",
            title: "Service accounts and tokens",
            phoneLayout: "inline",
            rows: [{
              id: "deployer",
              identity: "ci-deployer",
              emphasis: true,
              cells: ["Application · Developer", <code key="p">bk_…9d2f</code>],
              phoneHiddenCells: [0],
              action: revoke,
              actionTone: "destructive",
            }],
            callout: {
              text:
                "New token shown once. Copy it now; it cannot be shown again.",
              value: "bk_live_4c81…e07a",
            },
          },
          {
            id: "story-clients",
            title: "Connected clients",
            columns: "detail",
            rows: [{
              id: "cli",
              identity: "Bakery CLI · mark@example.test",
              cells: ["Authorized 2 Oct 2026"],
              action: <Button variant="text">Revoke</Button>,
              actionTone: "destructive",
            }],
          },
        ]}
      />
      <AccessSettings
        title="Access"
        state="empty"
        actions={<Button>Invite member</Button>}
        status={{
          title: "Only you are in this organization",
          description:
            "Invite people, then give each of them Admin, Developer, Viewer or Guest on the organization, an application or a repository.",
          descriptionShort:
            "Invite people, then give each of them Admin, Developer, Viewer or Guest.",
          action: <Button>Invite your first member</Button>,
        }}
      />
      <AccessSettings
        title="Access"
        state="error"
        status={{
          title: "Members could not be loaded",
          description: "Bakery could not read the member list just now.",
          action: <Button>Try again</Button>,
        }}
      />
      <AccessSettings
        title="Access"
        state="loading"
        status={{ label: "Loading members and roles…" }}
      />
    </>
  ),
};
