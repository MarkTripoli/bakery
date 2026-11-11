import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  ApplicationResponse,
  RepositoryProfileResponse,
  RepositoryResponse,
  TaskCreate,
  TaskResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { useConnectivity } from "../../app/connectivity.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import type { ProjectsOnboardingLabels } from "./labels.ts";

type TaskScopeState =
  | "idle"
  | "submitting"
  | "success"
  | "forbidden"
  | "conflict"
  | "setup-required"
  | "offline"
  | "reconnecting"
  | "error";

export function TaskScopeSection({
  application,
  repository,
  profile,
  labels,
  onStaleSelection,
}: Readonly<{
  application: ApplicationResponse;
  repository: RepositoryResponse;
  profile: RepositoryProfileResponse | null;
  labels: ProjectsOnboardingLabels;
  onStaleSelection: () => Promise<void>;
}>) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<TaskCreate["taskType"]>("feature");
  const [state, setState] = useState<TaskScopeState>("idle");
  const [task, setTask] = useState<TaskResponse | null>(null);
  const intent = useRef<{ key: string; input: TaskCreate } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const noticeId = useId();
  const submissionFocus = useRef<Element | null>(null);
  const authority =
    `${scope.sessionGeneration}:${scope.organizationId}:${application.id}:${repository.id}`;
  const currentAuthority = useRef(authority);
  currentAuthority.current = authority;

  useEffect(() => {
    intent.current = null;
    setTask(null);
    setState("idle");
    return () => {
      pending.current?.abort();
      pending.current = null;
      intent.current = null;
    };
  }, [authority]);

  const connectivity = useConnectivity();
  const priorConnectivity = useRef(connectivity);
  useEffect(() => {
    // Only a change moves the state; mounting offline or online does not.
    const prior = priorConnectivity.current;
    priorConnectivity.current = connectivity;
    if (prior === connectivity) return;
    if (connectivity === "offline") setState("offline");
    else {
      setState((current) => current === "offline" ? "reconnecting" : current);
    }
  }, [connectivity]);

  useEffect(() => {
    if (state !== "conflict") return;
    // A disabled submit button loses focus. Return it to its nearby outcome,
    // but do not take focus back if the user has moved elsewhere meanwhile.
    if (
      document.activeElement !== document.body &&
      document.activeElement !== submissionFocus.current
    ) return;
    const notice = document.getElementById(noticeId);
    notice?.focus({ preventScroll: true });
    notice?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [noticeId, state]);

  const setupRequired = repository.archivedAt !== null ||
    repository.activeProfileId === null || profile === null ||
    profile.id !== repository.activeProfileId;

  const submit = async () => {
    if (
      scope.organizationId === null || setupRequired || title.trim() === ""
    ) {
      setState("setup-required");
      return;
    }
    if (pending.current !== null || task !== null) return;
    submissionFocus.current = document.activeElement;
    const controller = new AbortController();
    pending.current = controller;
    intent.current ??= {
      key: crypto.randomUUID(),
      input: {
        applicationId: application.id,
        repositoryId: repository.id,
        repositoryProfileId: profile.id,
        taskType,
        title: title.trim(),
        description,
      },
    };
    setState("submitting");
    const result = await api.createTask({
      organizationId: scope.organizationId,
      idempotencyKey: intent.current.key,
      input: intent.current.input,
      signal: controller.signal,
    });
    if (controller.signal.aborted || currentAuthority.current !== authority) {
      return;
    }
    pending.current = null;
    if (result.ok) {
      setTask(result.data);
      setState("success");
      return;
    }
    const failure: ApiFailure = result.error;
    if (failure.kind === "network") {
      setState(
        globalThis.navigator?.onLine === false ? "offline" : "reconnecting",
      );
      return;
    }
    // A retryable problem can mean the original command is still committing.
    // Keep its key and frozen payload until its authoritative outcome is known.
    if (failure.kind === "problem" && failure.problem.retryable) {
      setState("reconnecting");
      return;
    }
    if (failure.kind === "problem" && failure.problem.status === 403) {
      intent.current = null;
      setState("forbidden");
      return;
    }
    if (
      failure.kind === "problem" &&
      (failure.problem.status === 409 || failure.problem.status === 412)
    ) {
      intent.current = null;
      setState("conflict");
      await onStaleSelection();
      return;
    }
    if (
      failure.kind === "problem" && failure.problem.status >= 400 &&
      failure.problem.status < 500 && failure.problem.status !== 408
    ) {
      intent.current = null;
    }
    setState("error");
  };

  const notice = state === "forbidden"
    ? labels.taskScope.forbidden
    : state === "conflict"
    ? labels.taskScope.conflict
    : state === "setup-required"
    ? labels.taskScope.setupRequired
    : state === "offline"
    ? labels.taskScope.offline
    : state === "reconnecting"
    ? labels.taskScope.reconnecting
    : state === "error"
    ? labels.taskScope.error
    : null;

  return (
    <UI.SettingsSection
      data-testid="projects-onboarding-task-scope"
      title={labels.taskScope.heading}
      variant="stack"
    >
      <UI.Text>{labels.taskScope.description}</UI.Text>
      {setupRequired && state === "idle"
        ? (
          <UI.InlineNotice tone="warning" role="status">
            {labels.taskScope.setupRequired}
          </UI.InlineNotice>
        )
        : null}
      {notice !== null
        ? (
          <UI.InlineNotice
            id={noticeId}
            tabIndex={state === "conflict" ? -1 : undefined}
            tone={state === "reconnecting" ? "information" : "error"}
            role="alert"
          >
            {notice}
          </UI.InlineNotice>
        )
        : null}
      <form
        data-state={state}
        data-ui-component="taskComposer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            htmlFor="projects-task-title"
            label={labels.taskScope.title}
            required
          >
            <UI.TextInput
              id="projects-task-title"
              name="title"
              type="text"
              autoComplete="off"
              required
              value={title}
              disabled={intent.current !== null}
              onChange={setTitle}
            />
          </UI.Field>
          <UI.Field
            htmlFor="projects-task-description"
            label={labels.taskScope.taskDescription}
            variant="textarea"
          >
            <textarea
              id="projects-task-description"
              name="description"
              rows={5}
              disabled={intent.current !== null}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </UI.Field>
          <UI.Combobox
            label={labels.taskScope.taskType}
            name="taskType"
            value={taskType}
            disabled={intent.current !== null}
            onChange={(event) =>
              setTaskType(event.target.value as TaskCreate["taskType"])}
            options={([
              "feature",
              "bug",
              "maintenance",
              "epic",
            ] as const).map((value) => ({
              value,
              label: labels.taskScope.types[value],
            }))}
          />
          <UI.Button
            type="submit"
            loading={state === "submitting"}
            disabled={setupRequired || task !== null ||
              state === "submitting" ||
              state === "offline" || title.trim() === ""}
          >
            {state === "submitting"
              ? labels.taskScope.creating
              : labels.taskScope.create}
          </UI.Button>
        </UI.Stack>
      </form>
      {task !== null
        ? (
          <UI.InlineNotice tone="success" role="status">
            <UI.Text>{labels.taskScope.created}</UI.Text>
            <dl>
              <dt>{labels.taskScope.taskId}</dt>
              <dd>
                <Link to="/tasks/$taskId" params={{ taskId: task.id }}>
                  {task.id}
                </Link>
              </dd>
              <dt>{labels.profiles.profileId}</dt>
              <dd>
                <code>{task.repositoryProfileId}</code>
              </dd>
              <dt>{labels.profiles.revision}</dt>
              <dd>{task.repositoryProfileRevision}</dd>
              <dt>{labels.profiles.digest}</dt>
              <dd>
                <code>{task.repositoryProfileDigest}</code>
              </dd>
            </dl>
            <UI.Text>{labels.taskScope.noRun}</UI.Text>
            <UI.Button
              type="button"
              onClick={() => {
                intent.current = null;
                setTask(null);
                setTitle("");
                setDescription("");
                setState("idle");
              }}
            >
              {labels.taskScope.newTask}
            </UI.Button>
          </UI.InlineNotice>
        )
        : null}
    </UI.SettingsSection>
  );
}
