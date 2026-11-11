import type { Meta, StoryObj } from "@storybook/react-vite";
import { logoSurfaces } from "./logo-select.ts";
import { scene } from "./scene-assets.ts";
import { sceneIds } from "./scene-select.ts";

const meta = {
  title: "Bakery/Brand/Scenes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

const surfaces = {
  light: logoSurfaces["light.canvas"].hex,
  dark: logoSurfaces["dark.canvas"].hex,
} as const;

/** Every scene in both themes, each on its canvas token colour. */
export const AllScenes: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 16 }}>
      {sceneIds.map((id) => (
        <div
          key={id}
          data-scene={id}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          {(["light", "dark"] as const).map((theme) => {
            const art = scene(id, { theme, width: 600 });
            return (
              <div
                key={theme}
                style={{ background: surfaces[theme], padding: 12 }}
              >
                <img
                  alt={art.alt}
                  data-scene-theme={theme}
                  height={art.height}
                  src={art.src}
                  srcSet={art.srcSet}
                  style={{ maxWidth: "100%", height: "auto" }}
                  width={art.width}
                />
                <small style={{ color: "#808080" }}>{id} · {theme}</small>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  ),
};
