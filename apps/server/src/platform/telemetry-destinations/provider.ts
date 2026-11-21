import type { TelemetryRecord } from "@bakery/config/telemetry";
import type { ExportSink } from "@bakery/config/telemetry-export";
import type { AddressPolicy } from "./address-policy.ts";
import type { MeasurementKind } from "./measurements.ts";

/**
 * One setting of a destination kind. The settings page builds its form from
 * these, so a new kind needs no change on the web side.
 */
export type DestinationField = Readonly<{
  /** Key the value is saved and sent under. */
  name: string;
  /** What the form calls the field. */
  label: string;
  /** One line of help under the field. */
  help: string;
  /** A secret is stored encrypted and never read back. */
  secret: boolean;
  required: boolean;
}>;

/** What a destination kind is and what it can take. */
export type DestinationKind = Readonly<{
  /** Stable identifier, for example "otlp". */
  kind: string;
  /** What people call it, for example "OpenTelemetry". */
  label: string;
  fields: readonly DestinationField[];
  /** The kinds of measurement this destination can receive. */
  measurements: readonly MeasurementKind[];
  /** Why a kind of measurement it cannot take is unavailable. */
  unavailableReasons: Readonly<Partial<Record<MeasurementKind, string>>>;
}>;

/** A destination's saved settings, secrets included, held in memory only. */
export type DestinationValues = Readonly<Record<string, string>>;

/** The destination's own answer to one probe. */
export type ProbeOutcome = Readonly<{
  /** True only when the destination accepted the probe. */
  ok: boolean;
  /** The destination's HTTP status, or null when it never answered. */
  status: number | null;
  /** A short plain reason when it did not accept. */
  reason: string | null;
  /** A bounded piece of what it answered, for the person reading the result. */
  answer: string | null;
}>;

/** What an adapter is given to do its work. */
export type ProviderDependencies = Readonly<{
  fetch: typeof fetch;
  addressPolicy: AddressPolicy;
}>;

/**
 * The port every telemetry destination implements. A new kind of destination is
 * one adapter file implementing this and one entry in the registry; nothing that
 * emits telemetry changes.
 */
export type TelemetryProvider = Readonly<{
  descriptor: DestinationKind;
  /**
   * The settings that say where a destination's secrets are sent. Changing one
   * without entering every saved secret again is refused, so a stored secret
   * never follows a new address and cannot be read back by pointing it elsewhere.
   */
  secretBoundFields: readonly string[];
  /** The problems with these values, by field name. Empty when they are fine. */
  validate(
    values: DestinationValues,
  ): Promise<Readonly<Record<string, string>>>;
  /** The sink that delivers a batch. It throws when the destination refuses. */
  createSink(
    values: DestinationValues,
    dependencies: ProviderDependencies,
  ): ExportSink<TelemetryRecord>;
  /** Sends one harmless message and reports what the destination said. */
  probe(
    values: DestinationValues,
    dependencies: ProviderDependencies,
    signal: AbortSignal,
  ): Promise<ProbeOutcome>;
}>;

/** The adapters this server knows about, by kind. */
export type TelemetryProviderRegistry = Readonly<{
  get(kind: string): TelemetryProvider | undefined;
  list(): readonly TelemetryProvider[];
}>;

/**
 * Builds a registry. Two adapters for one kind are a mistake that would make
 * which one runs depend on order, so it is refused here, at start-up.
 */
export function createProviderRegistry(
  providers: readonly TelemetryProvider[],
): TelemetryProviderRegistry {
  const byKind = new Map<string, TelemetryProvider>();
  for (const provider of providers) {
    const kind = provider.descriptor.kind;
    if (byKind.has(kind)) {
      throw new Error(`TELEMETRY_PROVIDER_DUPLICATE_KIND:${kind}`);
    }
    byKind.set(kind, provider);
  }
  const ordered = Object.freeze([...byKind.values()]);
  return Object.freeze({
    get: (kind: string) => byKind.get(kind),
    list: () => ordered,
  });
}
