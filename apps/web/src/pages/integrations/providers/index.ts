/**
 * Where a provider's pieces are bound to the generic integrations pages. The
 * generic files import from here by generic names; a second provider is
 * added here and the pages choose by a connection's provider.
 */
import type { MessageKey } from "@bakery/i18n";
import { webProviderFor } from "../../../integrations/registry.ts";
import { type ConnectionOutcome, outcomeCopy } from "../outcomes.ts";
import type { HealthKind } from "../model.ts";
import { GITHUB_IDENTITY } from "./github/identity.ts";
import { type ProviderFix, SLACK_FIXES, SLACK_OUTCOMES } from "./slack/copy.ts";

export { useGitHubConnect as useProviderConnect } from "./github/use-github-connect.ts";
export type { ConnectOptions } from "./github/use-github-connect.ts";
export { GITHUB_IDENTITY as PROVIDER_IDENTITY } from "./github/identity.ts";

type Translate = (key: MessageKey) => string;

export function hasSetupPages(provider: string): boolean {
  return provider === GITHUB_IDENTITY.slug;
}

export { useOAuthConnect } from "./use-oauth-connect.ts";

export function providerOutcomeCopy(
  provider: string,
  outcome: ConnectionOutcome | null,
) {
  if (outcome === null) return null;
  return hasSetupPages(provider)
    ? outcomeCopy(outcome)
    : SLACK_OUTCOMES[outcome] ?? null;
}

export function providerFix(
  provider: string,
  health: HealthKind,
): ProviderFix | null {
  return webProviderFor(provider)?.connectAvailable === false ||
      hasSetupPages(provider)
    ? null
    : SLACK_FIXES[health] ?? null;
}

export function healthBadge<Tone extends string>(
  provider: string,
  health: Readonly<{ kind: string; tone: Tone }>,
): Readonly<{ key: MessageKey; tone: Tone | "success" }> {
  return !hasSetupPages(provider) &&
      (health.kind === "notChecked" || health.kind === "working")
    ? {
      key: "settings.connections.other.connected",
      tone: "success",
    }
    : {
      key: `settings.connections.badge.${health.kind}` as MessageKey,
      tone: health.tone,
    };
}

export function providerLook(provider: string, translate: Translate) {
  if (hasSetupPages(provider)) {
    return {
      name: translate(GITHUB_IDENTITY.headingKey),
      fallback: GITHUB_IDENTITY.avatarFallback,
    };
  }
  const name = webProviderFor(provider)
    ? translate(`integrations.${provider}.name` as MessageKey)
    : provider;
  return { name, fallback: name.slice(0, 1).toUpperCase() };
}

export function permissionSentences(provider: string, granted: unknown) {
  const describe = webProviderFor(provider)?.describePermission;
  if (
    describe === undefined || granted === null || typeof granted !== "object"
  ) {
    return [];
  }
  const sentences = Object.entries(granted).flatMap(([permission, level]) => {
    const known = level === "read" || level === "write"
      ? level
      : permission.slice(permission.lastIndexOf(":") + 1);
    const sentence = describe(permission, known);
    return sentence ? [sentence] : [];
  });
  return [
    ...new Map(sentences.map((one) => [JSON.stringify(one), one])).values(),
  ];
}
