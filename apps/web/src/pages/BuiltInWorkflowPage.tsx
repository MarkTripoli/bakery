import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { MakeCopyDialog } from "./library/MakeCopyDialog.tsx";
import { presetSource } from "./library/copy-workflow.ts";
import { presetDefinition } from "./library/preset-tree.ts";
import { treeOf } from "./library/workflow-tree.ts";
import { WorkflowDiagram } from "./library/WorkflowDiagram.tsx";
import { presetCopy } from "./task-composer-labels.ts";

// A read-only diagram reports nothing: the problems in it belong to a draft.
const EMPTY_PROBLEMS: ReadonlyMap<string, string> = new Map();

/**
 * One built-in workflow (design-ux, #66): maintained by Bakery, so it is only
 * read here; the one action is to make a copy of it, which the organization
 * can then change.
 */
export function BuiltInWorkflowPage(
  { presetId }: { readonly presetId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const presets = useQuery(workflowPresetsQueryOptions(api, scope, null));
  const [copying, setCopying] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const preset = presets.data?.items.find((row) => row.id === presetId);
  // The same tree the editor draws, so no step is dropped from this page.
  const tree = treeOf(
    presetDefinition(preset === undefined ? [] : preset.steps),
  );
  const labels = preset === undefined
    ? undefined
    : presetCopy(translate, preset.id);
  const title = labels?.title ??
    translate("library.workflow.breadcrumb" as never);

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library", label: translate("library.title" as never) },
          { label: title },
        ]}
      />
    </ShellSlot>
  );
  const heading = <UI.PageHeader variant="list" flush title={title} />;

  if (presets.isPending && !presets.isError) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="builtin-workflow-page" variant="wide">
          {heading}
          <UI.Stack gap="standard" aria-busy="true">
            <UI.Text variant="muted" role="status">
              {translate("library.workflow.loading" as never)}
            </UI.Text>
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        </UI.SettingsContent>
      </>
    );
  }
  if (preset === undefined) {
    const failed = presets.isError;
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="builtin-workflow-page" variant="wide">
          {heading}
          {!failed
            ? (
              <UI.EmptyState
                title={translate("library.builtIn.page.notFoundTitle" as never)}
                description={translate(
                  "library.workflow.notFound.description" as never,
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void navigate({ to: "/library" })}
                  >
                    {translate("library.workflow.back" as never)}
                  </UI.Button>
                }
                variant="firstUse"
              />
            )
            : isForbiddenFailure(presets.error)
            ? (
              <UI.EmptyState
                title={translate("library.forbidden.title" as never)}
                description={translate(
                  "library.forbidden.description" as never,
                )}
                variant="firstUse"
              />
            )
            : (
              <UI.ErrorState
                title={translate(
                  (asyncKindForError(presets.error) === "offline"
                    ? "library.offlineTitle"
                    : "library.error.title") as never,
                )}
                description={translate(
                  (asyncKindForError(presets.error) === "offline"
                    ? "library.offlineDescription"
                    : "library.error.description") as never,
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void presets.refetch()}
                  >
                    {translate("library.retry" as never)}
                  </UI.Button>
                }
              />
            )}
        </UI.SettingsContent>
      </>
    );
  }

  const copyButton = canManage
    ? (
      <UI.Button
        variant="primary"
        disabled={offline}
        onClick={() => {
          opener.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
          setCopying(true);
        }}
      >
        {translate("library.workflow.makeCopy" as never)}
      </UI.Button>
    )
    : null;

  return (
    <>
      {breadcrumbs}
      {copyButton === null || phone
        ? null
        : <ShellSlot name="actions">{copyButton}</ShellSlot>}
      <UI.SettingsContent data-testid="builtin-workflow-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={title}
          subtitle={
            <UI.Stack gap="compact">
              {labels?.description
                ? <UI.Text variant="muted">{labels.description}</UI.Text>
                : null}
              <UI.Inline gap="compact">
                <UI.Badge tone="neutral">
                  {translate("library.builtIn.page.badge" as never)}
                </UI.Badge>
                <UI.Text variant="caption">
                  {translate("library.builtIn.version" as never, {
                    version: preset.revision,
                  })}
                </UI.Text>
              </UI.Inline>
            </UI.Stack>
          }
          actions={phone ? copyButton : null}
        />
        <UI.Stack gap="spacious">
          <UI.InlineNotice tone="information">
            {translate(
              (canManage
                ? "library.builtIn.page.notice"
                : "library.builtIn.page.memberNotice") as never,
            )}
          </UI.InlineNotice>
          <UI.ListSection
            flush
            data-testid="workflow-steps"
            title={translate("library.workflow.steps.title" as never, {
              version: preset.revision,
            })}
            description={translate("library.workflow.steps.never" as never)}
            variant="list"
          >
            <WorkflowDiagram
              tree={tree}
              selectedId={null}
              problems={EMPTY_PROBLEMS}
              canManage={false}
              editable={false}
              readOnlyPage
              onAdd={() => {}}
              onSelect={() => {}}
              onViewAsCode={() => {}}
              onPick={() => {}}
              onPickClose={() => {}}
            />
          </UI.ListSection>
        </UI.Stack>
      </UI.SettingsContent>
      {copying && labels !== undefined
        ? (
          <MakeCopyDialog
            source={presetSource(preset, {
              title: labels.title,
              description: labels.description ?? null,
            })}
            onClose={() => {
              setCopying(false);
              focusAfterPaint(() => opener.current);
            }}
            onMade={(workflow) =>
              void navigate({
                to: "/library/workflows/$workflowId",
                params: { workflowId: workflow.id },
              })}
          />
        )
        : null}
    </>
  );
}
