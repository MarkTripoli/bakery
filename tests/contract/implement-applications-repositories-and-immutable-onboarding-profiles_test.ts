import { assert } from "@std/assert";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import {
  generateContracts,
  type TransportSource,
} from "../../packages/contracts/src/contracts.ts";

const generated = generateContracts(transport as unknown as TransportSource);
const schemas = generated.schemas as Record<string, {
  safeParse(value: unknown): { success: boolean };
}>;

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000003";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000004";
const PROFILE_ID = "00000000-0000-4000-8000-000000000005";
const OBSERVATION_ID = "00000000-0000-4000-8000-000000000006";
const ROLE_BINDING_ID = "00000000-0000-4000-8000-000000000007";
const TIMESTAMP = "2024-01-01T00:00:00.000Z";
const PROFILE_DIGEST = "a".repeat(64);

function parses(schemaName: string, value: unknown): boolean {
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`missing generated schema ${schemaName}`);
  return schema.safeParse(value).success;
}

function repositoryCreate(slug: string): Record<string, unknown> {
  return {
    applicationId: APPLICATION_ID,
    slug,
    integrationConnectionId: CONNECTION_ID,
    providerRepoId: "provider-repository-1",
    owner: "bakery",
    name: "Bakery Repository",
    defaultBranch: "main",
  };
}

function roleBinding(): Record<string, unknown> {
  return {
    id: ROLE_BINDING_ID,
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    role: "build",
    alias: "primary",
    repositoryId: REPOSITORY_ID,
    repositorySlug: "bakery-repo",
    provenance: "onboarding",
    archivedAt: null,
    version: 1,
  };
}

Deno.test("repository slugs accept canonical input without changing application slug semantics", () => {
  assert(parses("RepositoryCreate", repositoryCreate("a")));
  assert(
    parses(
      "RepositoryCreate",
      repositoryCreate(`a${"-x".repeat(98)}-zz`),
    ),
  );
  assert(!parses("RepositoryCreate", repositoryCreate("")));
  assert(!parses("RepositoryCreate", repositoryCreate("a\n")));
  assert(!parses("RepositoryCreate", repositoryCreate("Repo")));
  assert(!parses("RepositoryCreate", repositoryCreate("repo_name")));
  assert(!parses("RepositoryCreate", repositoryCreate("repo.")));
  assert(!parses("RepositoryCreate", repositoryCreate("repo-")));
  assert(
    !parses("RepositoryCreate", repositoryCreate("a".repeat(201))),
  );
  assert(
    parses("ApplicationCreate", {
      slug: "app_name",
      name: "Application",
      description: "Application description",
    }),
  );
});

Deno.test("repository projections expose nullable legacy slugs and exact role binding fields", () => {
  const legacyRepository = {
    id: REPOSITORY_ID,
    applicationId: APPLICATION_ID,
    slug: null,
    integrationConnectionId: CONNECTION_ID,
    providerRepoId: "provider-repository-1",
    owner: "bakery",
    name: "Bakery Repository",
    defaultBranch: "main",
    activeProfileId: null,
    archivedAt: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: 1,
  };
  assert(parses("Repository", legacyRepository));
  assert(parses("Repository", { ...legacyRepository, slug: "bakery-repo" }));
  assert(!parses("Repository", { ...legacyRepository, slug: "a\n" }));
  assert(!parses("Repository", { ...legacyRepository, slug: undefined }));
  assert(
    !parses("Repository", {
      id: REPOSITORY_ID,
      applicationId: APPLICATION_ID,
      slug: "Repo",
      integrationConnectionId: CONNECTION_ID,
      providerRepoId: "provider-repository-1",
      owner: "bakery",
      name: "Bakery Repository",
      defaultBranch: "main",
      activeProfileId: null,
      archivedAt: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      version: 1,
    }),
  );
  assert(parses("RoleBinding", roleBinding()));
  assert(
    parses("RoleBinding", {
      ...roleBinding(),
      alias: null,
      repositorySlug: null,
      provenance: null,
    }),
  );
  assert(
    parses("Page<RoleBinding>", {
      items: [roleBinding()],
      nextCursor: null,
    }),
  );
  assert(parses("RoleBinding", { ...roleBinding(), archivedAt: TIMESTAMP }));
});

