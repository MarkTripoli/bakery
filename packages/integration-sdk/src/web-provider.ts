import type { MessageKey } from "@bakery/i18n";
import type { ProviderManifest } from "./provider-manifest.ts";

/**
 * The provider web module (chapter 09 section 12.2).
 *
 * Types only, and every member is optional except the ones the manifest forces.
 * A web module is where the provider-specific *presentation* lives: the connect
 * step for an App flow, and how a resource or permission is described to a person.
 * What it must never contain is a way to reach the network, which is why the props
 * carry an API client rather than letting a component call `fetch`.
 */

/** What the host hands a connect step so it never fetches anything itself. */
export type ConnectorApi = {
  /** Starts a connect attempt and returns the URLs to visit, from the host. */
  beginConnect(input: {
    organizationId: string;
    reconnect: boolean;
    /** Provider slug, so the host can route without the caller naming a route. */
    providerSlug: string;
  }): Promise<{ steps: readonly string[] }>;
  /** Reports the outcome of a step the person completed. */
  reportOutcome(input: {
    organizationId: string;
    providerSlug: string;
    outcome: ConnectOutcome;
  }): Promise<void>;
};

/**
 * How a connect attempt ended.
 *
 * A closed set so the host can record and display it uniformly: a provider that
 * invented its own outcome strings would need its own handling in the host.
 */
export type ConnectOutcome =
  | { kind: "connected"; externalAuthorizationId: string }
  | { kind: "reconnect_required"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "cancelled" };

/** A resource as the web layer receives it: enough to render, no provider detail. */
export type IntegrationResource = {
  externalId: string;
  resourceKindId: string;
  name: string;
  parentName?: string;
};

/** Props a connect step receives. `api` is the only way out of the component. */
export type ConnectStepProps = {
  organizationId: string;
  reconnect: boolean;
  api: ConnectorApi;
  onOutcome(outcome: ConnectOutcome): void;
};

/** Props for the panel that registers an app, when a provider registers one. */
export type AppRegistrationPanelProps = {
  organizationId: string;
  api: ConnectorApi;
  onRegistered(): void;
};

/** Props for the section a settings page shows for a connected installation. */
export type ConnectionSectionProps = {
  organizationId: string;
  providerSlug: string;
  connection: {
    externalAccountLabel: string;
    grantedPermissions: Readonly<Record<string, string>>;
    connectedAt: Date;
  };
  onDisconnect(): void;
};

/**
 * A sentence for the host to translate.
 *
 * `arguments` fills the message's placeholders; the values are primitives because
 * a message is text, and anything richer belongs in the component that renders it.
 */
export type ProviderMessage = {
  key: MessageKey;
  arguments?: Readonly<Record<string, string | number>>;
};

/** A component the host can render without knowing which provider supplied it. */
export type ProviderComponent = (props: never) => unknown;

/**
 * What a provider package's `/web` entry exports.
 *
 * `ConnectStep` is required exactly when the manifest's connect kind is
 * `github-app`: that flow is the one piece of connect code the provider owns, so a
 * provider claiming it must bring a step to drive it. Every other kind is run by
 * core, where a provider component would be a second implementation of the same
 * flow.
 */
export type ProviderWebModule<M extends ProviderManifest> = {
  manifest: M;
  ConnectStep:
    | ((props: ConnectStepProps) => unknown)
    | (M["connect"]["kind"] extends "github-app" ? never : undefined)
    | undefined;
  AppRegistrationPanel?: (props: AppRegistrationPanelProps) => unknown;
  ConnectionSection?: (props: ConnectionSectionProps) => unknown;
  /**
   * How a resource is labelled in a picker.
   *
   * A message key rather than a sentence: the host renders it through the
   * translator, so a provider cannot ship English into a translated page, and a
   * missing key is a compile error here rather than a raw key on screen.
   */
  describeResource?: (resource: IntegrationResource) => ProviderMessage;
  /**
   * Whether a person can start a connection to this provider yet.
   *
   * Absent means yes. A provider whose connect flow is not built says `false`, and
   * the host shows its row with Connect disabled instead of letting the button fail.
   * It is a statement about this build, so it goes away when the flow ships.
   */
  connectAvailable?: boolean;
  /**
   * Where an installation administrator creates the OAuth application whose client
   * ID and secret they enter. Opened in a new tab; only for providers that register
   * client credentials.
   */
  registrationGuideUrl?: string;
  /** How one provider permission and level read to a person, as a message. */
  describePermission?: (
    permission: string,
    level: string,
  ) => ProviderMessage;
};

/**
 * Defines a web module, keeping the manifest literal.
 *
 * Type parameters mirror `defineServerProvider`: `const M` preserves the connect
 * kind so a `github-app` provider that forgets its `ConnectStep` fails to compile.
 */
export function defineWebProvider<const M extends ProviderManifest>(
  module: ProviderWebModule<M>,
): ProviderWebModule<M> {
  return Object.freeze(module);
}

/**
 * Web modules fail for different reasons than server ones, and a person has to fix
 * them, so the messages name the missing piece rather than a type.
 */
export function webProviderDefects<M extends ProviderManifest>(
  module: ProviderWebModule<M>,
): string[] {
  const defects: string[] = [];
  const needsStep = module.manifest.connect.kind === "github-app";
  const hasStep = typeof module.ConnectStep === "function";
  if (needsStep && !hasStep) {
    defects.push(
      "A github-app provider must export ConnectStep: the App flow is the one connect path the provider owns.",
    );
  }
  if (!needsStep && hasStep) {
    defects.push(
      `A ${module.manifest.connect.kind} provider is connected by core, so it must not export ConnectStep.`,
    );
  }
  return defects;
}
