import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

const ORGANIZATIONS = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "Northwind" },
  { id: "00000000-0000-4000-8000-0000000000b2", name: "Contoso" },
] as const;

/**
 * Deterministic specimen for protected cache partitioning: switching
 * organization must bump the session generation and never render the prior
 * tenant's cached value.
 */
export function CacheScopeFixture() {
  const { translate } = useI18n();
  const controller = useQueryScopeController();
  const scope = useProtectedScope();
  const organization = ORGANIZATIONS.find((entry) =>
    entry.id === scope.organizationId
  );
  const cached = useQuery({
    queryKey: protectedQueryKey(scope, "tasks.list", { fixture: true }),
    queryFn: () => `tasks for ${organization?.name ?? "no organization"}`,
    staleTime: Infinity,
  });

  return (
    <UI.Stack data-testid="synthetic-fixture" gap="spacious">
      <UI.StatusLabel status="queued">
        {translate("shell.states.fixtureLabel")}
      </UI.StatusLabel>
      <UI.Heading level="page" tabIndex={-1}>
        {translate("shell.states.cacheTitle")}
      </UI.Heading>
      <UI.DataText data-testid="cache-scope-generation">
        sessionGeneration={scope.sessionGeneration}
      </UI.DataText>
      <UI.DataText data-testid="cache-scope-value">
        {cached.data ?? "no cached value"}
      </UI.DataText>
      <UI.Inline>
        {ORGANIZATIONS.map((entry) => (
          <UI.Button
            key={entry.id}
            data-testid={`switch-organization-${entry.name}`}
            onClick={() => controller.setIdentity(entry.id)}
          >
            {entry.name}
          </UI.Button>
        ))}
      </UI.Inline>
      <UI.Text>
        {translate("shell.states.currentOrganization", {
          organization: organization?.name ?? "none",
        })}
      </UI.Text>
    </UI.Stack>
  );
}
