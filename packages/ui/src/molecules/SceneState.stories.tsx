import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, SceneState } from "@bakery/ui";
import { sceneIds } from "../brand/scene-select.ts";

const meta = {
  title: "Bakery/Molecules/SceneState",
  parameters: { catalogId: "ui.sceneState", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The four whole-page states the design names, in the page's own words. The
 * scene is decoration: the heading says the same thing, so the art is hidden
 * from assistive technology and the copy carries the meaning.
 */
export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 32 }}>
      <SceneState
        action={<Button>Go to Work</Button>}
        description="The address may be mistyped, or the page may have moved."
        scene="not-found"
        title="Page not found"
      />
      <SceneState
        description="Ask an administrator of this organization for access."
        scene="forbidden"
        title="Access denied"
      />
      <SceneState
        action={<Button>Try again</Button>}
        description="Bakery could not load this page. Nothing you did was lost."
        scene="server-error"
        title="Something went wrong"
      />
      <SceneState
        description="Bakery cannot reach the server. Your work is saved on this device."
        scene="offline"
        title="You are offline"
      />
    </div>
  ),
};

/** Every scene the brand ships, so a new one is visible here the day it lands. */
export const EveryScene: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 32 }}>
      {sceneIds.map((id) => (
        <SceneState
          key={id}
          description={`Scene ${id}, in the template the pages use.`}
          scene={id}
          title={id}
        />
      ))}
    </div>
  ),
};
