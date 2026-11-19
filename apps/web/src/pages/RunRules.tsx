import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  repositoryEffectiveRulesQueryOptions,
  runChecksQueryOptions,
  taskQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { FingerprintRow } from "./FingerprintRow.tsx";
import {
  compareRules,
  type RulesComparison,
  type RunRulesFacts,
  runRulesFacts,
} from "./run-rules.ts";

/** What the run's "Rules this run used" block has to say. */
export type RunRulesModel =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "error"; retry: () => void }>
  /** The repository's settings name no checks: runs there record no fingerprint. */
  | Readonly<{ kind: "noFixedPolicy"; repositoryId: string | null }>
  /** No check recorded the rules yet, or none ran. */
  | Readonly<{ kind: "notRecorded"; repositoryId: string | null }>
  | Readonly<{
    kind: "recorded";
    facts: RunRulesFacts;
    comparison: RulesComparison;
    repositoryId: string | null;
  }>;

/**
 * The rules and checks a run was held to (from its check rows, fixed when it
 * was admitted) set beside the rules in force now (from the repository's
 * effective-rules read, whose fingerprint is calculated the way a run records
 * it). The comparison is left out when the current rules cannot be read.
 */
export function useRunRules(
  { taskId, runId, enabled }: Readonly<{
    taskId: string;
    runId: string;
    enabled: boolean;
  }>,
): RunRulesModel {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const checks = useQuery({
    ...runChecksQueryOptions(api, scope, runId),
    enabled: enabled && Boolean(scope.organizationId),
  });
  const task = useQuery({
    ...taskQueryOptions(api, scope, taskId),
    enabled: enabled && Boolean(scope.organizationId),
  });
  const repositoryId = task.data?.repositoryId ?? null;
  const rules = useQuery({
    ...repositoryEffectiveRulesQueryOptions(api, scope, repositoryId ?? ""),
    enabled: enabled && repositoryId !== null && Boolean(scope.organizationId),
  });
  if (checks.isError) {
    const failure = checks.error;
    return failure.kind === "problem" && failure.problem.status === 403
      ? { kind: "forbidden" }
      : { kind: "error", retry: () => void checks.refetch() };
  }
  if (!checks.data) return { kind: "loading" };
  const facts = runRulesFacts(checks.data.items);
  if (facts.rules.length === 0) {
    return rules.data?.hasFixedPolicy === false
      ? { kind: "noFixedPolicy", repositoryId }
      : { kind: "notRecorded", repositoryId };
  }
  return {
    kind: "recorded",
    facts,
    comparison: compareRules(facts, rules.data?.digest),
    repositoryId,
  };
}

function RulesLink(
  { repositoryId, children }: Readonly<{
    repositoryId: string;
    children: string;
  }>,
) {
  return (
    <RouterLink
      params={{ repositoryId }}
      to="/projects/repositories/$repositoryId/rules"
    >
      {children}
    </RouterLink>
  );
}

/**
 * The one muted line in the closed state, only when the rules changed after
 * the run started. Its button opens the Details disclosure and puts focus on
 * the block's heading.
 */
export function RunRulesChangedNotice(
  { model, onShowDetails }: Readonly<{
    model: RunRulesModel;
    onShowDetails: () => void;
  }>,
) {
  const { translate: t } = useI18n();
  if (model.kind !== "recorded" || model.comparison !== "changed") return null;
  return (
    <UI.Inline gap="compact">
      <UI.Text variant="muted" data-testid="run-rules-changed-notice">
        {t("tasks.run.rules.changedNotice")}
      </UI.Text>
      <UI.Button onClick={onShowDetails} type="button" variant="text">
        {t("tasks.run.rules.showDetails")}
      </UI.Button>
    </UI.Inline>
  );
}

