import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  RepositoryBindingResolution,
  RepositoryBindingSelector,
  RepositoryResponse,
  RoleBindingCreate,
  RoleBindingResponse,
  RoleBindingUpdate,
} from "../../api/client.ts";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import type { CursorCollection } from "./useCursorPages.ts";

type Props = Readonly<{
  applicationId: string;
  labels: ProjectsOnboardingLabels;
  repositories: readonly RepositoryResponse[];
  roles: CursorCollection<RoleBindingResponse>;
  pending: boolean;
  resolutionKey: string;
  onCreate: (input: RoleBindingCreate) => Promise<void>;
  onUpdate: (id: string, input: RoleBindingUpdate) => Promise<void>;
  onResolve: (
    input: RepositoryBindingSelector,
  ) => Promise<RepositoryBindingResolution>;
  onRetry: () => void;
  onLoadMore: () => void;
  onRetryMore: () => void;
}>;

type Values = {
  repositoryId: string;
  role: string;
  alias: string;
  provenance: string;
};
const EMPTY: Values = { repositoryId: "", role: "", alias: "", provenance: "" };

export function BindingSection(props: Props) {
  const {
    applicationId,
    labels,
    repositories,
    roles,
    pending,
    onCreate,
    onUpdate,
  } = props;
  const [editing, setEditing] = useState<RoleBindingResponse | null>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const activeRepositories = repositories.filter((repository) =>
    repository.applicationId === applicationId && repository.archivedAt === null
  );
  const choose = (binding: RoleBindingResponse | null) => {
    setEditing(binding);
    setValues(
      binding === null ? EMPTY : {
        repositoryId: binding.repositoryId,
        role: binding.role,
        alias: binding.alias ?? "",
        provenance: binding.provenance ?? "",
      },
    );
    setError(null);
  };
  const submit = async () => {
    setError(null);
    if (
      !activeRepositories.some((repository) =>
        repository.id === values.repositoryId
      ) ||
      values.role.trim().length === 0 || values.role.length > 200 ||
      values.alias.length > 200 || values.provenance.length > 200
    ) {
      setError(labels.bindings.invalid);
      return;
    }
    const input = {
      repositoryId: values.repositoryId,
      role: values.role.trim(),
      alias: values.alias.trim() || null,
      provenance: values.provenance.trim() || null,
    };
    try {
      if (editing === null) await onCreate({ applicationId, ...input });
      else {await onUpdate(editing.id, {
          expectedVersion: editing.version,
          ...input,
        });}
      choose(null);
    } catch {
      setError(labels.errors.mutation);
    }
  };
  const archive = async (binding: RoleBindingResponse) => {
    setError(null);
    try {
      await onUpdate(binding.id, {
        expectedVersion: binding.version,
        archivedAt: binding.archivedAt === null
          ? new Date().toISOString()
          : null,
      });
      choose(null);
    } catch {
      setError(labels.errors.mutation);
    }
  };
  return (
    <UI.SettingsSection
      title={labels.bindings.heading}
      variant="stack"
      data-testid="projects-onboarding-bindings"
    >
      <p>{labels.bindings.description}</p>
      {applicationId === ""
        ? (
          <UI.InlineNotice tone="information">
            {labels.bindings.applicationRequired}
          </UI.InlineNotice>
        )
        : (
          <>
            {error !== null
              ? (
                <UI.InlineNotice role="alert" tone="error">
                  {error}
                </UI.InlineNotice>
              )
              : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Combobox
                  name="bindingRepositoryId"
                  label={labels.bindings.repository}
                  value={values.repositoryId}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      repositoryId: event.target.value,
                    }))}
                  options={[
                    {
                      value: "",
                      label: labels.bindings.repository,
                      disabled: true,
                    },
                    ...activeRepositories.map((repository) => ({
                      value: repository.id,
                      label: `${repository.owner}/${repository.name} (${
                        repository.slug ?? repository.id
                      })`,
                    })),
                  ]}
                />
                {(["role", "alias", "provenance"] as const).map((field) => (
                  <UI.Field
                    key={field}
                    htmlFor={`projects-binding-${field}`}
                    label={labels.bindings[field]}
                    required={field === "role"}
                  >
                    <UI.TextInput
                      id={`projects-binding-${field}`}
                      name={field}
                      type="text"
                      required={field === "role"}
                      autoComplete="off"
                      value={values[field]}
                      onChange={(value) =>
                        setValues((current) => ({
                          ...current,
                          [field]: value,
                        }))}
                    />
                  </UI.Field>
                ))}
                <UI.Inline gap="compact">
                  <UI.Button disabled={pending} loading={pending} type="submit">
                    {editing === null
                      ? labels.bindings.create
                      : labels.bindings.save}
                  </UI.Button>
                  {editing !== null
                    ? (
                      <UI.Button
                        type="button"
                        variant="quiet"
                        onClick={() => choose(null)}
                      >
                        {labels.bindings.cancel}
                      </UI.Button>
                    )
                    : null}
                </UI.Inline>
              </UI.Stack>
            </form>
            {roles.state === "loading"
              ? <UI.Skeleton shape="row" />
              : roles.state === "error"
              ? (
                <UI.ErrorState
                  title={labels.errors.load}
                  description={labels.errors.load}
                  action={
                    <UI.Button onClick={props.onRetry}>
                      {labels.errors.retry}
                    </UI.Button>
                  }
                />
              )
              : roles.items.length === 0
              ? <p>{labels.bindings.empty}</p>
              : (
                <UI.DataTable
                  caption={labels.bindings.heading}
                  rows={[...roles.items]}
                  getRowKey={(binding) => binding.id}
                  variant="sheetList"
                  columns={[
                    {
                      id: "role",
                      header: labels.bindings.role,
                      cell: (binding) => binding.role,
                    },
                    {
                      id: "alias",
                      header: labels.bindings.alias,
                      cell: (binding) => binding.alias,
                    },
                    {
                      id: "repository",
                      header: labels.bindings.repository,
                      cell: (binding) =>
                        binding.repositorySlug ?? binding.repositoryId,
                    },
                    {
                      id: "provenance",
                      header: labels.bindings.provenance,
                      cell: (binding) => binding.provenance,
                    },
                    {
                      id: "status",
                      header: labels.bindings.status,
                      cell: (binding) =>
                        binding.archivedAt === null
                          ? labels.bindings.active
                          : labels.bindings.archived,
                    },
                    {
                      id: "actions",
                      header: labels.bindings.edit,
                      cell: (binding) => (
                        <UI.Inline gap="compact">
                          <UI.Button
                            disabled={pending}
                            variant="quiet"
                            onClick={() => choose(binding)}
                          >
                            {labels.bindings.edit}
                          </UI.Button>
                          <UI.Button
                            disabled={pending}
                            variant="secondary"
                            onClick={() => void archive(binding)}
                          >
                            {binding.archivedAt === null
                              ? labels.bindings.archive
                              : labels.bindings.reactivate}
                          </UI.Button>
                        </UI.Inline>
                      ),
                    },
                  ]}
                />
              )}
            {roles.hasNext || roles.moreError
              ? (
                <UI.CursorControls
                  hasNext={roles.hasNext}
                  labels={labels.pagination}
                  onNext={props.onLoadMore}
                  onRetry={props.onRetryMore}
                  state={roles.moreError
                    ? "error"
                    : roles.loadingMore
                    ? "loading"
                    : "ready"}
                />
              )
              : null}
            <BindingResolver
              key={props.resolutionKey}
              labels={labels}
              repositories={activeRepositories}
              onResolve={props.onResolve}
            />
          </>
        )}
    </UI.SettingsSection>
  );
}

