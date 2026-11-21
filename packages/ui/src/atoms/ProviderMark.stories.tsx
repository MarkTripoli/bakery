import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderMark } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/ProviderMark",
  parameters: { catalogId: "ui.providerMark", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const PROVIDERS = [
  ["opentelemetry", "OpenTelemetry"],
  ["sentry", "Sentry"],
  ["github", "GitHub"],
  ["linear", "Linear"],
  // The whole file, uncropped, drawn at twice the size: it overflows its slot.
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  // No agreed mark yet: each gets the letter tile.
  ["grafana", "Grafana"],
  ["datadog", "Datadog"],
  ["slack", "Slack"],
  ["honeycomb", "Honeycomb"],
  // A provider the registry does not know falls back to the tile too.
  ["unknown", "Unknown provider"],
] as const;

export const Contract: StoryObj = {
  render: () => (
    <div
      style={{
        display: "grid",
        gap: 16,
        maxInlineSize: 640,
        minInlineSize: 0,
      }}
    >
      {/* The name always sits beside the mark, so the mark is hidden from assistive technology. */}
      {PROVIDERS.map(([provider, name]) => (
        <div
          key={provider}
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            minInlineSize: 0,
          }}
        >
          <ProviderMark name={name} provider={provider} />
          <ProviderMark name={name} provider={provider} size="header" />
          <span>{name}</span>
        </div>
      ))}
      {/* Alone, the mark is named by its provider. */}
      <ProviderMark name="Sentry" provider="sentry" standalone />
    </div>
  ),
};
