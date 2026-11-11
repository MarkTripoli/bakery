import type { RepositoryRulesActionHandlers } from "./actions.ts";
import {
  createRepositoryRuleVersionsListHandler,
  getRepositoryRules,
  publishRepositoryRuleVersion,
} from "./postgres.ts";
import { createOrganizationRulePreviewHandler } from "./previews.ts";

export function createRepositoryRulesHandlers(
  secret: string,
): RepositoryRulesActionHandlers {
  return {
    getRules: getRepositoryRules,
    publishVersion: publishRepositoryRuleVersion,
    listVersions: createRepositoryRuleVersionsListHandler(secret),
    previewOrganization: createOrganizationRulePreviewHandler(secret),
  };
}
