import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  attachableSkillsQueryOptions,
  effectiveAccessQueryOptions,
  workflowQueryOptions,
  workflowVersionSkillsQueryOptions,
  workflowVersionsQueryOptions,
} from "../../api/query.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";

import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import { WORK_HOME } from "../../shell/breadcrumb-paths.ts";
import {
  type PanelTarget,
  type SkillChoice,
  StepPanel,
  type StepSkillRow,
  type StepSkills,
} from "./StepPanel.tsx";
import type { SkillResponse, WorkflowVersionSkills } from "../../api/client.ts";
import { WorkflowDiagram } from "./WorkflowDiagram.tsx";
import { versionSource } from "./copy-workflow.ts";
import {
  definitionOf,
  editorReducer,
  editorStateOf,
  type EditorStep,
  freeStepId,
  skillsOfNode,
} from "./editor-state.ts";
import {
  problemSentence,
  problemsOf,
  stepProblemLine,
} from "./editor-validation.ts";
import { ACTION_TITLES } from "./workflow-state.ts";
import {
  type GroupLabel,
  groupsOfTree,
  stepsOfTree,
  treeOf,
  type TreeStep,
} from "./workflow-tree.ts";

/**
 * The workflow editor (#67, slice 1 of the owner's spec): the workflow drawn
 * top to bottom, a "+" on every connector to add a step, the selected step in
 * the panel, and the draft saved to the server as it changes — the header says
 * which of those it is doing. Publishing, the code view behind More, and the
 * problems' sentences arrive in the commits after this one.
 */

/** How long the editor waits after a change before it saves the draft. */
const SAVE_AFTER_MS = 600;

/**
 * The save state a spec or a still can ask the page to show, in the same spirit
 * as the prototype's State menu (#67): `?state=save-failed` or `?state=saving`.
 * Development builds only, so a person never sees it in production.
 */
function forcedSaveState(): SaveState | null {
  if (!import.meta.env.DEV) return null;
  const asked = new URLSearchParams(globalThis.location?.search ?? "").get(
    "state",
  );
  if (asked === "save-failed") return { kind: "failed" };
  if (asked === "saving") return { kind: "saving" };
  return null;
}

type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed" };

/**
 * One line of the problems list (design-ux's ruling, comment 6917906748): what
 * it is about, the sentence, and the one action that answers it. A row with no
 * step to select can only be read in the code, so it offers "View as code" —
 * a button never points at nothing.
 */
type ProblemRow = {
  readonly key: string;
  /** The step or group's name; empty for a problem that has no place in the drawing. */
  readonly name: string;
  readonly sentence: string;
  readonly stepId: string | null;
};

