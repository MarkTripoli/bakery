import type { Meta, StoryObj } from "@storybook/react-vite";
import { logo, type LogoVariantId } from "./logo-assets.ts";
import {
  logoSurfaceIds,
  logoSurfaces,
  logoVariantIds,
  recommendedVariant,
} from "./logo-select.ts";

const meta = {
  title: "Bakery/Brand/Logo",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

const tiles: LogoVariantId[] = ["tile-light", "tile-dark"];
const artVariants = logoVariantIds.filter((id) => !tiles.includes(id));

/** Panel painted with a token surface hex from `variants.json`. */
function Surface(
  { surface, children }: {
    surface: (typeof logoSurfaceIds)[number];
    children: React.ReactNode;
  },
) {
  const { hex, label, token } = logoSurfaces[surface];
  return (
    <section
      data-surface={surface}
      style={{
        background: hex,
        padding: 16,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 24,
      }}
    >
      <small style={{ width: 200, color: "#808080" }}>
        {label} <code>{token}</code>
      </small>
      {children}
    </section>
  );
}

/** Every non-tile variant mark on every token surface; the recommended one is flagged. */
export const VariantsOnSurfaces: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 4 }}>
      {logoSurfaceIds.map((surface) => (
        <Surface key={surface} surface={surface}>
          {artVariants.map((variant) => {
            const mark = logo({ art: "mark", variant, size: 48 });
            return (
              <img
                key={variant}
                alt={`${mark.alt} ${variant}`}
                data-logo-variant={variant}
                data-recommended={recommendedVariant(surface) === variant}
                height={mark.height}
                src={mark.src}
                style={{
                  opacity: recommendedVariant(surface) === variant ? 1 : 0.35,
                }}
                width={mark.width}
              />
            );
          })}
        </Surface>
      ))}
    </div>
  ),
};

/** Recommended lockup and wordmark per surface, resolved from the surface only. */
export const RecommendedPerSurface: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 4 }}>
      {logoSurfaceIds.map((surface) => {
        const lockup = logo({ art: "lockup", surface, size: 64 });
        const wordmark = logo({ art: "wordmark", surface, size: 32 });
        return (
          <Surface key={surface} surface={surface}>
            <img
              alt={lockup.alt}
              data-logo-variant={lockup.variant}
              height={lockup.height}
              src={lockup.src}
              width={lockup.width}
            />
            <img
              alt={wordmark.alt}
              data-logo-variant={wordmark.variant}
              height={wordmark.height}
              src={wordmark.src}
              width={wordmark.width}
            />
          </Surface>
        );
      })}
    </div>
  ),
};

/** Mark at 16-64 px; the size rule picks the 16 and 32 optical masters. */
export const Sizes: StoryObj = {
  render: () => (
    <Surface surface="light.surface">
      {[16, 20, 24, 32, 48, 64].map((size) => {
        const mark = logo({ art: "mark", size });
        return (
          <figure key={size} style={{ margin: 0, textAlign: "center" }}>
            <img
              alt={mark.alt}
              data-size={size}
              height={mark.height}
              src={mark.src}
              width={mark.width}
            />
            <figcaption>{size}px</figcaption>
          </figure>
        );
      })}
    </Surface>
  ),
};

/** Tiles exist as marks only, on light and dark surfaces. */
export const Tiles: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 4 }}>
      {(["light.canvas", "dark.canvas"] as const).map((surface) => (
        <Surface key={surface} surface={surface}>
          {tiles.map((variant) => {
            const tile = logo({ art: "mark", variant, size: 64 });
            return (
              <img
                key={variant}
                alt={`${tile.alt} ${variant}`}
                data-logo-variant={variant}
                height={tile.height}
                src={tile.src}
                width={tile.width}
              />
            );
          })}
        </Surface>
      ))}
    </div>
  ),
};
