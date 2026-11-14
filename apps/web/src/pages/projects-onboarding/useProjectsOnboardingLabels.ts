import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { ProjectsOnboardingLabels } from "./labels.ts";

/** Builds the onboarding page labels from the active catalog. */
export function useProjectsOnboardingLabels(): ProjectsOnboardingLabels {
  const { translate } = useI18n();
  return {
    title: translate("projects.onboarding.title"),
    projectsList: translate("projects.list.title"),
    description: translate("projects.onboarding.description"),
    scopeRequired: translate("projects.onboarding.scopeRequired"),
    errors: {
      load: translate("projects.onboarding.errors.load"),
      mutation: translate("projects.onboarding.errors.mutation"),
      conflict: translate("projects.onboarding.errors.conflict"),
      retry: translate("projects.onboarding.errors.retry"),
    },
    validation: {
      required: translate("projects.onboarding.validation.required"),
      invalidSlug: translate("projects.onboarding.validation.invalidSlug"),
      tooLong: translate("projects.onboarding.validation.tooLong"),
      invalidIdentity: translate(
        "projects.onboarding.validation.invalidIdentity",
      ),
      invalidUuid: translate("projects.onboarding.validation.invalidUuid"),
      selectApplication: translate(
        "projects.onboarding.validation.selectApplication",
      ),
    },
    pagination: {
      controls: translate("projects.onboarding.pagination.controls"),
      end: translate("projects.onboarding.pagination.endOfResults"),
      loadMore: translate("projects.onboarding.pagination.loadMore"),
      loading: translate("projects.onboarding.pagination.loading"),
      next: translate("projects.onboarding.pagination.next"),
      previous: translate("projects.onboarding.pagination.previous"),
      retry: translate("projects.onboarding.pagination.retry"),
    },
    applications: {
      heading: translate("projects.onboarding.applications.heading"),
      description: translate("projects.onboarding.applications.description"),
      listCaption: translate("projects.onboarding.applications.listCaption"),
      empty: translate("projects.onboarding.applications.empty"),
      createHeading: translate(
        "projects.onboarding.applications.createHeading",
      ),
      editHeading: translate("projects.onboarding.applications.editHeading"),
      fields: {
        slug: translate("projects.onboarding.applications.fields.slug"),
        name: translate("projects.onboarding.applications.fields.name"),
        description: translate(
          "projects.onboarding.applications.fields.description",
        ),
      },
      actions: {
        create: translate("projects.onboarding.applications.actions.create"),
        creating: translate(
          "projects.onboarding.applications.actions.creating",
        ),
        save: translate("projects.onboarding.applications.actions.save"),
        saving: translate("projects.onboarding.applications.actions.saving"),
        archive: translate("projects.onboarding.applications.actions.archive"),
        reactivate: translate(
          "projects.onboarding.applications.actions.reactivate",
        ),
      },
      status: {
        active: translate("projects.onboarding.applications.status.active"),
        archived: translate("projects.onboarding.applications.status.archived"),
      },
      columnStatus: translate("projects.onboarding.applications.columnStatus"),
    },
    repositories: {
      heading: translate("projects.onboarding.repositories.heading"),
      description: translate("projects.onboarding.repositories.description"),
      listCaption: translate("projects.onboarding.repositories.listCaption"),
      empty: translate("projects.onboarding.repositories.empty"),
      createHeading: translate(
        "projects.onboarding.repositories.createHeading",
      ),
      editHeading: translate("projects.onboarding.repositories.editHeading"),
      fields: {
        application: translate(
          "projects.onboarding.repositories.fields.application",
        ),
        slug: translate("projects.onboarding.repositories.fields.slug"),
        integrationConnectionId: translate(
          "projects.onboarding.repositories.fields.integrationConnectionId",
        ),
        providerRepoId: translate(
          "projects.onboarding.repositories.fields.providerRepoId",
        ),
        owner: translate("projects.onboarding.repositories.fields.owner"),
        name: translate("projects.onboarding.repositories.fields.name"),
        defaultBranch: translate(
          "projects.onboarding.repositories.fields.defaultBranch",
        ),
      },
      actions: {
        create: translate("projects.onboarding.repositories.actions.create"),
        creating: translate(
          "projects.onboarding.repositories.actions.creating",
        ),
        save: translate("projects.onboarding.repositories.actions.save"),
        saving: translate("projects.onboarding.repositories.actions.saving"),
        archive: translate("projects.onboarding.repositories.actions.archive"),
        reactivate: translate(
          "projects.onboarding.repositories.actions.reactivate",
        ),
      },
      status: {
        active: translate("projects.onboarding.repositories.status.active"),
        archived: translate("projects.onboarding.repositories.status.archived"),
        noActiveProfile: translate(
          "projects.onboarding.repositories.status.noActiveProfile",
        ),
      },
    },
    profiles: {
      heading: translate("projects.onboarding.profiles.heading"),
      description: translate("projects.onboarding.profiles.description"),
      listCaption: translate("projects.onboarding.profiles.listCaption"),
      empty: translate("projects.onboarding.profiles.empty"),
      revision: translate("projects.onboarding.profiles.revision"),
      revisionNumber: (revision: number) =>
        translate("projects.onboarding.profiles.revisionNumber", {
          revision: String(revision),
        }),
      state: translate("projects.onboarding.profiles.state"),
      created: translate("projects.onboarding.profiles.created"),
      digest: translate("projects.onboarding.profiles.digest"),
      active: translate("projects.onboarding.profiles.active"),
      readOnly: translate("projects.onboarding.profiles.readOnly"),
      repositoryRequired: translate(
        "projects.onboarding.profiles.repositoryRequired",
      ),
      createHeading: translate("projects.onboarding.profiles.createHeading"),
      revisionInput: translate("projects.onboarding.profiles.revisionInput"),
      worktreeRoot: translate("projects.onboarding.profiles.worktreeRoot"),
      allowedPatterns: translate(
        "projects.onboarding.profiles.allowedPatterns",
      ),
      create: translate("projects.onboarding.profiles.create"),
      creating: translate("projects.onboarding.profiles.creating"),
      activate: translate("projects.onboarding.profiles.activate"),
      select: translate("projects.onboarding.profiles.select"),
      selected: translate("projects.onboarding.profiles.selected"),
      selectionRequired: translate(
        "projects.onboarding.profiles.selectionRequired",
      ),
      enforcedHeading: translate(
        "projects.onboarding.profiles.enforcedHeading",
      ),
      enforcedDescription: translate(
        "projects.onboarding.profiles.enforcedDescription",
      ),
      repositoryIdentity: translate(
        "projects.onboarding.profiles.repositoryIdentity",
      ),
      profileId: translate("projects.onboarding.profiles.profileId"),
      baseBranch: translate("projects.onboarding.profiles.baseBranch"),
      workflow: translate("projects.onboarding.profiles.workflow"),
      invalidConfig: translate("projects.onboarding.profiles.invalidConfig"),
      configOnly: translate("projects.onboarding.profiles.configOnly"),
    },
    taskScope: {
      heading: translate("projects.onboarding.taskScope.heading"),
      description: translate("projects.onboarding.taskScope.description"),
      title: translate("projects.onboarding.taskScope.title"),
      taskDescription: translate(
        "projects.onboarding.taskScope.taskDescription",
      ),
      taskType: translate("projects.onboarding.taskScope.taskType"),
      types: {
        feature: translate("projects.onboarding.taskScope.types.feature"),
        bug: translate("projects.onboarding.taskScope.types.bug"),
        maintenance: translate(
          "projects.onboarding.taskScope.types.maintenance",
        ),
        epic: translate("projects.onboarding.taskScope.types.epic"),
      },
      create: translate("projects.onboarding.taskScope.create"),
      creating: translate("projects.onboarding.taskScope.creating"),
      created: translate("projects.onboarding.taskScope.created"),
      taskId: translate("projects.onboarding.taskScope.taskId"),
      noRun: translate("projects.onboarding.taskScope.noRun"),
      newTask: translate("projects.onboarding.taskScope.newTask"),
      setupRequired: translate(
        "projects.onboarding.taskScope.setupRequired",
      ),
      forbidden: translate("projects.onboarding.taskScope.forbidden"),
      conflict: translate("projects.onboarding.taskScope.conflict"),
      offline: translate("projects.onboarding.taskScope.offline"),
      reconnecting: translate("projects.onboarding.taskScope.reconnecting"),
      error: translate("projects.onboarding.taskScope.error"),
    },
    bindings: {
      heading: translate("projects.onboarding.bindings.heading"),
      description: translate("projects.onboarding.bindings.description"),
      empty: translate("projects.onboarding.bindings.empty"),
      create: translate("projects.onboarding.bindings.create"),
      edit: translate("projects.onboarding.bindings.edit"),
      save: translate("projects.onboarding.bindings.save"),
      archive: translate("projects.onboarding.bindings.archive"),
      reactivate: translate("projects.onboarding.bindings.reactivate"),
      cancel: translate("projects.onboarding.bindings.cancel"),
      applicationRequired: translate(
        "projects.onboarding.bindings.applicationRequired",
      ),
      repository: translate("projects.onboarding.bindings.repository"),
      role: translate("projects.onboarding.bindings.role"),
      alias: translate("projects.onboarding.bindings.alias"),
      aliasShort: translate("projects.onboarding.bindings.aliasShort"),
      provenance: translate("projects.onboarding.bindings.provenance"),
      status: translate("projects.onboarding.bindings.status"),
      active: translate("projects.onboarding.bindings.active"),
      archived: translate("projects.onboarding.bindings.archived"),
      invalid: translate("projects.onboarding.bindings.invalid"),
    },
    resolver: {
      heading: translate("projects.onboarding.resolver.heading"),
      description: translate("projects.onboarding.resolver.description"),
      mode: translate("projects.onboarding.resolver.mode"),
      repository: translate("projects.onboarding.resolver.repository"),
      role: translate("projects.onboarding.resolver.role"),
      aliases: translate("projects.onboarding.resolver.aliases"),
      aliasesHint: translate("projects.onboarding.resolver.aliasesHint"),
      resolve: translate("projects.onboarding.resolver.resolve"),
      resolving: translate("projects.onboarding.resolver.resolving"),
      unavailable: translate("projects.onboarding.resolver.unavailable"),
      resolved: translate("projects.onboarding.resolver.resolved"),
      ambiguous: translate("projects.onboarding.resolver.ambiguous"),
      foreign: translate("projects.onboarding.resolver.foreign"),
      truncated: translate("projects.onboarding.resolver.truncated"),
      noProfile: translate("projects.onboarding.resolver.noProfile"),
      profile: translate("projects.onboarding.resolver.profile"),
      invalid: translate("projects.onboarding.resolver.invalid"),
      reasons: {
        no_matching_binding: translate(
          "projects.onboarding.resolver.reasons.noMatchingBinding",
        ),
        repository_not_found: translate(
          "projects.onboarding.resolver.reasons.repositoryNotFound",
        ),
        repository_archived: translate(
          "projects.onboarding.resolver.reasons.repositoryArchived",
        ),
      },
    },
    observedExecutionAdmission: translate(
      "projects.onboarding.observedExecutionAdmission",
    ),
    profileStates: {
      "legacy-v1": translate("projects.onboarding.profileStates.legacyV1"),
      "v2-observation-unavailable": translate(
        "projects.onboarding.profileStates.v2ObservationUnavailable",
      ),
    },
  };
}
