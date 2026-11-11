import { useState } from "react";
import * as UI from "@bakery/ui";
import { RepositoryProfileConfigSchema } from "@bakery/contracts/repository-profile-config";
import type {
  RepositoryProfileCreate,
  RepositoryProfileResponse,
  RepositoryResponse,
  RepositoryUpdate,
} from "../../api/client.ts";
import type { CursorCollection } from "./useCursorPages.ts";
import type { ProjectsOnboardingLabels } from "./labels.ts";

export function ProfileSection(
  {
    repository,
    profiles,
    selectedProfile,
    labels,
    pending,
    onCreate,
    onUpdate,
    onSelect,
  }: Readonly<{
    repository: RepositoryResponse;
    profiles: CursorCollection<RepositoryProfileResponse>;
    selectedProfile: RepositoryProfileResponse | null;
    labels: ProjectsOnboardingLabels;
    pending: boolean;
    onCreate: (id: string, input: RepositoryProfileCreate) => Promise<void>;
    onUpdate: (
      id: string,
      input: RepositoryUpdate,
      ifMatch: string,
    ) => Promise<void>;
    onSelect: (id: string | null) => void;
  }>,
) {
  const [revision, setRevision] = useState(
    String(
      Math.max(0, ...profiles.items.map((profile) => profile.revision)) + 1,
    ),
  );
  const [root, setRoot] = useState("");
  const [patterns, setPatterns] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedConfig = selectedProfile === null
    ? null
    : RepositoryProfileConfigSchema.safeParse(selectedProfile.config);
  const submit = async () => {
    setError(null);
    const parsed = RepositoryProfileConfigSchema.safeParse({
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: {
        base: repository.defaultBranch,
        allowedPatterns: patterns.split("\n").map((pattern) => pattern.trim())
          .filter(Boolean),
      },
      worktree: { root: root.trim() },
    });
    const nextRevision = Number(revision);
    if (
      !parsed.success || !Number.isSafeInteger(nextRevision) || nextRevision < 1
    ) {
      setError(labels.profiles.invalidConfig);
      return;
    }
    // Canonical key order matches the server's recursive lexicographic JSON digest.
    const config = {
      branches: {
        allowedPatterns: parsed.data.branches.allowedPatterns,
        base: parsed.data.branches.base,
      },
      schemaVersion: parsed.data.schemaVersion,
      workflow: { kind: parsed.data.workflow.kind },
      worktree: { root: parsed.data.worktree.root },
    };
    try {
      const digestBytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(config)),
        ),
      );
      const digest = Array.from(
        digestBytes,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      await onCreate(repository.id, { revision: nextRevision, config, digest });
      setRevision(String(nextRevision + 1));
    } catch {
      setError(labels.errors.mutation);
    }
  };
  const activate = async (profileId: string) => {
    setError(null);
    try {
      await onUpdate(
        repository.id,
        { activeProfileId: profileId },
        `"${repository.version}"`,
      );
    } catch {
      setError(labels.errors.mutation);
    }
  };
  return (
    <UI.SettingsSection
      title={labels.profiles.createHeading}
      variant="stack"
      data-testid="projects-onboarding-profile-config"
    >
      <UI.InlineNotice tone="information">
        {labels.profiles.configOnly}
      </UI.InlineNotice>
      <p>
        {labels.repositories.fields.defaultBranch}:{" "}
        <code>{repository.defaultBranch}</code>
      </p>
      {error !== null
        ? <UI.InlineNotice tone="error" role="alert">{error}</UI.InlineNotice>
        : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            htmlFor="projects-profile-revision"
            label={labels.profiles.revisionInput}
            required
          >
            <UI.TextInput
              id="projects-profile-revision"
              name="revision"
              autoComplete="off"
              type="text"
              inputMode="numeric"
              required
              value={revision}
              onChange={setRevision}
            />
          </UI.Field>
          <UI.Field
            htmlFor="projects-profile-root"
            label={labels.profiles.worktreeRoot}
            required
          >
            <UI.TextInput
              id="projects-profile-root"
              name="worktreeRoot"
              autoComplete="off"
              type="text"
              required
              value={root}
              onChange={setRoot}
            />
          </UI.Field>
          <UI.Field
            htmlFor="projects-profile-patterns"
            label={labels.profiles.allowedPatterns}
            required
            variant="textarea"
          >
            <textarea
              id="projects-profile-patterns"
              name="allowedPatterns"
              rows={4}
              required
              value={patterns}
              onChange={(event) => setPatterns(event.target.value)}
            />
          </UI.Field>
          <UI.Button
            type="submit"
            disabled={pending || repository.archivedAt !== null ||
              profiles.state !== "ready"}
            loading={pending}
          >
            {pending ? labels.profiles.creating : labels.profiles.create}
          </UI.Button>
        </UI.Stack>
      </form>
      <ul>
        {profiles.items.filter((profile) => {
          const parsed = RepositoryProfileConfigSchema.safeParse(
            profile.config,
          );
          return parsed.success &&
            parsed.data.branches.base === repository.defaultBranch;
        }).map((profile) => (
          <li key={profile.id}>
            <code>{profile.id}</code> {labels.profiles.revision}:{" "}
            {profile.revision} {repository.activeProfileId === profile.id
              ? (
                <>
                  <UI.Badge tone="neutral">{labels.profiles.active}</UI.Badge>
                  {selectedProfile?.id === profile.id
                    ? (
                      <UI.Badge tone="success">
                        {labels.profiles.selected}
                      </UI.Badge>
                    )
                    : (
                      <UI.Button
                        disabled={pending || repository.archivedAt !== null}
                        variant="secondary"
                        onClick={() => onSelect(profile.id)}
                      >
                        {labels.profiles.select}
                      </UI.Button>
                    )}
                </>
              )
              : (
                <UI.Button
                  disabled={pending || repository.archivedAt !== null}
                  variant="secondary"
                  onClick={() => void activate(profile.id)}
                >
                  {labels.profiles.activate}
                </UI.Button>
              )}
          </li>
        ))}
      </ul>
      {selectedProfile !== null && selectedConfig?.success
        ? null
        : (
          <UI.InlineNotice tone="warning" role="status">
            {labels.profiles.selectionRequired}
          </UI.InlineNotice>
        )}
      <UI.InlineNotice tone="information">
        {labels.observedExecutionAdmission}
      </UI.InlineNotice>
    </UI.SettingsSection>
  );
}