Deno.test("role selectors enforce exclusive forms, bounded aliases, and uniqueness", () => {
  assert(parses("RepositoryBindingSelector", { repositoryId: REPOSITORY_ID }));
  assert(parses("RepositoryBindingSelector", { role: "build" }));
  assert(
    parses("RepositoryBindingSelector", { role: "build", alias: "primary" }),
  );
  assert(
    parses("RepositoryBindingSelector", {
      aliases: Array.from({ length: 32 }, (_, index) => `alias-${index}`),
    }),
  );
  assert(!parses("RepositoryBindingSelector", { aliases: [] }));
  assert(
    !parses("RepositoryBindingSelector", {
      aliases: Array.from({ length: 33 }, (_, index) => `alias-${index}`),
    }),
  );
  assert(
    !parses("RepositoryBindingSelector", {
      aliases: ["primary", "primary"],
    }),
  );
  assert(
    !parses("RepositoryBindingSelector", {
      repositoryId: REPOSITORY_ID,
      role: "build",
    }),
  );
  assert(!parses("RepositoryBindingSelector", { role: "" }));
});

Deno.test("role resolution exposes every consumer-visible status and pin boundary", () => {
  const resolved = {
    status: "resolved",
    binding: {
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
      repositoryId: REPOSITORY_ID,
      repositoryProfileId: PROFILE_ID,
      repositoryProfileRevision: 2,
      repositoryProfileDigest: PROFILE_DIGEST,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    },
  };
  assert(parses("RepositoryBindingResolution", resolved));
  assert(!parses("RepositoryBindingResolution", { binding: resolved.binding }));
  const unavailableReasons = [
    "no_matching_binding",
    "repository_not_found",
    "repository_archived",
  ] as const;
  for (const reason of unavailableReasons) {
    assert(
      parses("RepositoryBindingResolution", {
        status: "unavailable",
        reason,
      }),
    );
  }
  assert(
    !parses("RepositoryBindingResolution", {
      status: "unavailable",
      reason: "undeclared_reason",
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      reason: "no_matching_binding",
    }),
  );
  const ambiguousCandidates = [
    {
      bindingId: ROLE_BINDING_ID,
      repositoryId: REPOSITORY_ID,
      role: "build",
      alias: "primary",
      provenance: null,
      repositoryArchived: false,
      profileRevision: 2,
      hasEligibleObservation: true,
    },
    {
      bindingId: "00000000-0000-4000-8000-000000000008",
      repositoryId: "00000000-0000-4000-8000-000000000009",
      role: "build",
      alias: "secondary",
      provenance: "onboarding",
      repositoryArchived: false,
      profileRevision: null,
      hasEligibleObservation: false,
    },
  ];
  assert(
    !parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: [ambiguousCandidates[0]],
      truncated: false,
    }),
  );
  assert(
    parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: ambiguousCandidates,
      truncated: false,
    }),
  );
  assert(
    parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: Array.from({ length: 32 }, (_, index) => ({
        ...ambiguousCandidates[0],
        bindingId: `00000000-0000-4000-8000-${
          String(index + 10).padStart(12, "0")
        }`,
        repositoryId: `00000000-0000-4000-8000-${
          String(index + 100).padStart(12, "0")
        }`,
      })),
      truncated: true,
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: Array.from({ length: 33 }, (_, index) => ({
        ...ambiguousCandidates[0],
        bindingId: `00000000-0000-4000-8000-${
          String(index + 10).padStart(12, "0")
        }`,
        repositoryId: `00000000-0000-4000-8000-${
          String(index + 100).padStart(12, "0")
        }`,
      })),
      truncated: true,
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: [
        { ...ambiguousCandidates[0], observationId: OBSERVATION_ID },
        ambiguousCandidates[1],
      ],
      truncated: false,
    }),
  );
  assert(
    parses("RepositoryBindingResolution", {
      status: "foreign",
      reason: "repository_scope_mismatch",
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      status: "resolved",
      binding: {
        organizationId: ORGANIZATION_ID,
        applicationId: APPLICATION_ID,
        repositoryId: REPOSITORY_ID,
        repositoryProfileId: PROFILE_ID,
        repositoryProfileRevision: 2,
        repositoryProfileDigest: PROFILE_DIGEST,
        observationId: null,
        observationDigest: null,
        baseSha: null,
        archivedAt: null,
      },
    }),
  );
  assert(parses("RepositoryBindingResolution", {
    ...resolved,
    binding: {
      ...resolved.binding,
      repositoryProfileId: null,
      repositoryProfileRevision: null,
      repositoryProfileDigest: null,
    },
  }));
  for (
    const field of [
      "repositoryProfileId",
      "repositoryProfileRevision",
      "repositoryProfileDigest",
    ]
  ) {
    assert(
      !parses("RepositoryBindingResolution", {
        ...resolved,
        binding: { ...resolved.binding, [field]: null },
      }),
    );
  }
  assert(
    !parses("RepositoryBindingResolution", {
      ...resolved,
      binding: { ...resolved.binding, observationId: OBSERVATION_ID },
    }),
  );
  const observed = {
    ...resolved,
    binding: {
      ...resolved.binding,
      observationId: OBSERVATION_ID,
      observationDigest: "c".repeat(64),
      baseSha: "a".repeat(40),
    },
  };
  assert(parses("RepositoryBindingResolution", observed));
  for (const field of ["observationId", "observationDigest", "baseSha"]) {
    assert(
      !parses("RepositoryBindingResolution", {
        ...observed,
        binding: { ...observed.binding, [field]: null },
      }),
    );
  }
  assert(
    !parses("RepositoryBindingResolution", {
      ...observed,
      binding: {
        ...observed.binding,
        repositoryProfileId: null,
        repositoryProfileRevision: null,
        repositoryProfileDigest: null,
      },
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: [ambiguousCandidates[0], ambiguousCandidates[0]],
      truncated: false,
    }),
  );
  assert(
    !parses("RepositoryBindingResolution", {
      status: "ambiguous",
      candidates: ambiguousCandidates,
      truncated: true,
    }),
  );
  assert(
    parses("RoleBindingUpdate", {
      expectedVersion: 1,
    }),
  );
  assert(!parses("RoleBindingUpdate", { expectedVersion: 0 }));
  assert(!parses("RoleBindingUpdate", { expectedVersion: 1.5 }));
  assert(!parses("RoleBindingUpdate", {}));
});

