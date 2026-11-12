import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { RepositoryEffectiveRulesResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  repositoryEffectiveRulesQueryOptions,
  repositoryQueryOptions,
} from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellSlot } from "../shell/shell-slots.tsx";
import {
  enforcementOf,
  RULE_KEYS,
  RULE_NAME,
  type RuleEntry,
  summarize,
} from "./repository-rules/presentation.ts";
import { useRulesScope } from "./repository-rules/use-rules-scope.ts";

type Effective = RepositoryEffectiveRulesResponse;
type EffectiveEntry = Effective["entries"][number];
type Provenance = EffectiveEntry["provenance"];

/** How many characters of the digest the page shows; the full value is the title. */
const DIGEST_CHARS = 8;
const ORGANIZATION_RULES_PATH = "/settings/organization/repository-rules";

const SOURCE_LABEL: Readonly<Record<Provenance, MessageKey>> = {
  inherited: "repository.rules.source.inherited",
  locked_by_organization: "repository.rules.source.locked",
  repository_override: "repository.rules.source.override",
  repository_only: "repository.rules.source.repositoryOnly",
};

/** One rule as the page shows it: the entry, where it came from and what could check it. */
type Row = {
  readonly entry: RuleEntry;
  readonly provenance: Provenance;
  /** A saved override that a lock switched off. */
  readonly overrideInactive: boolean;
  /** No working check can verify this rule, though it is switched on. */
  readonly checkUnavailable: boolean;
};

/**
 * The rows in the usual rule order. The summary and enforcement helpers read
 * the organization's entry shape, so an effective entry is shown through it:
 * what a repository may not override is exactly what the organization locked.
 */
function rowsOf(data: Effective): Row[] {
  const unavailable = new Set<string>(data.checkers.unavailableRuleKeys);
  const inactive = new Set<string>(
    data.supersededOverrides.map((superseded) => superseded.ruleKey),
  );
  return RULE_KEYS.flatMap((key) => {
    const effective = data.entries.find((entry) => entry.ruleKey === key);
    if (!effective) return [];
    const entry = {
      ...effective,
      locked: effective.provenance === "locked_by_organization",
    } as RuleEntry;
    return [{
      entry,
      provenance: effective.provenance,
      overrideInactive: effective.provenance === "locked_by_organization" &&
        inactive.has(key),
      checkUnavailable: effective.enabled && unavailable.has(key),
    }];
  });
}

/** Whether the server refused the read, or does not know the repository: told apart from nothing. */
function isRefusedRead(error: unknown): boolean {
  return isForbiddenFailure(error) || failureStatus(error) === 404;
}

/**
 * `/projects/repositories/$repositoryId/rules`: the rules in force for one
 * repository, rule by rule, with where each came from, and what Bakery can and
 * cannot check. Read only. The server decides who may read it (Developer
 * access) and every value on the page; nothing here is policy of its own.
 */
