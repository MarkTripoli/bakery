import { assertEquals } from "@std/assert";
import {
  findExactById,
  mergeCursorItems,
  profileRevisionState,
  readOnlyProfileHistoryRows,
  validatedProjectsOnboardingSelection,
} from "../../apps/web/src/pages/projects-onboarding/identity.ts";
import {
  validateApplicationForm,
  validateRepositoryEdit,
  validateRepositoryForm,
} from "../../apps/web/src/pages/projects-onboarding/validation.ts";

Deno.test("onboarding deep-link identity accepts only UUID values", () => {
  const application = "00000000-0000-4000-8000-000000000001";
  const repository = "00000000-0000-4000-8000-000000000002";
  const profile = "00000000-0000-4000-8000-000000000003";
  assertEquals(
    validatedProjectsOnboardingSelection({ application, repository, profile }),
    { application, repository, profile },
  );
  assertEquals(
    validatedProjectsOnboardingSelection({
      application: "foreign-slug",
      repository: "",
      profile: 12,
    }),
    {},
  );
});

Deno.test("cursor pages keep exact resource identity and do not duplicate rows", () => {
  const items = mergeCursorItems([
    [{ id: "repository-a", name: "same" }, {
      id: "repository-b",
      name: "same",
    }],
    [{ id: "repository-b", name: "same" }, {
      id: "repository-c",
      name: "other",
    }],
  ]);

  assertEquals(items.map((item) => item.id), [
    "repository-a",
    "repository-b",
    "repository-c",
  ]);
  assertEquals(findExactById(items, "repository-b")?.id, "repository-b");
  assertEquals(findExactById(items, "same"), null);
});

Deno.test(
  "legacy and unverified v2 profile history stays read-only with exact identity",
  () => {
    const profiles = [
      {
        config: { schemaVersion: 1 },
        id: "profile-v1",
        repositoryId: "repository-a",
        revision: 1,
      },
      {
        config: { schemaVersion: 2, status: "blocked" },
        id: "profile-v2-blocked",
        repositoryId: "repository-a",
        revision: 2,
      },
      {
        config: { schemaVersion: 2, status: "eligible" },
        id: "profile-other-repo",
        repositoryId: "repository-b",
        revision: 2,
      },
    ];

    const rows = readOnlyProfileHistoryRows(
      "repository-a",
      "profile-v1",
      profiles,
    );

    assertEquals(
      rows.map((row) => ({
        action: row.action,
        active: row.active,
        id: row.profile.id,
      })),
      [
        { action: "read-only", active: true, id: "profile-v1" },
        {
          action: "read-only",
          active: false,
          id: "profile-v2-blocked",
        },
      ],
    );
    assertEquals(rows.map((row) => row.state), [
      "legacy-v1",
      "v2-observation-unavailable",
    ]);
  },
);

Deno.test("application and repository forms expose consumer-visible validation transitions", () => {
  assertEquals(
    validateApplicationForm({ slug: "", name: "", description: "" }),
    { name: "required", slug: "required" },
  );
  assertEquals(
    validateApplicationForm({
      slug: "not a slug",
      name: "Application",
      description: "A description",
    }),
    { slug: "invalidSlug" },
  );
  assertEquals(
    profileRevisionState({ config: { schemaVersion: 1 } }),
    "legacy-v1",
  );
  assertEquals(
    profileRevisionState({
      config: { schemaVersion: 2, status: "eligible" },
    }),
    "v2-observation-unavailable",
  );
  assertEquals(
    validateApplicationForm({
      slug: "a".repeat(101),
      name: "Application",
      description: "",
    }),
    { slug: "tooLong" },
  );
  assertEquals(
    validateRepositoryForm({
      applicationId: "",
      integrationConnectionId: "not-a-uuid",
      providerRepoId: "",
      owner: "bad owner",
      slug: "valid-repo",
      name: "repo",
      defaultBranch: "main",
    }),
    {
      applicationId: "selectApplication",
      integrationConnectionId: "invalidUuid",
      owner: "invalidIdentity",
      providerRepoId: "required",
    },
  );
  assertEquals(
    validateRepositoryEdit({ name: "repo", defaultBranch: "main" }),
    {},
  );
});
