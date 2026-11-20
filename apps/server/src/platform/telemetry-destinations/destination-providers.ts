/**
 * A provider is the name a destination is added for: who runs the backend that
 * receives the measurements. It is a label chosen in the Add destination
 * chooser, so the page can show the provider's mark. Every provider here
 * delivers through its kind's adapter, with nothing provider-specific beyond
 * the values filled in when it is chosen; the mark is never worked out from a
 * destination's name or address.
 */
export type DestinationProvider = Readonly<{
  /** Stable key saved with the destination. */
  key: string;
  /** The provider's name as people know it. */
  name: string;
  /** One plain sentence for the chooser. */
  description: string;
  /** The kind of destination it delivers through. */
  kind: string;
  /** Values filled in when it is chosen, by the kind's field name. */
  prefill: Readonly<Record<string, string>>;
}>;

const provider = (value: DestinationProvider): DestinationProvider =>
  Object.freeze({ ...value, prefill: Object.freeze({ ...value.prefill }) });

/** In the order the chooser lists them; the first of a kind is its default. */
export const DESTINATION_PROVIDERS: readonly DestinationProvider[] = Object
  .freeze([
    provider({
      key: "opentelemetry",
      name: "OpenTelemetry",
      description:
        "Any collector or service that accepts OpenTelemetry over HTTPS.",
      kind: "otlp",
      prefill: {},
    }),
    provider({
      key: "grafana",
      name: "Grafana",
      description:
        "Send timings and health to Grafana Cloud or your own Grafana stack.",
      kind: "otlp",
      prefill: {},
    }),
    provider({
      key: "datadog",
      name: "Datadog",
      description: "Send timings and health to Datadog.",
      kind: "otlp",
      prefill: {},
    }),
    provider({
      key: "honeycomb",
      name: "Honeycomb",
      description: "Send timings and health to Honeycomb.",
      kind: "otlp",
      // The US endpoint and the header Honeycomb documents for its API key; an
      // EU account changes the address to https://api.eu1.honeycomb.io.
      prefill: {
        address: "https://api.honeycomb.io",
        headerName: "x-honeycomb-team",
      },
    }),
    provider({
      key: "sentry",
      name: "Sentry",
      description: "Send timings and health to Sentry.",
      kind: "otlp",
      prefill: {},
    }),
  ]);

export function destinationProvider(
  key: string,
): DestinationProvider | undefined {
  return DESTINATION_PROVIDERS.find((entry) => entry.key === key);
}

/** The provider a destination reads as when none was saved with it. */
export function defaultProviderKey(kind: string): string {
  return DESTINATION_PROVIDERS.find((entry) => entry.kind === kind)?.key ??
    kind;
}