export function RepositoryRulesPage(
  { repositoryId }: { repositoryId: string },
) {
  const api = useBakeryApi();
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const navigate = useNavigate();
  const { scope, waiting } = useRulesScope();
  const [copied, setCopied] = useState(false);

  const rules = useQuery(
    repositoryEffectiveRulesQueryOptions(api, scope, repositoryId),
  );
  const repository = useQuery(repositoryQueryOptions(api, scope, repositoryId));
  const refused = (rules.isError && isRefusedRead(rules.error)) ||
    (repository.isError && isRefusedRead(repository.error));
  const data = rules.isSuccess ? rules.data : undefined;
  const repositoryName = repository.data
    ? `${repository.data.owner} / ${repository.data.name}`
    : null;
  const rows = data ? rowsOf(data) : [];
  const counts = {
    locked: rows.filter((row) => row.provenance === "locked_by_organization")
      .length,
    inherited: rows.filter((row) => row.provenance === "inherited").length,
    overrides: rows.filter((row) => row.provenance === "repository_override")
      .length,
    only: rows.filter((row) => row.provenance === "repository_only").length,
  };

  const copyDigest = async () => {
    try {
      await navigator.clipboard.writeText(data?.digest ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const goToOrganizationRules = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    void navigate({ to: ORGANIZATION_RULES_PATH });
  };
  const organizationRulesLink = (
    <UI.Link
      href={ORGANIZATION_RULES_PATH}
      onClick={goToOrganizationRules}
      variant="button"
    >
      {translate("repository.rules.viewOrganization")}
    </UI.Link>
  );

  const sourceBadge = (row: Row) => (
    <UI.Stack gap="tight">
      <UI.Inline>
        <UI.Badge>{translate(SOURCE_LABEL[row.provenance])}</UI.Badge>
      </UI.Inline>
      {row.overrideInactive
        ? (
          <UI.Text variant="muted">
            {translate("repository.rules.supersededNote")}
          </UI.Text>
        )
        : null}
    </UI.Stack>
  );
  /** Enforcement as text, and under it the warning when nothing can check the rule. */
  const enforcement = (row: Row) => (
    <UI.Stack gap="tight">
      <span>{translate(enforcementOf(row.entry))}</span>
      {row.checkUnavailable
        ? (
          <UI.Inline>
            {row.entry.mode === "require"
              ? (
                <UI.StatusBadge status="failed">
                  {translate("repository.rules.check.unavailableBlocks")}
                </UI.StatusBadge>
              )
              : (
                <UI.StatusBadge status="degraded">
                  {translate("repository.rules.check.unavailable")}
                </UI.StatusBadge>
              )}
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );

  const checks = data?.checkers;
  const protectionReason = data?.providerProtection.reason === "not_checked"
    ? "repository.rules.protection.notChecked"
    : data?.providerProtection.reason === "provider_not_connected"
    ? "repository.rules.protection.notConnected"
    : null;
  const basis = data
    ? [
      data.organizationRevision > 0
        ? translate("repository.rules.summary.organization", {
          revision: data.organizationRevision,
        })
        : translate("repository.rules.summary.noOrganization"),
      data.profileRevision === null
        ? translate("repository.rules.summary.noProfile")
        : translate("repository.rules.summary.profile", {
          profile: data.profileRevision,
        }),
    ].join(" · ")
    : "";

  return (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              label: translate("repository.rules.breadcrumb.projects"),
              href: "/projects/onboarding",
            },
            ...(repositoryName ? [{ label: repositoryName }] : []),
            { label: translate("repository.rules.title") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="repository-rules">
        <UI.Stack gap="tight">
          <UI.Heading level="page">
            {translate("repository.rules.title")}
          </UI.Heading>
          {repositoryName
            ? (
              <UI.Text variant="muted">
                {translate("repository.rules.description", {
                  repository: repositoryName,
                })}
              </UI.Text>
            )
            : null}
          {data ? <UI.Inline>{organizationRulesLink}</UI.Inline> : null}
        </UI.Stack>
        {waiting && refused
          ? (
            <UI.AlertBanner
              data-testid="repository-rules-unavailable"
              tone="information"
            >
              {translate("repository.rules.unavailable")}
            </UI.AlertBanner>
          )
          : null}
        {waiting && !refused && rules.isPending
          ? (
            <div
              aria-busy="true"
              aria-label={translate("repository.rules.loading")}
              data-testid="repository-rules-loading"
              role="status"
            >
              <UI.Stack gap="compact">
                {[0, 1, 2, 3, 4].map((row) => (
                  <UI.Skeleton key={row} shape="row" />
                ))}
              </UI.Stack>
            </div>
          )
          : null}
        {waiting && rules.isError && !refused
          ? (
            <UI.ErrorState
              action={
                <UI.Button
                  loading={rules.isFetching}
                  onClick={() => void rules.refetch()}
                  type="button"
                >
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              title={translate("repository.rules.loadError")}
            />
          )
          : null}
        {data
          ? (
            <>
              <UI.AlertBanner
                action={
                  <UI.Button
                    onClick={() => void copyDigest()}
                    type="button"
                    variant="secondary"
                  >
                    {translate(
                      copied
                        ? "repository.rules.summary.digestCopied"
                        : "repository.rules.summary.copyDigest",
                    )}
                  </UI.Button>
                }
                data-testid="repository-rules-summary"
                tone="information"
              >
                <UI.Stack gap="tight">
                  <UI.Text variant="strong">{basis}</UI.Text>
                  <UI.Text>
                    {translate(
                      counts.only > 0
                        ? "repository.rules.summary.countsWithOnly"
                        : "repository.rules.summary.counts",
                      counts,
                    )}
                  </UI.Text>
                  {/* One line: a data text takes the whole line it is on. */}
                  <UI.DataText
                    data-testid="repository-rules-digest"
                    title={data.digest}
                    variant="code"
                  >
                    {translate("repository.rules.summary.digest")}{" "}
                    {data.digest.slice(0, DIGEST_CHARS)}
                  </UI.DataText>
                </UI.Stack>
              </UI.AlertBanner>
              {rows.length === 0
                ? (
                  <UI.EmptyState
                    action={organizationRulesLink}
                    description={translate(
                      "repository.rules.empty.description",
                    )}
                    title={translate("repository.rules.empty.title")}
                  />
                )
                : phone
                ? (
                  <div
                    aria-label={translate("repository.rules.table.caption")}
                    role="list"
                  >
                    {rows.map((row) => (
                      <div key={row.entry.ruleKey} role="listitem">
                        <UI.StackedRow
                          status={
                            <UI.Badge>
                              {translate(SOURCE_LABEL[row.provenance])}
                            </UI.Badge>
                          }
                          title={translate(RULE_NAME[row.entry.ruleKey])}
                        >
                          <UI.Text lines={2} variant="muted">
                            {summarize(row.entry, translate)}
                          </UI.Text>
                          <UI.Text>
                            {translate(enforcementOf(row.entry))}
                          </UI.Text>
                          {row.checkUnavailable
                            ? (
                              <UI.Inline>
                                {row.entry.mode === "require"
                                  ? (
                                    <UI.StatusBadge status="failed">
                                      {translate(
                                        "repository.rules.check.unavailableBlocks",
                                      )}
                                    </UI.StatusBadge>
                                  )
                                  : (
                                    <UI.StatusBadge status="degraded">
                                      {translate(
                                        "repository.rules.check.unavailable",
                                      )}
                                    </UI.StatusBadge>
                                  )}
                              </UI.Inline>
                            )
                            : null}
                          {row.overrideInactive
                            ? (
                              <UI.Text variant="muted">
                                {translate("repository.rules.supersededNote")}
                              </UI.Text>
                            )
                            : null}
                        </UI.StackedRow>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <UI.DataTable<Row>
                    caption={translate("repository.rules.table.caption")}
                    captionHidden
                    columns={[
                      {
                        id: "rule",
                        header: translate("repository.rules.column.rule"),
                        cell: (row) => (
                          <UI.Stack gap="tight">
                            <UI.Text>
                              {translate(RULE_NAME[row.entry.ruleKey])}
                            </UI.Text>
                            <UI.Text
                              lines={2}
                              title={summarize(row.entry, translate)}
                              variant="muted"
                            >
                              {summarize(row.entry, translate)}
                            </UI.Text>
                          </UI.Stack>
                        ),
                      },
                      {
                        id: "enforcement",
                        header: translate(
                          "repository.rules.column.enforcement",
                        ),
                        cell: enforcement,
                        width: "280px",
                      },
                      {
                        id: "source",
                        header: translate("repository.rules.column.source"),
                        cell: sourceBadge,
                        width: "180px",
                      },
                    ]}
                    emptyMessage={translate("repository.rules.empty.title")}
                    error={translate("repository.rules.loadError")}
                    getRowKey={(row) => row.entry.ruleKey}
                    rows={rows}
                    state="ready"
                    variant="table"
                  />
                )}
              <UI.Stack data-testid="repository-rules-footer" gap="compact">
                <UI.Inline>
                  <UI.Text variant="muted">
                    {translate("repository.rules.checks.label")}
                  </UI.Text>
                  {checks?.state === "unavailable"
                    ? (
                      <UI.StatusBadge status="degraded">
                        {translate("repository.rules.checks.unavailable", {
                          count: checks.unavailableRuleKeys.length,
                        })}
                      </UI.StatusBadge>
                    )
                    : checks?.state === "configured"
                    ? (
                      <UI.StatusBadge status="healthy">
                        {translate("repository.rules.checks.configured")}
                      </UI.StatusBadge>
                    )
                    : (
                      <UI.Badge>
                        {translate("repository.rules.checks.notRequired")}
                      </UI.Badge>
                    )}
                </UI.Inline>
                <UI.Inline>
                  <UI.Text variant="muted">
                    {translate("repository.rules.protection.label")}
                  </UI.Text>
                  {
                    /*
                    Always "Unknown": Bakery does not read the provider's
                    branch protection, so it never says "not configured" or
                    shows a warning for what it has not checked.
                  */
                  }
                  <UI.Badge data-testid="repository-rules-protection">
                    {translate("repository.rules.protection.unknown")}
                  </UI.Badge>
                  {protectionReason
                    ? (
                      <UI.Text variant="muted">
                        {translate(protectionReason)}
                      </UI.Text>
                    )
                    : null}
                </UI.Inline>
                {counts.locked > 0
                  ? (
                    <UI.Text variant="hint">
                      {translate("repository.rules.footnote.locked")}
                    </UI.Text>
                  )
                  : null}
              </UI.Stack>
            </>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
