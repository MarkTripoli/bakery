import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  emptyRow,
  MAX_RULES,
  type RepositoryFacts,
  type RuleProblem,
  type RuleRow,
} from "./routing-model.ts";

/** What the page knows about the labels GitHub lists for this repository. */
export type LabelChoices =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly retry: () => void }
  | {
    readonly state: "ready";
    readonly items: readonly { readonly id: string; readonly name: string }[];
  };

/**
 * "Where the work goes" (#69, design section 4): the repository the issues are
 * worked in, and the optional rules that send an issue with a label to another
 * repository. Saving is the page's one Save; this only edits the list.
 */
export function RoutingRules(
  {
    rows,
    onChange,
    disabled,
    home,
    labels,
    repositories,
    repositoryName,
    problems,
  }: {
    readonly rows: readonly RuleRow[];
    readonly onChange: (rows: RuleRow[]) => void;
    readonly disabled: boolean;
    /** The repository these settings belong to, e.g. "acme/web". */
    readonly home: string;
    readonly labels: LabelChoices;
    /** Every repository the application knows, by id. */
    readonly repositories: ReadonlyMap<string, RepositoryFacts>;
    readonly repositoryName: (id: string) => string;
    readonly problems: ReadonlyMap<string, RuleProblem>;
  },
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const known = labels.state === "ready" ? labels.items : [];
  const labelOptions = (row: RuleRow) => {
    const options = known.map((label) => ({
      label: label.name,
      value: label.id,
    }));
    // A saved rule keeps showing its label even when GitHub no longer lists it.
    if (
      row.labelId !== "" && !known.some((label) => label.id === row.labelId)
    ) {
      options.unshift({ label: row.labelName, value: row.labelId });
    }
    return [
      {
        label: translate("issues.settings.routing.label.choose" as never),
        value: "",
      },
      ...options,
    ];
  };
  const repositoryOptions = (row: RuleRow) => {
    const options = [...repositories.values()]
      .filter((facts) =>
        (!facts.archived && facts.role !== null) ||
        facts.id === row.repositoryId
      )
      .map((facts) => ({
        label: repositoryName(facts.id),
        value: facts.id,
      }));
    return [
      {
        label: translate("issues.settings.routing.repository.choose" as never),
        value: "",
      },
      ...options,
    ];
  };
  const change = (key: string, patch: Partial<RuleRow>) =>
    onChange(rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const full = rows.length >= MAX_RULES;
  const Row = phone ? UI.Stack : UI.Inline;

  return (
    <UI.Stack gap="standard" data-testid="issue-settings-routing">
      <UI.Stack gap="compact">
        <UI.Heading level="section">
          {translate("issues.settings.routing.title" as never)}
        </UI.Heading>
        <UI.Text>
          {translate("issues.settings.routing.home" as never, {
            repository: home,
          })}
        </UI.Text>
      </UI.Stack>
      <UI.Stack gap="compact">
        <UI.Heading level="subsection">
          {translate("issues.settings.routing.byLabel" as never)}
        </UI.Heading>
        {labels.state === "error"
          ? (
            <UI.InlineNotice
              tone="warning"
              action={
                <UI.Button
                  variant="secondary"
                  onClick={labels.retry}
                  type="button"
                >
                  {translate("issues.settings.routing.labels.retry" as never)}
                </UI.Button>
              }
            >
              {translate("issues.settings.routing.labels.error" as never)}
            </UI.InlineNotice>
          )
          : null}
        {rows.length === 0
          ? (
            <UI.Text variant="muted">
              {translate("issues.settings.routing.none" as never)}
            </UI.Text>
          )
          : (
            <UI.Stack gap="standard" role="list">
              {rows.map((row, index) => {
                const problem = problems.get(row.key) ?? null;
                const role = repositories.get(row.repositoryId)?.role ?? null;
                return (
                  <UI.Stack
                    gap="compact"
                    key={row.key}
                    role="listitem"
                    data-testid="routing-rule"
                  >
                    <Row
                      gap="compact"
                      {...(phone ? {} : { "data-ui-region": "routing-rule" })}
                    >
                      <UI.Combobox
                        aria-describedby={problem === "duplicate"
                          ? `routing-problem-${row.key}`
                          : undefined}
                        aria-invalid={problem === "duplicate" || undefined}
                        disabled={disabled || labels.state === "loading"}
                        label={translate(
                          "issues.settings.routing.label" as never,
                        )}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          const picked = labelOptions(row).find((option) =>
                            option.value === value
                          );
                          change(row.key, {
                            labelId: value,
                            labelName: value === "" ? "" : picked?.label ?? "",
                          });
                        }}
                        options={labelOptions(row)}
                        value={row.labelId}
                      />
                      <UI.Combobox
                        aria-describedby={problem !== null &&
                            problem !== "duplicate"
                          ? `routing-problem-${row.key}`
                          : undefined}
                        aria-invalid={(problem !== null &&
                          problem !== "duplicate") ||
                          undefined}
                        disabled={disabled}
                        label={translate(
                          "issues.settings.routing.repository" as never,
                        )}
                        onChange={(event) =>
                          change(row.key, {
                            repositoryId: event.currentTarget.value,
                          })}
                        options={repositoryOptions(row)}
                        value={row.repositoryId}
                      />
                      <UI.Text variant="muted">
                        {role === null
                          ? ""
                          : translate("issues.settings.routing.role" as never, {
                            role,
                          })}
                      </UI.Text>
                      {phone
                        ? (
                          <UI.Button
                            data-ui-region="routing-rule-remove"
                            aria-label={translate(
                              "issues.settings.routing.remove" as never,
                              {
                                number: index + 1,
                              },
                            )}
                            disabled={disabled}
                            onClick={() =>
                              onChange(
                                rows.filter((one) => one.key !== row.key),
                              )}
                            type="button"
                            variant="quiet"
                          >
                            {translate(
                              "issues.settings.routing.removeShort" as never,
                            )}
                          </UI.Button>
                        )
                        : (
                          <UI.Tooltip
                            content={translate(
                              "issues.settings.routing.removeShort" as never,
                            )}
                          >
                            <UI.IconButton
                              disabled={disabled}
                              label={translate(
                                "issues.settings.routing.remove" as never,
                                {
                                  number: index + 1,
                                },
                              )}
                              onClick={() =>
                                onChange(
                                  rows.filter((one) => one.key !== row.key),
                                )}
                              variant="compact"
                            >
                              <UI.IconGlyph name="close" size="small" />
                            </UI.IconButton>
                          </UI.Tooltip>
                        )}
                    </Row>
                    {problem === null ? null : (
                      <UI.Text
                        id={`routing-problem-${row.key}`}
                        role="alert"
                        variant="error"
                      >
                        {translate(
                          `issues.settings.routing.problem.${problem}` as never,
                          {
                            repository: repositoryName(row.repositoryId),
                          },
                        )}
                      </UI.Text>
                    )}
                  </UI.Stack>
                );
              })}
            </UI.Stack>
          )}
        <UI.Inline gap="compact">
          <UI.Button
            disabled={disabled || full}
            onClick={() => onChange([...rows, emptyRow()])}
            type="button"
            variant="secondary"
          >
            {translate("issues.settings.routing.add" as never)}
          </UI.Button>
          {full
            ? (
              <UI.Text variant="muted">
                {translate("issues.settings.routing.full" as never, {
                  max: MAX_RULES,
                })}
              </UI.Text>
            )
            : null}
        </UI.Inline>
        <UI.Text variant="muted">
          {translate("issues.settings.routing.help" as never, {
            repository: home,
          })}
        </UI.Text>
      </UI.Stack>
    </UI.Stack>
  );
}
