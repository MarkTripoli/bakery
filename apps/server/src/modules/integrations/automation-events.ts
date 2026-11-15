/**
 * What a provider's verified deliveries can say to an automation (issue #36),
 * declared here, beside the provider's adapter, so the automations core reads a
 * list and names no provider's events. One declaration serves both halves of
 * matching: the receipt creates an `automation` route only for a declared kind,
 * and a version can name only a declared kind and a declared filter key, so a
 * version that the receipt would never route cannot be created.
 */
import { GITHUB_PROVIDER } from "./postgres.ts";

/** The type a filter value must have for a declared key. */
export type AutomationFilterType = "number" | "string";

export type AutomationEventDeclaration = Readonly<{
  /** The event kinds the provider's receipt routes to automations. */
  kinds: readonly string[];
  /** The fields of the stored, normalized projection a filter may compare. */
  filterKeys: Readonly<Record<string, AutomationFilterType>>;
}>;

const DECLARATIONS: Readonly<Record<string, AutomationEventDeclaration>> =
  Object.freeze({
    [GITHUB_PROVIDER]: Object.freeze({
      kinds: Object.freeze(
        ["issues", "pull_request", "check_run", "check_suite"],
      ),
      filterKeys: Object.freeze(
        {
          number: "number",
          headSha: "string",
          repositoryId: "number",
        } as const,
      ),
    }),
  });

/** The declaration of a provider, or undefined when it routes nothing to automations. */
export function automationEventsOf(
  provider: string,
): AutomationEventDeclaration | undefined {
  return Object.hasOwn(DECLARATIONS, provider)
    ? DECLARATIONS[provider]
    : undefined;
}