/** What goes inside Details, under the run id. */
export function RunRulesDetails(
  { model, finished, settingsVersion, stepNames }: Readonly<{
    model: RunRulesModel;
    finished: boolean;
    /** The repository settings version the run started under, when known. */
    settingsVersion: number | null;
    /** Step names by id, for "from {step}" when a run holds more than one fingerprint. */
    stepNames: ReadonlyMap<string, string>;
  }>,
) {
  const { translate: t } = useI18n();
  const copyFailed = t("tasks.fingerprint.copyFailed");
  const heading = (
    <UI.Heading
      data-testid="run-rules-heading"
      level="subsection-compact"
      tabIndex={-1}
    >
      {t("tasks.run.rules.heading")}
    </UI.Heading>
  );
  if (model.kind === "loading") {
    return (
      <UI.Stack gap="tight" data-testid="run-rules">
        {heading}
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (model.kind === "forbidden") {
    return (
      <UI.Stack gap="tight" data-testid="run-rules">
        {heading}
        <UI.Text variant="muted">{t("tasks.run.rules.forbidden")}</UI.Text>
      </UI.Stack>
    );
  }
  if (model.kind === "error") {
    return (
      <UI.Stack gap="tight" data-testid="run-rules">
        {heading}
        <UI.Text role="alert" variant="error">
          {t("tasks.run.rules.loadFailed")}
        </UI.Text>
        <UI.Inline gap="compact">
          <UI.Button onClick={model.retry} type="button" variant="secondary">
            {t("core.actions.retry")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    );
  }
  const version = settingsVersion === null
    ? null
    : (
      <UI.Text data-testid="run-rules-settings-version">
        {t("tasks.run.rules.settingsVersion", {
          version: String(settingsVersion),
        })}
      </UI.Text>
    );
  const open = model.repositoryId === null
    ? null
    : (
      <RulesLink repositoryId={model.repositoryId}>
        {t("tasks.run.rules.open")}
      </RulesLink>
    );
  if (model.kind === "noFixedPolicy" || model.kind === "notRecorded") {
    return (
      <UI.Stack gap="tight" data-testid="run-rules">
        {heading}
        <UI.Text variant="muted" data-testid="run-rules-state">
          {t(
            model.kind === "noFixedPolicy"
              ? "tasks.run.rules.noFixedPolicy"
              : finished
              ? "tasks.run.rules.notRecorded.finished"
              : "tasks.run.rules.notRecorded.running",
          )}
        </UI.Text>
        {version}
        {open}
      </UI.Stack>
    );
  }
  const { facts, comparison } = model;
  return (
    <UI.Stack gap="tight" data-testid="run-rules">
      {heading}
      <UI.Text variant="muted">
        {t(
          finished ? "tasks.run.rules.fixed.finished" : "tasks.run.rules.fixed",
        )}
      </UI.Text>
      {facts.rules.map((rule) => {
        const step = rule.stepId === null
          ? undefined
          : stepNames.get(rule.stepId);
        return (
          <FingerprintRow
            copyFailedText={copyFailed}
            fingerprint={rule.digest}
            helpText={t("tasks.run.rules.fingerprint.help")}
            key={rule.digest}
            label={t("tasks.run.rules.fingerprint")}
            note={facts.rules.length > 1 && step !== undefined
              ? t("tasks.run.rules.fromStep", { step })
              : undefined}
            testId="run-rules-fingerprint"
          />
        );
      })}
      {facts.checks === null
        ? (
          <UI.Text variant="muted" data-testid="run-rules-no-checks">
            {t("tasks.run.rules.noChecks")}
          </UI.Text>
        )
        : (
          <FingerprintRow
            copyFailedText={copyFailed}
            fingerprint={facts.checks}
            helpText={t("tasks.run.rules.checks.help")}
            label={t("tasks.run.rules.checks")}
            testId="run-checks-fingerprint"
          />
        )}
      {version}
      {comparison === "same"
        ? (
          <UI.Stack gap="tight" data-testid="run-rules-comparison">
            <UI.Text>
              <UI.IconGlyph name="check" size="small" />{" "}
              {t("tasks.run.rules.same")}
            </UI.Text>
            {open}
          </UI.Stack>
        )
        : comparison === "changed"
        ? (
          <UI.Stack gap="tight" data-testid="run-rules-comparison">
            <UI.Text>
              <UI.IconGlyph name="caution" size="small" /> {t(
                finished
                  ? "tasks.run.rules.changed.finished"
                  : "tasks.run.rules.changed.running",
              )}
            </UI.Text>
            {model.repositoryId === null
              ? null
              : (
                <RulesLink repositoryId={model.repositoryId}>
                  {t("tasks.run.rules.seeCurrent")}
                </RulesLink>
              )}
          </UI.Stack>
        )
        : open}
    </UI.Stack>
  );
}
