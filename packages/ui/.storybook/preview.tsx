import type { CSSProperties } from "react";
import type { Decorator, Preview } from "@storybook/react-vite";
import * as UI from "@bakery/ui";
import "@bakery/ui";
import "./preview.css";

const decorator: Decorator = (Story, context) => {
  const ownsTopLevelLandmark = context.title === "Bakery/Templates/AppShell" ||
    context.title === "Bakery/Templates/AuthEntry" ||
    context.title === "Bakery/Templates/ArtboardShell" ||
    context.title === "Bakery/Templates/RunOutputView" ||
    context.title === "Bakery/Templates/WorkerEnrollmentInstructions" ||
    context.title === "Bakery/Templates/WorkerCatalog" ||
    context.title === "Bakery/Templates/WorkerReadOnlyDetail";
  const theme = UI.parseTheme(context.globals.theme);
  const direction = context.globals.direction === "rtl" ? "rtl" : "ltr";
  const locale = context.globals.locale === "pseudo" ? "en-XA" : "en-US";
  const viewportMode = ["narrow", "pane", "desktop", "zoom-200"].includes(
      context.globals.viewportMode,
    )
    ? context.globals.viewportMode
    : "desktop";
  const maxInlineSize = {
    narrow: "390px",
    pane: "744px",
    desktop: "100%",
    "zoom-200": "none",
  }[viewportMode];
  const style: CSSProperties = {
    inlineSize: viewportMode === "zoom-200" ? "50vw" : "100%",
    maxInlineSize,
    zoom: viewportMode === "zoom-200" ? 2 : 1,
  };
  return (
    <UI.ThemeProvider
      defaultTheme={theme}
      direction={direction}
      key={theme}
      locale={locale}
    >
      <div
        aria-label={ownsTopLevelLandmark ? undefined : "Component specimen"}
        className="storybook-story"
        data-full-page={ownsTopLevelLandmark || undefined}
        data-pointer={context.globals.pointer}
        data-pseudo-locale={context.globals.locale === "pseudo"}
        data-reduced-motion={context.globals.reducedMotion === "reduce"}
        data-viewport-mode={viewportMode}
        dir={direction}
        role={ownsTopLevelLandmark ? undefined : "region"}
        style={style}
      >
        <Story />
      </div>
    </UI.ThemeProvider>
  );
};

const preview: Preview = {
  decorators: [decorator],
  globalTypes: {
    theme: {
      description: "Color theme",
      defaultValue: "light",
      toolbar: {
        icon: "paintbrush",
        items: ["system", "light", "dark"],
      },
    },
    direction: {
      description: "Text direction",
      defaultValue: "ltr",
      toolbar: { icon: "transfer", items: ["ltr", "rtl"] },
    },
    locale: {
      description: "Locale and copy expansion",
      defaultValue: "en-US",
      toolbar: { icon: "globe", items: ["en-US", "pseudo"] },
    },
    pointer: {
      description: "Pointer capability",
      defaultValue: "fine",
      toolbar: { icon: "cpu", items: ["fine", "coarse"] },
    },
    reducedMotion: {
      description: "Motion preference",
      defaultValue: "no-preference",
      toolbar: { icon: "play", items: ["no-preference", "reduce"] },
    },
    viewportMode: {
      description: "Named viewport context",
      defaultValue: "desktop",
      toolbar: {
        icon: "sidebar",
        items: ["narrow", "pane", "desktop", "zoom-200"],
      },
    },
  },
  parameters: {
    // Playwright runs the canonical axe sweep explicitly. Keep Storybook's
    // addon from starting a concurrent axe run on the same preview frame.
    a11y: { test: "off" },
    controls: { expanded: true },
  },
};

export default preview;
