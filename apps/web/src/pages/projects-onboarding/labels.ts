import type { CursorControlsLabels } from "@bakery/ui";
import type { ProfileRevisionState } from "./identity.ts";
import type { ProjectValidationError } from "./validation.ts";

export type ProjectsOnboardingLabels = Readonly<{
  title: string;
  description: string;
  scopeRequired: string;
  errors: Readonly<{
    load: string;
    mutation: string;
    conflict: string;
    retry: string;
  }>;
  validation: Readonly<Record<ProjectValidationError, string>>;
  pagination: CursorControlsLabels;
  applications: Readonly<{
    heading: string;
    description: string;
    listCaption: string;
    empty: string;
    createHeading: string;
    editHeading: string;
    fields: Readonly<{
      slug: string;
      name: string;
      description: string;
    }>;
    actions: Readonly<{
      create: string;
      creating: string;
      save: string;
      saving: string;
      archive: string;
      reactivate: string;
    }>;
    status: Readonly<{
      active: string;
      archived: string;
    }>;
    columnStatus: string;
  }>;
  repositories: Readonly<{
    heading: string;
    description: string;
    listCaption: string;
    empty: string;
    createHeading: string;
    editHeading: string;
    fields: Readonly<{
      slug: string;
      application: string;
      integrationConnectionId: string;
      providerRepoId: string;
      owner: string;
      name: string;
      defaultBranch: string;
    }>;
    actions: Readonly<{
      create: string;
      creating: string;
      save: string;
      saving: string;
      archive: string;
      reactivate: string;
    }>;
    status: Readonly<{
      active: string;
      archived: string;
      noActiveProfile: string;
    }>;
  }>;
  profiles: Readonly<{
    heading: string;
    description: string;
    listCaption: string;
    empty: string;
    revision: string;
    revisionNumber: (revision: number) => string;
    state: string;
    created: string;
    digest: string;
    active: string;
    readOnly: string;
    repositoryRequired: string;
    createHeading: string;
    worktreeRoot: string;
    allowedPatterns: string;
    revisionInput: string;
    create: string;
    creating: string;
    activate: string;
    select: string;
    selected: string;
    selectionRequired: string;
    enforcedHeading: string;
    enforcedDescription: string;
    repositoryIdentity: string;
    profileId: string;
    baseBranch: string;
    workflow: string;
    invalidConfig: string;
    configOnly: string;
  }>;
  taskScope: Readonly<{
    heading: string;
    description: string;
    title: string;
    taskDescription: string;
    taskType: string;
    types: Readonly<Record<"feature" | "bug" | "maintenance" | "epic", string>>;
    create: string;
    creating: string;
    created: string;
    taskId: string;
    noRun: string;
    newTask: string;
    setupRequired: string;
    forbidden: string;
    conflict: string;
    offline: string;
    reconnecting: string;
    error: string;
  }>;
  bindings: Readonly<{
    heading: string;
    description: string;
    empty: string;
    create: string;
    edit: string;
    save: string;
    archive: string;
    reactivate: string;
    cancel: string;
    applicationRequired: string;
    repository: string;
    role: string;
    alias: string;
    aliasShort: string;
    provenance: string;
    status: string;
    active: string;
    archived: string;
    invalid: string;
  }>;
  resolver: Readonly<{
    heading: string;
    description: string;
    mode: string;
    repository: string;
    role: string;
    aliases: string;
    aliasesHint: string;
    resolve: string;
    resolving: string;
    unavailable: string;
    resolved: string;
    ambiguous: string;
    foreign: string;
    truncated: string;
    noProfile: string;
    profile: string;
    invalid: string;
    reasons: Readonly<
      Record<
        "no_matching_binding" | "repository_not_found" | "repository_archived",
        string
      >
    >;
  }>;
  observedExecutionAdmission: string;
  profileStates: Readonly<Record<ProfileRevisionState, string>>;
}>;
