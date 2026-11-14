import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

/** How many characters of the fingerprint the page shows; the full value is the title. */
const FINGERPRINT_CHARS = 8;
const ORGANIZATION_RULES_PATH = "/settings/organization/repository-rules";
const PROJECTS_PATH = "/projects";

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
 * repository, rule by rule, who set each one, and whether anything blocks
 * delivery. Read only. The server decides who may read it (Developer access)
 * and every value on the page; nothing here is policy of its own.
 */
export function RepositoryRulesPage(
  { repositoryId }: { repositoryId: string },
) {
  const api = useBakeryApi();
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const navigate = useNavigate();
  const { scope, waiting } = useRulesScope();
  const [copyResult, setCopyResult] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copied = copyResult === "copied";
  // The result is announced and then forgotten, so the label returns to "Copy".
  useEffect(() => {
    // A refused copy stays, with the whole value to select, until the next copy works.
    if (copyResult !== "copied") return;
    const timer = globalThis.setTimeout(() => setCopyResult("idle"), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [copyResult]);

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
    defaults: rows.filter((row) => row.provenance === "inherited").length,
    own: rows.filter((row) => row.provenance === "repository_override").length,
    only: rows.filter((row) => row.provenance === "repository_only").length,
  };

  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(data?.digest ?? "");
      setCopyResult("copied");
    } catch {
      setCopyResult("failed");
    }
  };
  /** A link that navigates inside the app and is still a real link. */
  const link = (path: string, label: string, variant?: "button") => (
    <UI.Link
      href={path}
      onClick={(event) => {
        event.preventDefault();
        void navigate({ to: path });
      }}
      variant={variant}
    >
      {label}
    </UI.Link>
  );
  // A wide screen has the button at the end of the title row; on a phone the
  // heaviest thing above the content would be a full-width box, so it is a link.
  const organizationRulesLink = link(
    ORGANIZATION_RULES_PATH,
    translate("repository.rules.viewOrganization"),
    phone ? undefined : "button",
  );

  const enforcementHelp = (
    <UI.HelpTip
      closeLabel={translate("repository.rules.help.close")}
      label={translate("repository.rules.help.enforcement")}
    >
      {translate("repository.rules.column.enforcement.help")}
    </UI.HelpTip>
  );
  const sourceHelp = (
    <UI.HelpTip
      closeLabel={translate("repository.rules.help.close")}
      label={translate("repository.rules.help.source")}
    >
      {translate("repository.rules.column.source.help")}
    </UI.HelpTip>
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
  /** No working check: a pill that is red when it blocks delivery, and for that case the next step in words. */
  const checkWarning = (row: Row) =>
    row.checkUnavailable
      ? (
        <>
          <UI.Inline>
            <UI.Badge
              tone={row.entry.mode === "require" ? "danger" : "warning"}
            >
              {translate("repository.rules.check.unavailable")}
            </UI.Badge>
          </UI.Inline>
          {row.entry.mode === "require"
            ? (
              <UI.Text variant="muted">
                {translate("repository.rules.check.blocks")}
              </UI.Text>
            )
            : null}
        </>
      )
      : null;
  const enforcement = (row: Row) => (
    <UI.Stack gap="tight">
      <span>{translate(enforcementOf(row.entry))}</span>
      {checkWarning(row)}
    </UI.Stack>
  );

  const checks = data?.checkers;
  const protectionReason = data?.providerProtection.reason === "not_checked"
    ? "repository.rules.protection.notChecked"
    : data?.providerProtection.reason === "provider_not_connected"
    ? "repository.rules.protection.notConnected"
    : null;
  const summary = data
    ? data.organizationRevision === 0 && counts.own + counts.only === 0
      ? translate("repository.rules.summary.noOrganizationRules")
      : [
        translate("repository.rules.summary.counts", counts),
        counts.only > 0
          ? translate("repository.rules.summary.repositoryOnly", {
            count: counts.only,
          })
          : null,
      ].filter(Boolean).join(" ")
    : "";
  // The 8-character form: at the end of the row beside Copy on a wide screen,
  // under the label on a phone, where the action is narrow.
  const shortFingerprint = data
    ? (
      <UI.DataText
        data-testid="repository-rules-digest"
        title={data.digest}
        variant="code"
      >
        {data.digest.slice(0, FINGERPRINT_CHARS)}
      </UI.DataText>
    )
    : null;
  const version = (value: number | null) =>
    value && value > 0
      ? String(value)
      : translate("repository.rules.details.none");

  return (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              label: translate("repository.rules.breadcrumb.projects"),
              href: PROJECTS_PATH,
            },
            ...(repositoryName ? [{ label: repositoryName }] : []),
            { label: translate("repository.rules.title") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="repository-rules">
        <UI.Inline variant="between">
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
          </UI.Stack>
          {/* With no rules the empty state carries this link, so it appears once. */}
          {data && rows.length > 0 ? organizationRulesLink : null}
        </UI.Inline>
        {waiting && refused
          ? (
            <UI.AlertBanner
              action={link(
                PROJECTS_PATH,
                translate("repository.rules.unavailable.back"),
              )}
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
              description={translate("repository.rules.error.body")}
              title={translate("repository.rules.loadError")}
            />
          )
          : null}
        {data && rows.length === 0
          ? (
            <UI.EmptyState
              action={organizationRulesLink}
              description={translate("repository.rules.empty.description")}
              title={translate("repository.rules.empty.title")}
            />
          )
          : null}
        {data && rows.length > 0
          ? (
            <>
              <UI.Text data-testid="repository-rules-summary">
                {summary}
              </UI.Text>
              {phone
                ? (
                  <>
                    <UI.VisuallyHidden as="div">
                      <UI.Heading level="section">
                        {translate("repository.rules.list.title")}
                      </UI.Heading>
                    </UI.VisuallyHidden>
                    <UI.Inline>
                      <UI.Inline gap="compact">
                        <UI.Text>
                          {translate("repository.rules.column.enforcement")}
                        </UI.Text>
                        {enforcementHelp}
                      </UI.Inline>
                      <UI.Inline gap="compact">
                        <UI.Text>
                          {translate("repository.rules.column.source")}
                        </UI.Text>
                        {sourceHelp}
                      </UI.Inline>
                    </UI.Inline>
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
                            {checkWarning(row)}
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
                  </>
                )
                : (
                  <UI.DataTable<Row>
                    caption={translate("repository.rules.table.caption")}
                    captionHidden
                    columns={[
                      {
                        id: "rule",
                        width: "50%",
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
                        width: "25%",
                        header: (
                          <UI.Inline gap="compact">
                            <span>
                              {translate("repository.rules.column.enforcement")}
                            </span>
                            {enforcementHelp}
                          </UI.Inline>
                        ),
                        cell: enforcement,
                      },
                      {
                        id: "source",
                        width: "25%",
                        header: (
                          <UI.Inline gap="compact">
                            <span>
                              {translate("repository.rules.column.source")}
                            </span>
                            {sourceHelp}
                          </UI.Inline>
                        ),
                        cell: sourceBadge,
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
              <UI.Stack data-testid="repository-rules-checks" gap="compact">
                <UI.Heading level="section">
                  {translate("repository.rules.checks.title")}
                </UI.Heading>
                <UI.DescriptionList>
                  <UI.DescriptionItem
                    action={checks?.state === "unavailable"
                      ? (
                        <UI.Badge tone="warning">
                          {translate("repository.rules.checks.unavailable", {
                            count: checks.unavailableRuleKeys.length,
                          })}
                        </UI.Badge>
                      )
                      : checks?.state === "configured"
                      ? (
                        <UI.Badge tone="success">
                          {translate("repository.rules.checks.configured")}
                        </UI.Badge>
                      )
                      : (
                        <UI.Badge>
                          {translate("repository.rules.checks.notRequired")}
                        </UI.Badge>
                      )}
                    title={translate("repository.rules.checks.bakery")}
                  />
                  {
                    /*
                    Always "Unknown": Bakery does not read the provider's
                    branch protection, so it never says "not configured" or
                    shows a warning for what it has not checked.
                  */
                  }
                  <UI.DescriptionItem
                    action={
                      <UI.Badge data-testid="repository-rules-protection">
                        {translate("repository.rules.protection.unknown")}
                      </UI.Badge>
                    }
                    description={protectionReason
                      ? translate(protectionReason)
                      : undefined}
                    title={translate("repository.rules.protection.label")}
                  />
                </UI.DescriptionList>
                {counts.locked > 0
                  ? (
                    <UI.Text
                      data-testid="repository-rules-locked-note"
                      variant="hint"
                    >
                      {translate("repository.rules.locked.note")} {link(
                        ORGANIZATION_RULES_PATH,
                        translate("repository.rules.locked.link"),
                      )}.
                    </UI.Text>
                  )
                  : null}
              </UI.Stack>
              <UI.Stack data-testid="repository-rules-details" gap="compact">
                <UI.Heading level="section">
                  {translate("repository.rules.details.title")}
                </UI.Heading>
                <UI.DescriptionList>
                  <UI.DescriptionItem
                    action={
                      <UI.Text>{version(data.organizationRevision)}</UI.Text>
                    }
                    title={translate("repository.rules.details.organization")}
                  />
                  <UI.DescriptionItem
                    action={<UI.Text>{version(data.profileRevision)}</UI.Text>}
                    title={translate("repository.rules.details.repository")}
                  />
                  <UI.DescriptionItem
                    action={
                      <UI.Inline gap="compact">
                        {copyResult === "failed" || phone
                          ? null
                          : shortFingerprint}
                        <UI.Button
                          onClick={() => void copyFingerprint()}
                          type="button"
                          variant="secondary"
                        >
                          {translate(
                            copied
                              ? "repository.rules.details.copied"
                              : "repository.rules.details.copy",
                          )}
                        </UI.Button>
                      </UI.Inline>
                    }
                    description={copyResult === "failed"
                      ? (
                        <UI.Stack gap="tight">
                          <UI.Text role="alert" variant="error">
                            {translate("repository.rules.details.copyFailed")}
                          </UI.Text>
                          <UI.DataText
                            data-testid="repository-rules-digest"
                            variant="code"
                          >
                            {data.digest}
                          </UI.DataText>
                        </UI.Stack>
                      )
                      : phone
                      ? shortFingerprint
                      : undefined}
                    title={
                      <>
                        <UI.VisuallyHidden as="div" role="status">
                          {copyResult === "copied"
                            ? translate("repository.rules.details.copied")
                            : ""}
                        </UI.VisuallyHidden>
                        {translate("repository.rules.details.fingerprint")}
                        <UI.HelpTip
                          closeLabel={translate("repository.rules.help.close")}
                          label={translate("repository.rules.help.fingerprint")}
                        >
                          {translate(
                            "repository.rules.details.fingerprint.help",
                          )}
                        </UI.HelpTip>
                      </>
                    }
                  />
                </UI.DescriptionList>
              </UI.Stack>
            </>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