Deno.test("inspection initiation cannot select a profile or supply worker policy", () => {
  assert(parses("RepositoryOnboardingStart", {}));
  assert(!parses("RepositoryOnboardingStart", { profileId: PROFILE_ID }));
});

Deno.test("inspection lifecycle exposes publication links only as a completed pair", () => {
  const onboarding = {
    id: "00000000-0000-4000-8000-000000000008",
    repositoryId: REPOSITORY_ID,
    jobId: "00000000-0000-4000-8000-000000000009",
    status: "queued",
    profileId: null,
    observationId: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  assert(parses("RepositoryOnboarding", onboarding));
  assert(parses("RepositoryOnboarding", {
    ...onboarding,
    status: "completed",
    profileId: PROFILE_ID,
    observationId: OBSERVATION_ID,
  }));
  assert(
    !parses("RepositoryOnboarding", { ...onboarding, status: "completed" }),
  );
  assert(
    !parses("RepositoryOnboarding", { ...onboarding, profileId: PROFILE_ID }),
  );
});

Deno.test("observation projection cannot relabel its immutable profile or source", () => {
  const inspectionId = "00000000-0000-4000-8000-000000000008";
  const jobId = "00000000-0000-4000-8000-000000000009";
  const workerHostId = "00000000-0000-4000-8000-000000000010";
  const source = {
    mappingRevision: "operator-map-v1",
    mappingDigest: "b".repeat(64),
    baseSha: "c".repeat(40),
    manifestDigest: "d".repeat(64),
    envelopeDigest: "e".repeat(64),
    envelopeBytes: 1024,
    decodedBytes: 128,
    entryCount: 1,
  };
  const payload = {
    schemaVersion: 1,
    inspectionId,
    jobId,
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    repositoryId: REPOSITORY_ID,
    profileId: PROFILE_ID,
    profileRevision: 2,
    profileDigest: PROFILE_DIGEST,
    source,
    receipt: {
      inspectionId,
      jobId,
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
      repositoryId: REPOSITORY_ID,
      inputDigest: "f".repeat(64),
      source,
      attemptId: "00000000-0000-4000-8000-000000000011",
      fence: "1",
      workerHostId,
      workerSessionId: "00000000-0000-4000-8000-000000000012",
      workerSessionGeneration: "1",
      expiresAt: TIMESTAMP,
    },
    host: {
      workerHostId,
      os: "linux",
      architecture: "x64",
      tools: [{
        tool: "git",
        status: "available",
        version: "git version 2.50.0",
        outputDigest: "b".repeat(64),
      }],
    },
    checks: [{
      id: "manifest.0.check.0",
      template: "unsupported.v1",
      required: true,
      status: "unsupported",
      reason: "unsupported_command",
      exitCode: null,
      outputDigest: null,
      durationMs: 0,
    }],
    readiness: "blocked",
    observedAt: TIMESTAMP,
  };
  const observation = {
    id: OBSERVATION_ID,
    repositoryId: REPOSITORY_ID,
    profileId: PROFILE_ID,
    profileRevision: 2,
    profileDigest: PROFILE_DIGEST,
    observationDigest: "f".repeat(64),
    baseSha: source.baseSha,
    payload,
  };
  assert(parses("RepositoryProfileObservation", observation));
  assert(
    !parses("RepositoryProfileObservation", {
      ...observation,
      profileId: ROLE_BINDING_ID,
    }),
  );
  assert(
    !parses("RepositoryProfileObservation", {
      ...observation,
      baseSha: "a".repeat(40),
    }),
  );
});