/** The reviewed profile's enforced boundaries, shown beside the task scope. */
export function ProfileBoundary(
  { labels, repository, selectedProfile }: Readonly<{
    labels: ProjectsOnboardingLabels;
    repository: RepositoryResponse;
    selectedProfile: RepositoryProfileResponse;
  }>,
) {
  const selectedConfig = RepositoryProfileConfigSchema.safeParse(
    selectedProfile.config,
  );
  if (!selectedConfig.success) return null;
  return (
    <section
      aria-labelledby="projects-profile-boundary-heading"
      data-testid="projects-onboarding-profile-boundary"
    >
      <UI.Heading id="projects-profile-boundary-heading" level="section">
        {labels.profiles.enforcedHeading}
      </UI.Heading>
      <UI.Text>{labels.profiles.enforcedDescription}</UI.Text>
      <dl>
        <dt>{labels.profiles.repositoryIdentity}</dt>
        <dd>
          <code>{repository.owner}/{repository.name}</code>
        </dd>
        <dt>{labels.repositories.fields.defaultBranch}</dt>
        <dd>
          <code>{repository.defaultBranch}</code>
        </dd>
        <dt>{labels.profiles.profileId}</dt>
        <dd>
          <code>{selectedProfile.id}</code>
        </dd>
        <dt>{labels.profiles.revision}</dt>
        <dd>{selectedProfile.revision}</dd>
        <dt>{labels.profiles.digest}</dt>
        <dd>
          <code>{selectedProfile.digest}</code>
        </dd>
        <dt>{labels.profiles.baseBranch}</dt>
        <dd>
          <code>{selectedConfig.data.branches.base}</code>
        </dd>
        <dt>{labels.profiles.allowedPatterns}</dt>
        <dd>
          <ul>
            {selectedConfig.data.branches.allowedPatterns.map((
              pattern,
            ) => (
              <li key={pattern}>
                <code>{pattern}</code>
              </li>
            ))}
          </ul>
        </dd>
        <dt>{labels.profiles.worktreeRoot}</dt>
        <dd>
          <code>{selectedConfig.data.worktree.root}</code>
        </dd>
        <dt>{labels.profiles.workflow}</dt>
        <dd>
          <code>{selectedConfig.data.workflow.kind}</code>
        </dd>
      </dl>
    </section>
  );
}
