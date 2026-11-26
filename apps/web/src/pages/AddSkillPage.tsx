import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  gitSkillSourcesQueryOptions,
  organizationsListQueryOptions,
} from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { sayAboutSkill } from "./library/SkillActions.tsx";
import {
  cleanFolder,
  EMPTY_SOURCE_FORM,
  httpsAddress,
  importedName,
  type ImportFailure,
  importFailureKind,
  type SourceForm,
  sourceProblems,
} from "./library/skill-source-state.ts";

const POLL_MS = 1500;
const FAILURE_ID = "skill-add-failure";

type AddKey = MessageKey extends infer Key
  ? Key extends `library.skills.add.${infer Suffix}` ? Suffix : never
  : never;

type Attempt = {
  readonly runId: string;
  readonly address: string;
  readonly folder: string;
  readonly revision: string;
  readonly alreadyAdded: boolean;
  readonly startedAt: string;
};

class AddFailed extends Error {
  constructor(
    readonly kind: ImportFailure | "saved",
    readonly sourceId: string | null,
  ) {
    super("ADD_SKILL_FAILED");
  }
}

export function AddSkillPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const organizationId = scope.organizationId as string;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const organizations = useQuery(organizationsListQueryOptions(api, scope));
  const admin = access.data?.role === "admin";
  const sources = useQuery({
    ...gitSkillSourcesQueryOptions(api, scope),
    enabled: admin,
  });
  const saved = sources.data ?? [];
  const organizationName =
    organizations.data?.items.find((item) => item.id === organizationId)
      ?.name ?? "";

  const [form, setForm] = useState<SourceForm>(EMPTY_SOURCE_FORM);
  const [fromSaved, setFromSaved] = useState(false);
  const [tried, setTried] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const importKey = useRef<{ body: string; key: string } | null>(null);
  const finished = useRef<string | null>(null);
  const copy = (key: AddKey, values?: Record<string, string | number>) =>
    translate(`library.skills.add.${key}`, values);
  const change = (patch: Partial<SourceForm>) =>
    setForm((held) => ({ ...held, ...patch }));

  const chosen = saved.find((source) => source.id === form.sourceId);
  const address = fromSaved ? chosen?.locator ?? "" : form.address.trim();

  const add = useMutation({
    mutationKey: ["skills.import"],
    mutationFn: async (): Promise<Attempt> => {
      let sourceId = form.sourceId;
      let created: string | null = null;
      if (!fromSaved) {
        const made = await api.createSkillSource({
          organizationId,
          input: {
            sourceType: "git",
            url: form.address.trim(),
            name: form.name.trim(),
            license: form.licence.trim(),
          },
          idempotencyKey: crypto.randomUUID(),
        });
        if (!made.ok) {
          const status = failureStatus(made.error);
          throw new AddFailed(
            status === 409 ? "saved" : status === 422 ? "origin" : "other",
            null,
          );
        }
        sourceId = made.data.id;
        created = made.data.id;
      }
      const folder = cleanFolder(form.folder);
      const input = {
        sourceId,
        revision: form.revision.trim(),
        ...(folder === "" ? {} : { path: folder }),
      };
      const body = JSON.stringify(input);
      if (importKey.current?.body !== body) {
        importKey.current = { body, key: crypto.randomUUID() };
      }
      const run = await api.importSkill({
        organizationId,
        input,
        idempotencyKey: importKey.current.key,
      });
      if (!run.ok) {
        const status = failureStatus(run.error);
        if (status !== null && status < 500) importKey.current = null;
        throw new AddFailed(
          status === 404 || status === 409 ? "removed" : "other",
          created,
        );
      }
      importKey.current = null;
      return {
        runId: run.data.id,
        address,
        folder,
        revision: input.revision,
        alreadyAdded: run.data.status === "completed",
        startedAt: run.data.createdAt,
      };
    },
    onSuccess: setAttempt,
    onError: (error) => {
      if (error instanceof AddFailed && error.sourceId !== null) {
        pickSaved(error.sourceId);
      }
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });

  const result = useQuery({
    queryKey: protectedQueryKey(scope, "skillImports.get", {
      id: attempt?.runId ?? "",
    }),
    queryFn: async ({ signal }) => {
      const read = await api.getSkillImport({
        organizationId,
        id: attempt!.runId,
        signal,
      });
      if (!read.ok) throw read.error;
      return read.data;
    },
    enabled: attempt !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : POLL_MS;
    },
  });
  const outcome = attempt === null ? undefined : result.data;

  function pickSaved(sourceId: string) {
    setFromSaved(true);
    change({ sourceId });
  }

  useEffect(() => {
    if (attempt === null || outcome === undefined) return;
    if (finished.current === attempt.runId) return;
    if (outcome.state === "failed") {
      finished.current = attempt.runId;
      if (!fromSaved) {
        const made = saved.find((source) =>
          source.locator === httpsAddress(attempt.address)?.href
        );
        if (made !== undefined) pickSaved(made.id);
      }
      return;
    }
    if (outcome.state !== "completed") return;
    finished.current = attempt.runId;
    const open = async () => {
      if (outcome.skillId === null) {
        void navigate({ to: "/library", search: { tab: "skills" } });
        return;
      }
      const skill = await api.getSkill({
        organizationId,
        id: outcome.skillId,
      });
      if (skill.ok) {
        const versions = await api.listSkillVersions({
          organizationId,
          skillId: outcome.skillId,
        });
        const made = versions.ok
          ? versions.data.items.find((item) => item.id === outcome.versionId)
          : undefined;
        const unchanged = made !== undefined &&
          Date.parse(made.createdAt) < Date.parse(attempt.startedAt);
        sayAboutSkill(
          copy(
            attempt.alreadyAdded ? "already" : unchanged ? "unchanged" : "done",
            {
              name: skill.data.name,
            },
          ),
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      void navigate({
        to: "/library/skills/$skillId",
        params: { skillId: outcome.skillId },
      });
    };
    void open();
  });

  const reading = add.isPending ||
    attempt !== null && outcome?.state !== "failed";
  const failedRun = outcome?.state === "failed" ? outcome.runId : null;
  useEffect(() => {
    if (failedRun === null && !add.isError) return;
    globalThis.document.getElementById(FAILURE_ID)?.focus();
  }, [failedRun, add.isError]);
  const failedKind = add.error instanceof AddFailed
    ? add.error.kind
    : add.isError
    ? "other"
    : outcome?.state === "failed"
    ? importFailureKind(outcome.failureCode, attempt?.folder ?? "")
    : null;
  const problems = tried ? sourceProblems(form, fromSaved) : {};
  const problem = (field: keyof SourceForm) => {
    const kind = problems[field];
    return kind === undefined ? undefined : copy(`problem.${kind}`);
  };

  const submit = () => {
    if (reading) return;
    setTried(true);
    const [first] = Object.keys(sourceProblems(form, fromSaved));
    if (first !== undefined) {
      globalThis.document.getElementById(`skill-add-${first}`)?.focus();
      return;
    }
    setAttempt(null);
    add.mutate();
  };
  const leave = () =>
    void navigate({ to: "/library", search: { tab: "skills" } });

  const text = (
    field: "address" | "name" | "licence" | "revision" | "folder",
    required: boolean,
    hint?: string,
  ) => (
    <UI.Field
      error={problem(field)}
      hint={hint}
      htmlFor={`skill-add-${field}`}
      label={copy(`field.${field}`)}
      required={required}
    >
      <UI.TextInput
        autoComplete="off"
        id={`skill-add-${field}`}
        invalid={problem(field) !== undefined || undefined}
        name={field}
        onChange={(value) => change({ [field]: value })}
        readOnly={reading}
        type="text"
        value={form[field]}
      />
    </UI.Field>
  );

  const header = (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { href: WORK_HOME, label: translate("shell.navigation.workspace") },
            { href: "/library?tab=skills", label: translate("library.title") },
            { label: copy("title") },
          ]}
        />
      </ShellSlot>
      <UI.PageHeader variant="list" flush title={copy("title")} />
    </>
  );

  if (access.isPending || !admin) {
    return (
      <UI.Stack gap="spacious" data-testid="skill-add-page">
        {header}
        {access.isPending ? <UI.Skeleton shape="row" /> : (
          <UI.EmptyState
            action={
              <UI.Button variant="secondary" onClick={leave}>
                {copy("back")}
              </UI.Button>
            }
            title={copy("forbidden")}
            variant="firstUse"
          />
        )}
      </UI.Stack>
    );
  }

  const failureValues = {
    address: attempt?.address ?? address,
    folder: attempt?.folder ?? "",
    revision: attempt?.revision ?? form.revision.trim(),
    host: httpsAddress(attempt?.address ?? address)?.host ?? "",
  };

  return (
    <UI.Stack gap="spacious" data-testid="skill-add-page">
      {header}
      {failedKind === null ? null : (
        <UI.Stack id={FAILURE_ID} tabIndex={-1}>
          <UI.InlineNotice tone="error" role="alert">
            <UI.Stack gap="tight">
              <UI.Text variant="strong">{copy("failedTitle")}</UI.Text>
              <UI.Text>{copy(`failure.${failedKind}`, failureValues)}</UI.Text>
              {fromSaved && failedKind !== "removed"
                ? <UI.Text>{copy("sourceKept")}</UI.Text>
                : null}
            </UI.Stack>
          </UI.InlineNotice>
        </UI.Stack>
      )}
      <UI.FormWithSummary
        aside={
          <UI.Stack gap="compact">
            <UI.Heading level="section">{copy("happens.title")}</UI.Heading>
            {organizationName === "" ? null : (
              <UI.Text>
                {copy("happens.forOrg", { organization: organizationName })}
              </UI.Text>
            )}
            <UI.Text>
              {copy(
                cleanFolder(form.folder) === ""
                  ? "happens.unnamed"
                  : "happens.named",
                { folder: importedName(form.folder) },
              )}
            </UI.Text>
            <UI.Text>{copy("happens.inUse")}</UI.Text>
            <UI.Text>{copy("happens.notRun")}</UI.Text>
            <UI.Text>{copy("happens.updates")}</UI.Text>
          </UI.Stack>
        }
        actions={
          <>
            <UI.Button variant="secondary" onClick={leave}>
              {reading ? copy("back") : translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              variant="primary"
              aria-busy={reading || undefined}
              disabled={reading}
              onClick={submit}
            >
              {copy(
                reading ? "reading" : failedKind === null ? "submit" : "again",
              )}
            </UI.Button>
          </>
        }
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <UI.Stack gap="spacious">
            <UI.Stack gap="standard">
              <UI.Heading level="section">{copy("from")}</UI.Heading>
              {saved.length === 0 ? null : (
                <UI.Stack
                  gap="tight"
                  role="radiogroup"
                  aria-label={copy("from")}
                >
                  <UI.PresetOption
                    checked={!fromSaved}
                    disabled={reading}
                    name="skill-add-from"
                    onChange={() => setFromSaved(false)}
                    title={copy("newRepository")}
                    value="new"
                  />
                  <UI.PresetOption
                    checked={fromSaved}
                    description={copy("savedCount", { count: saved.length })}
                    disabled={reading}
                    name="skill-add-from"
                    onChange={() => setFromSaved(true)}
                    title={copy("savedSource")}
                    value="saved"
                  />
                </UI.Stack>
              )}
              {fromSaved
                ? (
                  <>
                    <UI.Combobox
                      id="skill-add-sourceId"
                      disabled={reading}
                      error={problem("sourceId")}
                      label={copy("field.source")}
                      onChange={(event) =>
                        change({ sourceId: event.target.value })}
                      options={[
                        { value: "", label: copy("chooseSource") },
                        ...saved.map((source) => ({
                          value: source.id,
                          label: source.name ?? source.locator,
                        })),
                      ]}
                      value={form.sourceId}
                    />
                    {chosen === undefined ? null : (
                      <UI.DescriptionList>
                        {chosen.name === null ? null : (
                          <UI.DescriptionItem
                            title={copy("field.address")}
                            description={chosen.locator}
                          />
                        )}
                        {chosen.license
                          ? (
                            <UI.DescriptionItem
                              title={copy("field.licence")}
                              description={chosen.license}
                            />
                          )
                          : null}
                      </UI.DescriptionList>
                    )}
                  </>
                )
                : (
                  <>
                    {text("address", true, copy("hint.address"))}
                    {text("name", true, copy("hint.name"))}
                    {text("licence", true, copy("hint.licence"))}
                  </>
                )}
            </UI.Stack>
            <UI.Stack gap="standard">
              <UI.Heading level="section">{copy("take")}</UI.Heading>
              {text("revision", true, copy("hint.revision"))}
              {text("folder", false, copy("hint.folder"))}
            </UI.Stack>
          </UI.Stack>
        </form>
      </UI.FormWithSummary>
      {reading
        ? <UI.Text variant="muted" role="status">{copy("canLeave")}</UI.Text>
        : null}
    </UI.Stack>
  );
}
