import type { MessageKey, Translator } from "@bakery/i18n";
import type { OrganizationRepositoryRulesResponse } from "../../api/client.ts";

export type RuleEntry = OrganizationRepositoryRulesResponse["entries"][number];
export type RuleKey = RuleEntry["ruleKey"];

/** The built-in rules, in the order every repository rules page lists them. */
export const RULE_KEYS: readonly RuleKey[] = [
  "commits.semantic",
  "changeRequest.semanticTitle",
  "changeRequest.description",
  "code.magicNumbers",
  "code.magicStrings",
];

export const RULE_NAME: Readonly<Record<RuleKey, MessageKey>> = {
  "commits.semantic": "settings.repositoryRules.rule.commits.semantic",
  "changeRequest.semanticTitle":
    "settings.repositoryRules.rule.changeRequest.semanticTitle",
  "changeRequest.description":
    "settings.repositoryRules.rule.changeRequest.description",
  "code.magicNumbers": "settings.repositoryRules.rule.code.magicNumbers",
  "code.magicStrings": "settings.repositoryRules.rule.code.magicStrings",
};

export function isRuleKey(value: string): value is RuleKey {
  return (RULE_KEYS as readonly string[]).includes(value);
}

/** The one line under a rule's name: what it checks, from its options. */
export function summarize(entry: RuleEntry, translate: Translator): string {
  switch (entry.ruleKey) {
    case "commits.semantic":
      return translate(
        entry.options.range === "all_commits"
          ? "settings.repositoryRules.summary.commits.allCommits"
          : "settings.repositoryRules.summary.commits.finalSquash",
      );
    case "changeRequest.semanticTitle":
      return translate(
        entry.options.scope === "required"
          ? "settings.repositoryRules.summary.title.scopeRequired"
          : "settings.repositoryRules.summary.title.scopeOptional",
        { max: entry.options.maxSubjectLength },
      );
    case "changeRequest.description":
      return entry.options.requiredSections.length === 0
        ? translate("settings.repositoryRules.summary.description.none")
        : translate("settings.repositoryRules.summary.description", {
          sections: entry.options.requiredSections.join(", "),
        });
    case "code.magicNumbers":
      return entry.options.allowedNumbers.length === 0
        ? translate("settings.repositoryRules.summary.numbers.none")
        : translate("settings.repositoryRules.summary.numbers.allowed", {
          numbers: entry.options.allowedNumbers.join(", "),
        });
    case "code.magicStrings":
      return translate("settings.repositoryRules.summary.strings", {
        count: entry.options.allowedLiterals.length,
      });
  }
}

/** Enforcement as people read it: a switched-off rule is Off whatever its mode. */
export function enforcementOf(entry: RuleEntry): MessageKey {
  if (!entry.enabled) return "settings.repositoryRules.mode.off";
  return `settings.repositoryRules.mode.${entry.mode}`;
}

/** Whether repositories may override the rule, as people read it. */
export function accessOf(entry: RuleEntry): MessageKey {
  return entry.locked
    ? "settings.repositoryRules.access.locked"
    : "settings.repositoryRules.access.override";
}