function BindingResolver({ labels, repositories, onResolve }: Readonly<{
  labels: ProjectsOnboardingLabels;
  repositories: readonly RepositoryResponse[];
  onResolve: Props["onResolve"];
}>) {
  const [mode, setMode] = useState<"repository" | "role" | "aliases">(
    "repository",
  );
  const [repositoryId, setRepositoryId] = useState("");
  const [role, setRole] = useState("");
  const [alias, setAlias] = useState("");
  const [aliases, setAliases] = useState("");
  const [result, setResult] = useState<RepositoryBindingResolution | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current += 1;
  }, []);
  const clear = () => {
    generation.current += 1;
    setResult(null);
    setError(null);
    setPending(false);
  };
  const resolve = async (selector: RepositoryBindingSelector) => {
    clear();
    const requestGeneration = generation.current;
    setPending(true);
    try {
      const resolution = await onResolve(selector);
      if (requestGeneration === generation.current) setResult(resolution);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        const failure = cause as ApiFailure;
        setError(
          failure.kind === "problem" && failure.problem.status === 404
            ? labels.resolver.foreign
            : labels.errors.load,
        );
      }
    } finally {
      if (requestGeneration === generation.current) setPending(false);
    }
  };
  const submit = () => {
    if (mode === "repository" && repositoryId !== "") {
      void resolve({ repositoryId });
    } else if (
      mode === "role" && role.trim() !== "" && role.length <= 200 &&
      alias.length <= 200
    ) {
      void resolve({
        role: role.trim(),
        ...(alias.trim() === "" ? {} : { alias: alias.trim() }),
      });
    } else if (mode === "aliases") {
      const items = aliases.split("\n").map((value) => value.trim()).filter(
        Boolean,
      );
      if (
        items.length >= 1 && items.length <= 32 &&
        new Set(items).size === items.length && items.every((value) =>
          value.length <= 200
        )
      ) void resolve({ aliases: items });
      else {
        clear();
        setError(labels.resolver.invalid);
      }
    } else {
      clear();
      setError(labels.resolver.invalid);
    }
  };
  return (
    <UI.SettingsSection
      title={labels.resolver.heading}
      variant="stack"
      data-testid="projects-onboarding-binding-resolution"
    >
      <p>{labels.resolver.description}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Combobox
            label={labels.resolver.mode}
            value={mode}
            onChange={(event) => {
              clear();
              setMode(event.target.value as typeof mode);
            }}
            options={(["repository", "role", "aliases"] as const).map((
              value,
            ) => ({ value, label: labels.resolver[value] }))}
          />
          {mode === "repository"
            ? (
              <UI.Combobox
                label={labels.resolver.repository}
                value={repositoryId}
                onChange={(event) => {
                  clear();
                  setRepositoryId(event.target.value);
                }}
                options={[
                  {
                    value: "",
                    label: labels.resolver.repository,
                    disabled: true,
                  },
                  ...repositories.map((repository) => ({
                    value: repository.id,
                    label: `${repository.owner}/${repository.name}`,
                  })),
                ]}
              />
            )
            : mode === "role"
            ? (
              <>
                <UI.Field
                  htmlFor="projects-resolve-role"
                  label={labels.bindings.role}
                  required
                >
                  <UI.TextInput
                    id="projects-resolve-role"
                    name="resolveRole"
                    autoComplete="off"
                    type="text"
                    required
                    value={role}
                    onChange={(value) => {
                      clear();
                      setRole(value);
                    }}
                  />
                </UI.Field>
                <UI.Field
                  htmlFor="projects-resolve-alias"
                  label={labels.bindings.alias}
                >
                  <UI.TextInput
                    id="projects-resolve-alias"
                    name="resolveAlias"
                    autoComplete="off"
                    type="text"
                    value={alias}
                    onChange={(value) => {
                      clear();
                      setAlias(value);
                    }}
                  />
                </UI.Field>
              </>
            )
            : (
              <UI.Field
                htmlFor="projects-resolve-aliases"
                label={labels.resolver.aliases}
                required
                variant="textarea"
              >
                <textarea
                  id="projects-resolve-aliases"
                  name="resolveAliases"
                  aria-describedby="projects-resolve-aliases-hint"
                  required
                  rows={4}
                  value={aliases}
                  onChange={(event) => {
                    clear();
                    setAliases(event.target.value);
                  }}
                />
                <span id="projects-resolve-aliases-hint">
                  {labels.resolver.aliasesHint}
                </span>
              </UI.Field>
            )}
          <UI.Button disabled={pending} loading={pending} type="submit">
            {pending ? labels.resolver.resolving : labels.resolver.resolve}
          </UI.Button>
        </UI.Stack>
      </form>
      {error !== null
        ? <UI.InlineNotice tone="error" role="alert">{error}</UI.InlineNotice>
        : null}
      {result === null
        ? null
        : result.status === "unavailable"
        ? (
          <UI.InlineNotice tone="warning" role="status">
            {labels.resolver.unavailable}{" "}
            {labels.resolver.reasons[result.reason]}
          </UI.InlineNotice>
        )
        : result.status === "resolved"
        ? (
          <div role="status">
            <p>{labels.resolver.resolved}</p>
            <code>{result.binding.repositoryId}</code>
            {result.binding.repositoryProfileId === null
              ? <p>{labels.resolver.noProfile}</p>
              : (
                <dl>
                  <dt>{labels.resolver.profile}</dt>
                  <dd>
                    <code>{result.binding.repositoryProfileId}</code>
                  </dd>
                  <dt>{labels.profiles.revision}</dt>
                  <dd>{result.binding.repositoryProfileRevision}</dd>
                  <dt>{labels.profiles.digest}</dt>
                  <dd>
                    <code>{result.binding.repositoryProfileDigest}</code>
                  </dd>
                </dl>
              )}
          </div>
        )
        : result.status === "ambiguous"
        ? (
          <div role="alert">
            <p>{labels.resolver.ambiguous}</p>
            {result.truncated
              ? (
                <UI.InlineNotice tone="warning">
                  {labels.resolver.truncated}
                </UI.InlineNotice>
              )
              : null}
            <ul>
              {result.candidates.map((candidate) => (
                <li key={candidate.repositoryId}>
                  <UI.Button
                    disabled={pending}
                    variant="quiet"
                    onClick={() =>
                      void resolve({ repositoryId: candidate.repositoryId })}
                  >
                    {candidate.repositoryId}
                  </UI.Button>
                </li>
              ))}
            </ul>
          </div>
        )
        : null}
      <UI.InlineNotice tone="information">
        {labels.observedExecutionAdmission}
      </UI.InlineNotice>
    </UI.SettingsSection>
  );
}