const GROUP_LABEL: Readonly<Record<GroupLabel, string>> = {
  yes: "library.editor.group.yes",
  otherwise: "library.editor.group.otherwise",
  together: "library.editor.group.together",
  repeat: "library.editor.group.repeat",
  wait: "library.editor.group.wait",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Whether a node of the definition is a plain action step, which slice 1 edits. */
function isActionNode(value: unknown): boolean {
  const node = record(value);
  const kind = node.kind;
  return (kind === undefined || kind === "action") &&
    typeof node.id === "string" && typeof node.uses === "string";
}

export function WorkflowEditorPage(
  { workflowId }: { readonly workflowId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const queryClient = useQueryClient();
  const { translate } = useI18n();

  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );

  // The version being edited is the workflow's draft when there is one, else
  // the version in use, else the newest version.
  const draft = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.status === "draft") ??
      items.find((item) => item.id === workflow.data?.activeVersionId) ??
      items[0] ??
      null;
  }, [versions.data, workflow.data]);

  const inUse = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.id === workflow.data?.activeVersionId) ??
      null;
  }, [versions.data, workflow.data]);

  const versionSteps = useMemo<readonly EditorStep[]>(() => {
    const spec = record(draft?.normalizedSpec);
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    return steps.flatMap((raw) => {
      const step = record(raw);
      const id = typeof step.id === "string" ? step.id : "";
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (id === "") return [];
      return [{
        id,
        uses,
        agentVersionId: typeof step.agentVersionId === "string"
          ? step.agentVersionId
          : null,
        skills: skillsOfNode(step),
      }];
    });
  }, [draft]);

  // The skills the steps of the draft name (#431), read for the saved draft: a
  // step is found by its place in the definition, so a saved change reads again.
  const skillsRead = useQuery(
    workflowVersionSkillsQueryOptions(
      api,
      scope,
      workflowId,
      draft?.id ?? "",
      draft?.digest ?? "",
    ),
  );
  // The skills a person may attach, and what is in flight (#431, design-ux).
  const catalog = useQuery(attachableSkillsQueryOptions(api, scope));
  // Personal skill versions the owner confirmed this session; the draft save names them.
  const confirmed = useRef<Set<string>>(new Set());
  const [attaching, setAttaching] = useState<
    { readonly stepId: string; readonly choice: SkillChoice } | null
  >(null);
  const [removingOther, setRemovingOther] = useState<
    {
      readonly stepId: string;
      readonly versionId: string;
      readonly name: string;
      readonly owner: string;
    } | null
  >(null);
  const [skillToast, setSkillToast] = useState<
    { readonly text: string; readonly undo?: () => void } | null
  >(null);
  const stepPaths = useMemo(() => {
    const spec = record(draft?.normalizedSpec);
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    const paths = new Map<string, string>();
    steps.forEach((raw, index) => {
      const id = record(raw).id;
      if (typeof id === "string") paths.set(id, `/steps/${index}`);
    });
    return paths;
  }, [draft]);

  const [editor, dispatch] = useReducer(
    editorReducer,
    versionSteps,
    editorStateOf,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerAfter, setPickerAfter] = useState<string | null | undefined>(
    undefined,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved" });
  const [codeOpen, setCodeOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  // The step just deleted, by name, while its Undo is offered.
  const [deleted, setDeleted] = useState<string | null>(null);
  // null until the version being edited is known: an unknown baseline is not a
  // change, so the leave warning is never armed on a page nobody has touched.
  const lastSaved = useRef<string | null>(null);

  // A different version being edited starts the editor again.
  useEffect(() => {
    dispatch({ kind: "reset", steps: versionSteps });
    lastSaved.current = JSON.stringify(versionSteps);
    setSaveState({ kind: "saved" });
  }, [draft?.id, versionSteps]);

  const failure = workflow.error ?? versions.error;
  const status = failureStatus(failure);
  const forbidden = status === 403;
  const missing = workflow.data === undefined && status === 404;
  const offline = asyncKindForError(failure) === "offline";
  const loading = !forbidden && !missing && !offline &&
    (workflow.isPending || versions.isPending);

  // Saving the draft: one write per quiet moment, keyed so a failure is
  // reported under the operation it happened in.
  const save = useMutation({
    mutationKey: ["workflowVersions.update"],
    mutationFn: async (steps: readonly EditorStep[]) => {
      if (draft === null) throw new Error("no draft version");
      const result = await api.updateWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: draft.id,
        version: draft.version,
        input: {
          definition: definitionOf(
            record(draft.normalizedSpec),
            steps,
          ) as never,
          // The owner's confirmation for each private skill still attached, so the save is not refused.
          ...(() => {
            const attached = new Set(steps.flatMap((step) => step.skills));
            const confirmedHere = [...confirmed.current].filter((id) =>
              attached.has(id)
            ).slice(0, 32);
            return confirmedHere.length === 0
              ? {}
              : { confirmPersonalSkillUse: confirmedHere };
          })(),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onMutate: () => setSaveState({ kind: "saving" }),
    onSuccess: () => {
      lastSaved.current = JSON.stringify(editor.steps);
      setSaveState({ kind: "saved" });
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
    onError: () => setSaveState({ kind: "failed" }),
  });

  // Publishing the draft, and optionally making it the version in use: two
  // forms of one action, decided by the button the person presses.
  const publish = useMutation({
    mutationKey: ["workflowVersions.publish"],
    mutationFn: async (alsoUse: boolean) => {
      if (draft === null) throw new Error("no draft version");
      const published = await api.publishWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: draft.id,
        expectedDigest: draft.digest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!published.ok) throw published.error;
      if (!alsoUse) return published.data;
      const used = await api.activateWorkflowVersion({
        organizationId: scope.organizationId as string,
        id: workflowId,
        versionId: published.data.id,
        version: workflow.data?.version ?? 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!used.ok) throw used.error;
      return published.data;
    },
    onSuccess: () => {
      setPublishOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
  });

  const steps = editor.steps;
  const inUseSteps = useMemo<readonly EditorStep[]>(() => {
    const spec = record(inUse?.normalizedSpec);
    const held = Array.isArray(spec.steps) ? spec.steps : [];
    return held.flatMap((raw) => {
      const step = record(raw);
      const id = typeof step.id === "string" ? step.id : "";
      return id === "" ? [] : [{
        id,
        uses: typeof step.uses === "string" ? step.uses : "",
        agentVersionId: null,
        skills: skillsOfNode(step),
      }];
    });
  }, [inUse]);
  const draftDiffers = draft !== null &&
    JSON.stringify(steps) !== JSON.stringify(inUseSteps);

  // The drawing comes from the definition itself, so nothing in it is left out:
  // groups, steps only changeable in code, and steps Bakery cannot read all keep
  // their place. A definition that is a straight line of actions is drawn from
  // the editor's own list, so an add, move or remove shows at once.
  const rawSpec = useMemo(
    () => draft === null ? null : record(draft.normalizedSpec),
    [draft],
  );
  const rawSteps = useMemo<readonly unknown[] | null>(() => {
    if (rawSpec === null) return null;
    return Array.isArray(rawSpec.steps) ? rawSpec.steps : null;
  }, [rawSpec]);
  const plainList = rawSteps !== null && rawSteps.every(isActionNode);
  const tree = useMemo(() => {
    if (rawSteps === null) return treeOf({});
    if (!plainList) return treeOf(rawSpec);
    const rawById = new Map<string, Record<string, unknown>>();
    for (const node of rawSteps) {
      const held = record(node);
      if (typeof held.id === "string") rawById.set(held.id, held);
    }
    return treeOf({
      steps: steps.map((step) => ({
        ...(rawById.get(step.id) ?? {}),
        kind: "action",
        id: step.id,
        uses: step.uses,
        ...(step.agentVersionId === null
          ? {}
          : { agentVersionId: step.agentVersionId }),
      })),
    });
  }, [rawSpec, rawSteps, plainList, steps]);
  // Slice 1 adds, moves and removes only the actions of a straight line; a
  // definition that holds groups is drawn and read, never rewritten.
  const editable = canManage && plainList;

  // Checking is continuous: the draft is checked against the server as it
  // changes, and each problem lands on the step its pointer names. A problem
  // that points at no step is the workflow's own, and the chip still counts it.
  const [checker, setChecker] = useState<{
    readonly byStep: ReadonlyMap<string, string>;
    /** Problems that name a step the page does not draw, so no card can hold them. */
    readonly unmapped: readonly string[];
    readonly workflow: readonly string[];
  }>({ byStep: new Map(), unmapped: [], workflow: [] });
  const check = useMutation({
    mutationKey: ["workflows.validate"],
    mutationFn: async (held: readonly EditorStep[]) => {
      const result = await api.validateWorkflow({
        organizationId: scope.organizationId as string,
        input: {
          definition: definitionOf(
            draft === null ? null : record(draft.normalizedSpec),
            held,
          ) as never,
        },
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (report, held) => {
      const sorted = problemsOf([
        ...(report.errors ?? []),
        ...(report.warnings ?? []),
      ]);
      const byStep = new Map<string, string>();
      const unmapped: string[] = [];
      for (const [index, found] of sorted.byStep) {
        const sentence = stepProblemLine(found) ?? "";
        const step = held[index];
        // A pointer past the steps the page sent names a step nothing draws;
        // the chip still counts it, and its row can only be read in the code.
        if (step === undefined) {
          unmapped.push(sentence);
          continue;
        }
        byStep.set(step.id, sentence);
      }
      setChecker({
        byStep,
        unmapped,
        // The workflow's own problems are sentences too, never the server's
        // message (ruling 6900485736 section 3).
        workflow: sorted.workflow.map((problem) =>
          problemSentence(problem.code)
        ),
      });
    },
  });

  useEffect(() => {
    if (steps.length === 0) {
      setChecker({ byStep: new Map(), unmapped: [], workflow: [] });
      return;
    }
    const timer = setTimeout(() => check.mutate(steps), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [steps]);

  const changed = lastSaved.current !== null &&
    JSON.stringify(steps) !== lastSaved.current;

  // A change saves itself once the person stops typing; a failed save waits for
  // "Try again" rather than looping.
  useEffect(() => {
    if (!canManage || draft === null || saveState.kind === "failed") return;
    if (!changed) return;
    const timer = setTimeout(() => save.mutate(steps), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [changed, steps, canManage, draft, saveState.kind]);

  // Leaving while the latest change is not saved asks first.
  useEffect(() => {
    if (saveState.kind === "saved" && !changed) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [saveState.kind, changed]);

  const shownSave: SaveState = forcedSaveState() ?? saveState;
  const stateWord = shownSave.kind === "saving"
    ? translate("library.editor.save.saving" as never)
    : shownSave.kind === "failed"
    ? translate("library.editor.save.failed" as never)
    : translate("library.editor.save.saved" as never);

  // Every problem, in the order the page shows them: a card that needs setup
  // first (one problem each), then a definition whose steps cannot be read,
  // then whatever the checker found that those do not already count.
  const rows = useMemo<readonly ProblemRow[]>(() => {
    const out: ProblemRow[] = [];
    const drawn = stepsOfTree(tree);
    for (const step of drawn) {
      if (step.problem === undefined) continue;
      out.push({
        key: `card-${step.id}`,
        name: stepName(step, translate),
        sentence: step.problem === "unknown"
          ? translate("library.editor.problem.unknown" as never)
          : translate("library.editor.problem.unreadable" as never),
        stepId: step.id,
      });
    }
    if (tree.unreadable) {
      out.push({
        key: "steps-unreadable",
        name: "",
        sentence: translate("library.editor.problem.stepsUnreadable" as never),
        stepId: null,
      });
    }
    const drawnIds = new Set(drawn.map((step) => step.id));
    for (const [id, sentence] of checker.byStep) {
      if (out.some((row) => row.stepId === id)) continue;
      const step = drawn.find((drawnStep) => drawnStep.id === id);
      if (step === undefined) {
        // A problem on a step the page does not draw has no card to select.
        out.push({
          key: `checker-${id}`,
          name: "",
          sentence,
          stepId: null,
        });
        continue;
      }
      out.push({
        key: `checker-${id}`,
        name: stepName(step, translate),
        sentence,
        stepId: drawnIds.has(id) ? id : null,
      });
    }
    checker.unmapped.forEach((sentence, index) => {
      out.push({
        key: `unmapped-${index}`,
        name: "",
        sentence,
        stepId: null,
      });
    });
    checker.workflow.forEach((sentence, index) => {
      out.push({
        key: `workflow-${index}`,
        name: "",
        sentence,
        stepId: null,
      });
    });
    return out;
  }, [tree, checker, translate]);

  const problemCount = rows.length;
  const problemWord = problemCount === 0
    ? translate("library.editor.ready" as never)
    : problemCount === 1
    ? translate("library.editor.problem.one" as never)
    : translate("library.editor.problems" as never, {
      count: String(problemCount),
    });

  // Attaching and removing a skill is one change to a step's skills, so undo and redo work.
  const say = (key: string, values: Record<string, string>) =>
    translate(
      `library.workflow.editor.skills.${key}` as never,
      values as never,
    );
  const attachNow = (stepId: string, choice: SkillChoice) => {
    const step = editor.steps.find((held) => held.id === stepId);
    if (step === undefined || step.skills.includes(choice.value)) return;
    if (choice.group === "private") confirmed.current.add(choice.value);
    dispatch({
      kind: "skills",
      id: stepId,
      skills: [...step.skills, choice.value],
    });
    // An organization skill attaches at once; a private one says what it now allows.
    if (choice.group === "private") {
      setSkillToast({
        text: say("toast.attached", {
          skill: choice.name,
          version: String(choice.revision),
        }),
      });
    }
  };
  const removeNow = (
    stepId: string,
    versionId: string,
    name: string,
    published: boolean,
  ) => {
    const step = editor.steps.find((held) => held.id === stepId);
    if (step === undefined) return;
    const before = step.skills;
    dispatch({
      kind: "skills",
      id: stepId,
      skills: before.filter((id) => id !== versionId),
    });
    setSkillToast({
      text: say(published ? "toast.removedPublished" : "toast.removed", {
        skill: name,
      }),
      undo: () => dispatch({ kind: "skills", id: stepId, skills: before }),
    });
  };

  // What the panel shows for what is selected: the start card, a part written
  // in code (a group, or a step only changeable in code), or a step.
  const panelTarget = useMemo<PanelTarget | null>(() => {
    if (selectedId === null) return null;
    if (selectedId === "start") return { kind: "start" };
    const group = groupsOfTree(tree).find((held) => held.id === selectedId);
    if (group !== undefined) {
      return {
        kind: "codeOnly",
        name: translate(GROUP_LABEL[group.label] as never),
        problem: undefined,
      };
    }
    const step = stepsOfTree(tree).find((held) => held.id === selectedId);
    if (step === undefined) return null;
    if (step.codeOnly === true) {
      return {
        kind: "codeOnly",
        name: stepName(step, translate),
        problem: checker.byStep.get(step.id),
      };
    }
    const live = steps.find((held) => held.id === selectedId);
    const index = live === undefined ? -1 : steps.indexOf(live);
    return {
      kind: "step",
      name: stepName(step, translate),
      deletable: editable,
      uses: step.uses,
      code: step.code,
      problem: step.problem === undefined
        ? undefined
        : step.problem === "unknown"
        ? translate("library.editor.problem.unknown" as never)
        : translate("library.editor.problem.unreadable" as never),
      skills: skillsOf(
        live?.agentVersionId != null,
        stepPaths.get(step.id),
        skillsRead,
        live?.skills ?? [],
        catalog.data ?? [],
        editable
          ? (row) => () => {
            // Someone else's private skill asks first: only its owner can attach it again.
            if (row.theirs) {
              setRemovingOther({
                stepId: step.id,
                versionId: row.versionId,
                name: row.name,
                owner: row.owner,
              });
            } else {
              removeNow(step.id, row.versionId, row.name, row.published);
            }
          }
          : null,
      ),
      attach: editable && live?.agentVersionId != null
        ? {
          state: catalog.isError
            ? "failed"
            : catalog.isPending
            ? "loading"
            : "ready",
          choices: (catalog.data ?? [])
            .filter((skill) =>
              !(live.skills ?? []).includes(skill.activeVersionId as string)
            )
            .map((skill) => ({
              value: skill.activeVersionId as string,
              name: skill.name,
              slug: skill.slug,
              revision: skill.activeRevision as number,
              group: skill.scope === "personal"
                ? "private" as const
                : "organization" as const,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          onRetry: () => void catalog.refetch(),
          onChoose: (value: string) => {
            const picked = (catalog.data ?? []).find((skill) =>
              skill.activeVersionId === value
            );
            if (picked === undefined) return;
            const choice: SkillChoice = {
              value,
              name: picked.name,
              slug: picked.slug,
              revision: picked.activeRevision as number,
              group: picked.scope === "personal" ? "private" : "organization",
            };
            // A private skill asks first: the owner confirms what is shared.
            if (choice.group === "private") {
              setAttaching({ stepId: step.id, choice });
            } else attachNow(step.id, choice);
          },
        }
        : null,
      canMoveUp: index > 0,
      canMoveDown: index >= 0 && index < steps.length - 1,
      disabled: !editable || index < 0,
      onMoveUp: () => {
        if (live === undefined) return;
        dispatch({ kind: "move", id: live.id, index: index - 1 });
      },
      onMoveDown: () => {
        if (live === undefined) return;
        dispatch({ kind: "move", id: live.id, index: index + 1 });
      },
      onRemove: () => {
        if (live === undefined) return;
        // The toast names what went, so Undo reads as "put that back" rather
        // than as a word under a card (#67 UX ruling 6932934119 fix 5).
        setDeleted(stepName(step, translate));
        dispatch({ kind: "remove", id: live.id });
        setSelectedId(null);
      },
    };
  }, [
    selectedId,
    tree,
    steps,
    editable,
    translate,
    stepPaths,
    skillsRead.data,
    skillsRead.status,
    skillsRead.fetchStatus,
    catalog.data,
    catalog.status,
  ]);

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library", label: translate("library.title" as never) },
          {
            href: `/library/workflows/${workflowId}`,
            label: workflow.data?.name ??
              translate("library.workflow.breadcrumb" as never),
          },
        ]}
      />
    </ShellSlot>
  );

  const back = (
    <RouterLink
      to="/library/workflows/$workflowId"
      params={{ workflowId }}
      variant="back"
    >
      {translate("library.editor.back" as never)}
    </RouterLink>
  );

  const problemList = (
    <UI.Stack gap="compact" data-testid="editor-problem-list">
      {rows.map((row) => (
        <UI.Inline key={row.key} data-problem-row={row.key} gap="compact">
          <UI.Stack gap="compact">
            {row.name === ""
              ? null
              : <UI.Text variant="strong">{row.name}</UI.Text>}
            <UI.Text>{row.sentence}</UI.Text>
          </UI.Stack>
          <UI.Inline gap="compact">
            {row.stepId === null
              ? (
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    setProblemsOpen(false);
                    setCodeOpen(true);
                  }}
                >
                  {translate("library.editor.viewAsCode" as never)}
                </UI.Button>
              )
              : (
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    setProblemsOpen(false);
                    setSelectedId(row.stepId);
                  }}
                >
                  {translate("library.editor.problem.showMe" as never)}
                </UI.Button>
              )}
          </UI.Inline>
        </UI.Inline>
      ))}
    </UI.Stack>
  );

  const body = forbidden
    ? (
      <UI.ErrorState
        title={translate("library.workflow.notFound.title" as never)}
        description={translate("library.workflow.adminOnly" as never)}
      />
    )
    : missing
    ? (
      <UI.ErrorState
        title={translate("library.workflow.notFound.title" as never)}
        description={translate(
          "library.workflow.notFound.description" as never,
        )}
        action={back}
      />
    )
    : offline
    ? (
      <UI.ErrorState
        title={translate("library.editor.offline.title" as never)}
        description={translate("library.editor.offline.description" as never)}
      />
    )
    : loading
    ? (
      <UI.Text role="status">
        {translate("library.workflow.loading" as never)}
      </UI.Text>
    )
    : draft === null
    ? (
      <UI.EmptyState
        inset="page"
        icon={<UI.IconGlyph name="book" size="large" />}
        title={translate("library.editor.empty.title" as never)}
        description={translate("library.editor.empty.description" as never)}
      />
    )
    : (
      <UI.Inline gap="standard" data-ui-region="editor-work-surface">
        <UI.Stack gap="standard">
          <WorkflowDiagram
            tree={tree}
            selectedId={selectedId}
            problems={checker.byStep}
            canManage={canManage}
            editable={editable}
            onAdd={(afterId) => setPickerAfter(afterId)}
            onSelect={setSelectedId}
            onViewAsCode={() => setCodeOpen(true)}
            pickerAt={pickerAfter}
            onPick={(uses) => {
              const afterId = pickerAfter ?? null;
              const id = freeStepId(editor, uses.replaceAll(".", "-"));
              const step = { id, uses, agentVersionId: null, skills: [] };
              dispatch({ kind: "add", step });
              // Put the new step where the "+" was pressed.
              if (afterId !== null) {
                const at = steps.findIndex((one) => one.id === afterId);
                dispatch({ kind: "move", id, index: at + 1 });
              }
              setPickerAfter(undefined);
              setSelectedId(id);
            }}
            onPickClose={() => setPickerAfter(undefined)}
          />
        </UI.Stack>
        {panelTarget === null ? null : (
          <StepPanel
            target={panelTarget}
            onViewAsCode={() => setCodeOpen(true)}
          />
        )}
      </UI.Inline>
    );

  return (
    <>
      {canManage && draft !== null
        ? (
          <ShellSlot name="actions">
            <UI.Inline gap="compact">
              {shownSave.kind === "failed"
                ? (
                  <UI.Button
                    variant="secondary"
                    onClick={() => save.mutate(steps)}
                  >
                    {translate("library.editor.save.tryAgain" as never)}
                  </UI.Button>
                )
                : null}
              <UI.Text variant="muted" role="status">
                {stateWord}
              </UI.Text>
              {problemCount === 0
                ? (
                  <span data-testid="editor-problems">
                    <UI.Badge tone="neutral">{problemWord}</UI.Badge>
                  </span>
                )
                : (
                  <UI.Button
                    variant="quiet"
                    data-testid="editor-problems"
                    onClick={() => setProblemsOpen(true)}
                  >
                    <UI.Badge tone="danger">{problemWord}</UI.Badge>
                  </UI.Button>
                )}
              <UI.Button
                variant="secondary"
                onClick={() => setCodeOpen(true)}
              >
                {translate("library.editor.viewAsCode" as never)}
              </UI.Button>
              <UI.Button
                variant="primary"
                onClick={() => setPublishOpen(true)}
              >
                {translate("library.editor.publish" as never)}
              </UI.Button>
            </UI.Inline>
          </ShellSlot>
        )
        : null}
      {
        /* `list` rather than `split`: the subtitle is a stack of sentences, and
          `split` nests it in a paragraph, which a stack cannot live inside. */
      }
      <UI.PageHeader
        flush
        variant="list"
        title={workflow.data?.name ??
          translate("library.editor.title" as never)}
        subtitle={
          <UI.Stack gap="compact">
            <UI.Text variant="muted">
              {inUse === null
                ? translate("library.editor.version.draft" as never)
                : translate("library.editor.version.inUse" as never, {
                  version: inUse.revision,
                })}
            </UI.Text>
            {
              /* A member needs to know before they try, on its own line so the
                two sentences never run together (#67 UX ruling 6934081003
                fix 4). */
            }
            {canManage ? null : (
              <UI.Text variant="muted">
                {translate("library.editor.memberOnly" as never)}
              </UI.Text>
            )}
          </UI.Stack>
        }
      />
      {breadcrumbs}
      {body}
      {deleted === null ? null : (
        <UI.Toast
          tone="success"
          action={
            <UI.Button
              variant="secondary"
              onClick={() => {
                dispatch({ kind: "undo" });
                setDeleted(null);
              }}
            >
              {translate("library.editor.undo" as never)}
            </UI.Button>
          }
          onDismiss={() => setDeleted(null)}
        >
          {translate("library.editor.deleted" as never, {
            name: deleted,
          })}
        </UI.Toast>
      )}
      {skillToast === null ? null : (
        <UI.Toast
          tone="success"
          {...(skillToast.undo === undefined ? {} : {
            action: (
              <UI.Button
                variant="secondary"
                onClick={() => {
                  skillToast.undo?.();
                  setSkillToast(null);
                }}
              >
                {say("toast.undo", {})}
              </UI.Button>
            ),
          })}
          onDismiss={() => setSkillToast(null)}
        >
          {skillToast.text}
        </UI.Toast>
      )}
      {attaching === null ? null : (
        <UI.AlertDialog
          open
          title={say("confirm.title", {})}
          onOpenChange={(open) => {
            if (!open) setAttaching(null);
          }}
          cancelAction={
            <UI.Button
              variant="secondary"
              onClick={() => setAttaching(null)}
            >
              {translate("core.actions.cancel" as never)}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              variant="primary"
              onClick={() => {
                attachNow(attaching.stepId, attaching.choice);
                setAttaching(null);
              }}
            >
              {say("confirm.action", {})}
            </UI.Button>
          }
        >
          <UI.Stack gap="compact">
            <UI.Text>
              {say("confirm.lead", {
                workflow: workflow.data?.name ?? "",
                skill: attaching.choice.name,
                version: String(attaching.choice.revision),
              })}
            </UI.Text>
            <UI.Text>{say("confirm.see", {})}</UI.Text>
            <UI.Text>{say("confirm.files", {})}</UI.Text>
            <UI.Text>{say("confirm.quote", {})}</UI.Text>
            <UI.Text>
              {say("confirm.version", {
                version: String(attaching.choice.revision),
              })}
            </UI.Text>
            <UI.Text variant="muted">{say("confirm.stop", {})}</UI.Text>
          </UI.Stack>
        </UI.AlertDialog>
      )}
      {removingOther === null ? null : (
        <UI.AlertDialog
          open
          title={removingOther.owner === ""
            ? say("removeOther.titleUnnamed", {})
            : say("removeOther.title", { owner: removingOther.owner })}
          onOpenChange={(open) => {
            if (!open) setRemovingOther(null);
          }}
          cancelAction={
            <UI.Button
              variant="secondary"
              onClick={() => setRemovingOther(null)}
            >
              {translate("core.actions.cancel" as never)}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              variant="primary"
              onClick={() => {
                removeNow(
                  removingOther.stepId,
                  removingOther.versionId,
                  removingOther.name,
                  false,
                );
                setRemovingOther(null);
              }}
            >
              {say("remove.action", {})}
            </UI.Button>
          }
        >
          <UI.Text>
            {removingOther.owner === ""
              ? say("removeOther.bodyUnnamed", {})
              : say("removeOther.body", { owner: removingOther.owner })}
          </UI.Text>
        </UI.AlertDialog>
      )}
      {problemsOpen
        ? (
          <UI.Dialog
            open
            title={translate("library.editor.problem.list" as never)}
            onOpenChange={(open) => {
              if (!open) setProblemsOpen(false);
            }}
          >
            {problemList}
          </UI.Dialog>
        )
        : null}
      {publishOpen && draft !== null
        ? (
          <UI.AlertDialog
            open
            variant="destructive"
            title={draftDiffers
              ? translate("library.editor.publish.title" as never, {
                version: String((inUse?.revision ?? 0) + 1),
              })
              : translate("library.editor.publish.nothing" as never)}
            state={publish.isPending ? "confirming" : "open"}
            onOpenChange={(open) => {
              if (!open) setPublishOpen(false);
            }}
            cancelAction={
              <UI.Button
                variant="outline"
                disabled={publish.isPending}
                onClick={() => setPublishOpen(false)}
              >
                {draftDiffers
                  ? translate("library.editor.publish.cancel" as never)
                  : translate("library.editor.publish.close" as never)}
              </UI.Button>
            }
            confirmAction={draftDiffers
              ? (
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={publish.isPending}
                    loading={publish.isPending}
                    onClick={() => publish.mutate(false)}
                  >
                    {translate("library.editor.publish.only" as never)}
                  </UI.Button>
                  <UI.Button
                    variant="primary"
                    disabled={publish.isPending}
                    onClick={() => publish.mutate(true)}
                  >
                    {translate("library.editor.publish.andUse" as never)}
                  </UI.Button>
                </UI.Inline>
              )
              : undefined}
          >
            {draftDiffers
              ? (
                <UI.Stack gap="tight">
                  <UI.Text>
                    {translate("library.editor.publish.body" as never)}
                  </UI.Text>
                  <UI.Text variant="muted">
                    {translate("library.workflow.steps.never" as never)}
                  </UI.Text>
                  {/* Pressed with problems, publishing shows the same list. */}
                  {problemCount === 0 ? null : problemList}
                </UI.Stack>
              )
              : (
                <UI.Text>
                  {translate("library.editor.publish.nothingBody" as never)}
                </UI.Text>
              )}
          </UI.AlertDialog>
        )
        : null}
      {codeOpen && draft !== null
        ? (
          <UI.Dialog
            open
            title={translate("library.editor.code.label" as never)}
            onOpenChange={(open) => {
              if (!open) setCodeOpen(false);
            }}
          >
            <UI.CodeBlock
              aria-label={translate("library.editor.code.label" as never)}
              code={versionSource(
                workflow.data ?? { name: "", description: "" },
                draft,
              ).sourceYaml ?? ""}
              language="yaml"
              variant="syntax"
            />
          </UI.Dialog>
        )
        : null}
    </>
  );
}

/**
 * What a step's Skills list shows (#431): only a step with an agent has one.
 * The rows are the skills the server names for the step's place in the draft,
 * in the order it gives them, bent to the edit not yet saved: a skill just
 * attached shows at once (from the catalog), one just removed is gone. While
 * the read is on its way, or when it failed, the list says so instead of
 * looking empty.
 */
function skillsOf(
  hasAgent: boolean,
  stepPath: string | undefined,
  read: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly fetchStatus: string;
    readonly data: WorkflowVersionSkills | undefined;
    readonly refetch: () => unknown;
  },
  held: readonly string[],
  catalog: readonly SkillResponse[],
  removable:
    | ((row: {
      readonly versionId: string;
      readonly name: string;
      readonly owner: string;
      readonly theirs: boolean;
      readonly published: boolean;
    }) => () => void)
    | null,
): StepSkills {
  if (!hasAgent || stepPath === undefined) return { kind: "hidden" };
  // No saved draft to read skills for (the read is switched off): nothing to show.
  if (read.isPending && read.fetchStatus === "idle") return { kind: "hidden" };
  if (read.isError) {
    return { kind: "failed", onRetry: () => void read.refetch() };
  }
  if (read.data === undefined) return { kind: "loading" };
  const here = read.data.items.filter((item) => item.stepPath === stepPath);
  // A skill the person removed is gone at once, a slot stays until it is dealt with.
  const rows: StepSkillRow[] = here
    .filter((item) =>
      item.skillVersionId === null || held.includes(item.skillVersionId)
    )
    .map((item, index) => ({
      key: `${item.stepPath}#${index}`,
      name: item.skillName,
      revision: item.revision,
      scope: item.scope,
      owner: item.ownerDisplayName,
      mine: item.mine,
      status: item.status,
      ...(removable === null || item.skillVersionId === null ||
          item.status !== "available"
        ? {}
        : {
          onRemove: removable({
            versionId: item.skillVersionId,
            name: item.skillName ?? "",
            owner: item.ownerDisplayName ?? "",
            theirs: item.scope === "personal" && !item.mine,
            published: item.publishedVersionUsesIt,
          }),
        }),
    }));
  // A skill just attached is not in the saved draft yet: it shows from the catalog.
  const shown = new Set(here.map((item) => item.skillVersionId));
  for (const id of held) {
    if (shown.has(id)) continue;
    const skill = catalog.find((one) => one.activeVersionId === id);
    if (skill === undefined) continue;
    rows.push({
      key: `${stepPath}#new-${id}`,
      name: skill.name,
      revision: skill.activeRevision,
      scope: skill.scope,
      owner: null,
      mine: skill.scope === "personal",
      status: "available",
      ...(removable === null ? {} : {
        onRemove: removable({
          versionId: id,
          name: skill.name,
          owner: "",
          theirs: false,
          published: false,
        }),
      }),
    });
  }
  return { kind: "ready", rows };
}

/** The name a card carries, for a problem row that names it. */
function stepName(
  step: TreeStep,
  translate: (key: never, values?: Record<string, string>) => string,
): string {
  if (step.problem === "unknown") {
    return translate("library.editor.card.unknown" as never);
  }
  if (step.problem === "unreadable") {
    return translate("library.editor.card.unreadable" as never);
  }
  const key = ACTION_TITLES[step.uses];
  return key === undefined ? step.uses : translate(key as never);
}
