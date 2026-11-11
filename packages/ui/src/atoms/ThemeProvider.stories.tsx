import type { Meta, StoryObj } from "@storybook/react-vite";
import { Text, ThemeProvider, useTheme } from "@bakery/ui";

function ThemeCard({ theme }: { theme: "system" | "light" | "dark" }) {
  const { resolvedTheme } = useTheme();
  const description = theme === "system"
    ? "OS preference: light"
    : "Explicit selection";
  return (
    <div className="theme-provider-card">
      <div className="theme-provider-card-title">
        <Text>{theme[0].toUpperCase() + theme.slice(1)}</Text>
      </div>
      <div className="theme-provider-card-description">
        <Text>{description}</Text>
      </div>
      <div className="theme-provider-card-surface">
        <Text>Resolved → {resolvedTheme} surface</Text>
      </div>
    </div>
  );
}

const meta = {
  title: "Bakery/Atoms/ThemeProvider",
  parameters: { catalogId: "ui.themeProvider", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div className="theme-provider-grid">
      <ThemeProvider defaultTheme="system">
        <ThemeCard theme="system" />
      </ThemeProvider>
      <ThemeProvider defaultTheme="light">
        <ThemeCard theme="light" />
      </ThemeProvider>
      <ThemeProvider defaultTheme="dark">
        <ThemeCard theme="dark" />
      </ThemeProvider>
    </div>
  ),
};
