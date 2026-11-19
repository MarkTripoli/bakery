/**
 * `@bakery/integration-sdk/web` - the web tier (chapter 09 section 12.2).
 *
 * Types only. This is the one place a provider's presentation lives, and it must
 * contain no way to reach the network: the props carry an API client rather than
 * letting a component call `fetch`. Rail B1 forbids this entry from reaching
 * server code at all.
 */
export { defineWebProvider, webProviderDefects } from "./src/web-provider.ts";
export type {
  AppRegistrationPanelProps,
  ConnectionSectionProps,
  ConnectorApi,
  ConnectOutcome,
  ConnectStepProps,
  IntegrationResource,
  ProviderComponent,
  ProviderMessage,
  ProviderWebModule,
} from "./src/web-provider.ts";
