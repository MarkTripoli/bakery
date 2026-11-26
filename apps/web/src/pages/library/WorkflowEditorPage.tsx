import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  allOrganizationMembersQueryOptions,
  attachableSkillsQueryOptions,
  effectiveAccessQueryOptions,
  organizationQueryOptions,
  repositoriesAllQueryOptions,
  workflowQueryOptions,
  workflowVersionSkillsQueryOptions,
  workflowVersionsQueryOptions,
} from "../../api/query.ts";
import type { WorkflowStart } from "@bakery/contracts/workflow-starts";
import {
  automaticStarts,
  type DraftStart,
  eventRepositoryId,
  inputLabel,
  sameStarts,
  savedStart,
  startNeeds,
  startProblems,
  startsOfVersion,
} from "./start-list.ts";
import { startCardOf } from "./start-card.ts";
import type { StartFocus } from "./StartPanel.tsx";
import { publishChanges } from "./publish-changes.ts";
import { PublishSummary } from "./PublishSummary.tsx";
import { useBakeryApi } from "../../api/context.tsx";
import {
  asyncKindForError,
  failureStatus,
  isConflictFailure,
} from "../../app/async-state.ts";

import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import { WORK_HOME } from "../../shell/breadcrumb-paths.ts";
import {
  type PanelTarget,
  type SkillChoice,
  type SlotReplaces,
  type StepAttach,
  StepPanel,
  type StepSkillRow,
  type StepSkills,
} from "./StepPanel.tsx";
import type { SkillResponse, WorkflowVersionSkills } from "../../api/client.ts";
import { WorkflowDiagram } from "./WorkflowDiagram.tsx";
import { DiagramViewSwitch, useDiagramView } from "./diagram-view.tsx";
import { versionSource } from "./copy-workflow.ts";
import {
  applyLoops,
  definitionOf,
  editorReducer,
  editorStateOf,
  type EditorStep,
  freeStepId,
  type LoopEdit,
  skillsOfNode,
} from "./editor-state.ts";
import { LeaveGuard } from "../repository-rules/leave-guard.tsx";
import {
  problemSentence,
  problemsOf,
  SKILL_PROBLEM_CODES,
  SKILL_PROBLEM_SENTENCE,
  stepProblemLine,
  unboundActionsOf,
  withoutUnboundAgent,
} from "./editor-validation.ts";
import {
  APPROVAL_ACTION,
  approvalOfNode,
  type ApprovalPerson,
  type ApprovalProblem,
  approvalProblems,
  askedWho,
  NEW_APPROVAL,
} from "./approval-step.ts";
import { stepName } from "./workflow-state.ts";
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
  readonly field?: ApprovalProblem["field"] | "start";
  readonly start?: Omit<StartFocus, "request">;
  readonly blocking?: boolean;
  /** The step or group's name; empty for a problem that has no place in the drawing. */
  readonly name: string;
  readonly sentence: string;
  readonly stepId: string | null;
};

function approvalPart(uses: string, node: Record<string, unknown>) {
  const approval = uses === APPROVAL_ACTION ? approvalOfNode(node) : null;
  return approval === null ? {} : { approval };
}

function repeatCap(spec: Readonly<Record<string, unknown>> | null): number {
  const limits = record(spec?.limits);
  const own = limits.maxRepairCycles;
  return typeof own === "number" && Number.isInteger(own) && own >= 1 &&
      own < 8
    ? own
    : 8;
}

const GROUP_LABEL: Readonly<Record<GroupLabel, string>> = {
  yes: "library.editor.group.yes",
  otherwise: "library.editor.group.otherwise",
  together: "library.editor.group.together",
  repeat: "library.editor.group.repeat",
  fix: "library.editor.group.fixUntilPasses",
  each: "library.editor.group.each",
  call: "library.editor.group.call",
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

const START_ID = "start";

class ActivationFailed extends Error {
  constructor(readonly versionId: string, readonly revision: number) {
    super("ACTIVATION_FAILED");
  }
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
  const [diagramView, setDiagramView] = useDiagramView();
  const phone = useShellViewport() === "phone";

  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );

  // The version being edited is the workflow's draft when there is one, else
  // the version in use, else the newest version.
  const [publishedOnly, setPublishedOnly] = useState<string | null>(null);
  const draft = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.status === "draft") ??
      items.find((item) => item.id === publishedOnly) ??
      items.find((item) => item.id === workflow.data?.activeVersionId) ??
      items[0] ??
      null;
  }, [versions.data, workflow.data, publishedOnly]);

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
        ...approvalPart(uses, step),
      }];
    });
  }, [draft]);

  const versionStarts = useMemo(
    () => startsOfVersion(draft?.starts),
    [draft],
  );
  const savedStarts = useRef<readonly WorkflowStart[]>([]);
  const sentStarts = useRef<readonly WorkflowStart[]>([]);

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
    {
      readonly stepId: string;
      readonly choice: SkillChoice;
      readonly replaces?: SlotReplaces;
    } | null
  >(null);
  const [removingOther, setRemovingOther] = useState<
    {
      readonly stepId: string;
      readonly versionId: string;
      readonly name: string;
      readonly owner: string;
      /** Whether a published version of the workflow still uses the skill. */
      readonly published: boolean;
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
  const [publishAfterSave, setPublishAfterSave] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  // The step just deleted, by name, while its Undo is offered.
  const [deleted, setDeleted] = useState<string | null>(null);
  // null until the version being edited is known: an unknown baseline is not a
  // change, so the leave warning is never armed on a page nobody has touched.
  const lastSaved = useRef<string | null>(null);
  // The version the last save returned: a second edit made while the draft is
  // still being read again must send this one, not the one it last read.
  const savedVersion = useRef<
    { id: string; version: number; digest: string } | null
  >(null);
  // The slots the last write sent, so only those are cleared when it lands.
  const sentSlots = useRef<string[]>([]);
  const sentLoops = useRef<readonly LoopEdit[]>([]);
  const [loopPending, setLoopPending] = useState(false);
  // Slots the person settled (by choosing a skill or removing the placeholder) and the
  // draft has not saved yet: the save tells the server, and the row is gone at once.
  const [resolving, setResolving] = useState<ReadonlySet<string>>(new Set());

  const editedRef = useRef("");
  const resetFor = useRef<string | undefined>(undefined);
  const openedFrom = useRef<string | null>(null);
  const writeTarget = () => {
    if (draft === null) return null;
    const saved = savedVersion.current;
    if (draft.status !== "draft") {
      return openedFrom.current === draft.id ? saved : null;
    }
    return saved?.id === draft.id && saved.version > draft.version
      ? saved
      : { id: draft.id, version: draft.version, digest: draft.digest };
  };
  const openDraft = async () => {
    if (draft === null) throw new Error("no draft version");
    const created = await api.createWorkflowVersion({
      organizationId: scope.organizationId as string,
      workflowId,
      input: {
        definition: draft.normalizedSpec,
        ...(confirmed.current.size === 0 ? {} : {
          confirmPersonalSkillUse: [...confirmed.current].slice(0, 32),
        }),
      },
      idempotencyKey: crypto.randomUUID(),
    });
    if (!created.ok) throw created.error;
    const opened = {
      id: created.data.id,
      version: created.data.version,
      digest: created.data.digest,
    };
    openedFrom.current = draft.id;
    resetFor.current = created.data.id;
    savedVersion.current = opened;
    return opened;
  };
  useEffect(() => {
    const unsavedHere = resetFor.current === draft?.id &&
      lastSaved.current !== null && editedRef.current !== lastSaved.current;
    const ownEcho = draft !== null && resetFor.current === draft.id &&
      savedVersion.current?.id === draft.id &&
      draft.version <= savedVersion.current.version;
    if (unsavedHere || ownEcho) return;
    resetFor.current = draft?.id;
    dispatch({ kind: "reset", steps: versionSteps, starts: versionStarts });
    savedStarts.current = versionStarts;
    lastSaved.current = JSON.stringify({
      steps: versionSteps,
      loops: [],
      starts: versionStarts,
    });
    setSaveState({ kind: "saved" });
  }, [draft?.id, versionSteps, versionStarts]);

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
      sentLoops.current = editor.loops;
      const target = writeTarget() ?? await openDraft();
      const result = await api.updateWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: target.id,
        version: target.version,
        input: {
          definition: definitionOf(
            record(draft.normalizedSpec),
            steps,
            editor.loops,
          ) as never,
          ...(() => {
            sentStarts.current = editor.starts;
            return savedStarts.current.length === 0 &&
                editor.starts.length === 0
              ? {}
              : { starts: editor.starts.map(savedStart) };
          })(),
          // Slots the person settled, so the server drops their placeholders with this save.
          ...(() => {
            sentSlots.current = [...resolving];
            return sentSlots.current.length === 0
              ? {}
              : { resolveSkillSlots: sentSlots.current };
          })(),
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
      savedVersion.current = {
        id: target.id,
        version: result.data.version,
        digest: result.data.digest,
      };
      return result.data;
    },
    onMutate: () => setSaveState({ kind: "saving" }),
    onSuccess: (_saved, written) => {
      // What was written is what is saved: an edit made meanwhile is still to save.
      savedStarts.current = sentStarts.current;
      lastSaved.current = JSON.stringify({
        steps: written,
        loops: sentLoops.current,
        starts: sentStarts.current,
      });
      // The slots this save settled are done; one settled meanwhile is still to save.
      setResolving((previous) =>
        new Set(
          [...previous].filter((path) => !sentSlots.current.includes(path)),
        )
      );
      setSaveState({ kind: "saved" });
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
    onError: () => {
      setSaveState({ kind: "failed" });
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
  });

  // Publishing the draft, and optionally making it the version in use: two
  // forms of one action, decided by the button the person presses.
  const publish = useMutation({
    mutationKey: ["workflowVersions.publish"],
    mutationFn: async (alsoUse: boolean) => {
      const latest = writeTarget();
      let versionId = draft?.id ?? "";
      let revision = draft?.revision ?? 0;
      if (latest !== null) {
        const published = await api.publishWorkflowVersion({
          organizationId: scope.organizationId as string,
          workflowId,
          versionId: latest.id,
          version: latest.version,
          expectedDigest: latest.digest,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!published.ok) throw published.error;
        versionId = published.data.id;
        revision = published.data.revision;
        if (!alsoUse) return versionId;
      }
      if (!alsoUse || versionId === "") throw new Error("no draft version");
      const used = await api.activateWorkflowVersion({
        organizationId: scope.organizationId as string,
        id: workflowId,
        versionId,
        version: workflow.data?.version ?? 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!used.ok) throw new ActivationFailed(versionId, revision);
      return versionId;
    },
    onError: (error) => {
      if (error instanceof ActivationFailed) {
        setPublishedOnly(error.versionId);
      }
      if (error instanceof ActivationFailed || isConflictFailure(error)) {
        void queryClient.invalidateQueries({ queryKey: ["protected"] });
      }
    },
    onSuccess: async (versionId, alsoUse) => {
      setPublishedOnly(alsoUse ? null : versionId);
      await queryClient.invalidateQueries({ queryKey: ["protected"] });
      setPublishOpen(false);
    },
  });

  const steps = editor.steps;
  const inUseStarts = useMemo(
    () => startsOfVersion(inUse?.starts),
    [inUse],
  );
  const publishedUnused = draft !== null && draft.status === "published" &&
    draft.id !== workflow.data?.activeVersionId && writeTarget() === null;
  const publishRevision = draft?.status === "draft" ? draft.revision : Math.max(
    0,
    ...(versions.data?.items ?? []).map((item) => item.revision),
  ) + 1;
  const changes = useMemo(
    () =>
      publishChanges(
        inUse?.normalizedSpec,
        draft === null
          ? null
          : definitionOf(record(draft.normalizedSpec), steps, editor.loops),
        (key) => translate(key),
      ),
    [inUse, draft, steps, editor.loops, translate],
  );
  const startsChanged = !sameStarts(editor.starts, inUseStarts);
  const draftDiffers = draft !== null &&
    (publishedUnused || changes.differs || startsChanged);

  // The drawing comes from the definition itself, so nothing in it is left out:
  // groups, steps only changeable in code, and steps Bakery cannot read all keep
  // their place. A definition that is a straight line of actions is drawn from
  // the editor's own list, so an add, move or remove shows at once.
  const rawSpec = useMemo(
    () =>
      draft === null
        ? null
        : applyLoops(record(draft.normalizedSpec), editor.loops),
    [draft, editor.loops],
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
    /** Steps whose only problems are skills needing a choice: their Skills section says it. */
    readonly skillOnly: ReadonlySet<string>;
    /** Problems that name a step the page does not draw, so no card can hold them. */
    readonly unmapped: readonly string[];
    readonly workflow: readonly string[];
    readonly unboundActions: ReadonlySet<string>;
  }>({
    byStep: new Map(),
    skillOnly: new Set(),
    unmapped: [],
    workflow: [],
    unboundActions: new Set(),
  });
  const check = useMutation({
    mutationKey: ["workflows.validate"],
    mutationFn: async (held: readonly EditorStep[]) => {
      const definition = definitionOf(
        draft === null ? null : record(draft.normalizedSpec),
        held,
        editor.loops,
      );
      const result = await api.validateWorkflow({
        organizationId: scope.organizationId as string,
        input: { definition: definition as never },
      });
      if (!result.ok) throw result.error;
      return { report: result.data, definition };
    },
    onSuccess: ({ report, definition }, held) => {
      const found = [...(report.errors ?? []), ...(report.warnings ?? [])];
      const sorted = problemsOf(withoutUnboundAgent(found));
      const byStep = new Map<string, string>();
      const skillOnly = new Set<string>();
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
        if (found.every((problem) => SKILL_PROBLEM_CODES.has(problem.code))) {
          skillOnly.add(step.id);
        }
      }
      setChecker({
        byStep,
        skillOnly,
        unmapped,
        // The workflow's own problems are sentences too, never the server's
        // message (ruling 6900485736 section 3).
        workflow: sorted.workflow.map((problem) =>
          problemSentence(problem.code)
        ),
        unboundActions: unboundActionsOf(found, definition),
      });
    },
  });

  useEffect(() => {
    if (steps.length === 0) {
      setChecker({
        byStep: new Map(),
        skillOnly: new Set(),
        unmapped: [],
        workflow: [],
        unboundActions: new Set(),
      });
      return;
    }
    const timer = setTimeout(() => check.mutate(steps), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [steps, editor.loops]);

  const edited = JSON.stringify({
    steps,
    loops: editor.loops,
    starts: editor.starts,
  });
  editedRef.current = edited;
  const changed = lastSaved.current !== null &&
    (edited !== lastSaved.current || resolving.size > 0);

  // A change saves itself once the person stops typing; a failed save waits for
  // "Try again" rather than looping.
  useEffect(() => {
    if (!canManage || draft === null || saveState.kind === "failed") return;
    // One write at a time: the next waits for this one, then saves what changed since.
    if (!changed || save.isPending) return;
    const timer = setTimeout(
      () => save.mutate(steps),
      publishAfterSave ? 0 : SAVE_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [
    publishAfterSave,
    changed,
    steps,
    editor.loops,
    canManage,
    draft,
    saveState.kind,
    save.isPending,
    resolving,
  ]);

  useEffect(() => {
    if (!publishAfterSave) return;
    if (saveState.kind === "failed") {
      setPublishAfterSave(false);
      globalThis.document.querySelector<HTMLElement>("[data-retry-save]")
        ?.focus();
      return;
    }
    if (saveState.kind === "saved" && !changed && !save.isPending) {
      setPublishAfterSave(false);
      setPublishOpen(true);
    }
  }, [publishAfterSave, saveState.kind, changed, save.isPending]);

  const badBudget = editor.starts.some((start: DraftStart) =>
    start.budgetTyped !== undefined
  );

  useEffect(() => {
    if (saveState.kind === "saved" && !changed && !loopPending && !badBudget) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [saveState.kind, changed, loopPending, badBudget]);

  const unsaved = changed || loopPending || save.isPending ||
      saveState.kind !== "saved" || badBudget
    ? 1
    : 0;

  const shownSave: SaveState = forcedSaveState() ?? saveState;
  const stateWord = shownSave.kind === "saving"
    ? translate("library.editor.save.saving" as never)
    : shownSave.kind === "failed"
    ? translate("library.editor.save.failed" as never)
    : translate("library.editor.save.saved" as never);

  // A skill that needs a choice makes its step need setup too. The server names a slot only
  // when the draft is published, so the open rows the page already reads count here (#431).
  const skillProblemSteps = useMemo<ReadonlySet<string>>(() => {
    const open = new Set<string>();
    const items = skillsRead.data?.items ?? [];
    for (const [id, path] of stepPaths) {
      const held = new Set(editor.steps.find((step) => step.id === id)?.skills);
      if (
        items.some((item) =>
          item.stepPath === path && item.status !== "available" &&
          (item.skillVersionId === null
            ? !resolving.has(item.stepPath)
            : held.has(item.skillVersionId))
        )
      ) open.add(id);
    }
    return open;
  }, [skillsRead.data, stepPaths, editor.steps, resolving]);
  const asks = steps.some((step) => step.approval !== undefined);
  const members = useQuery({
    ...allOrganizationMembersQueryOptions(api, scope),
    enabled: asks && scope.organizationId !== null,
  });
  const organization = useQuery({
    ...organizationQueryOptions(api, scope),
    enabled: asks && scope.organizationId !== null,
  });
  const people = useMemo<readonly ApprovalPerson[]>(
    () =>
      (members.data?.items ?? []).map((member) => ({
        principalId: member.principalId,
        displayName: member.displayName,
        active: member.status === "active",
      })),
    [members.data],
  );
  const everyone = members.data !== undefined && !members.data.nextCursor
    ? people
    : null;
  const approvalIssues = useMemo(() => {
    const found = new Map<
      string,
      readonly (ApprovalProblem & { readonly sentence: string })[]
    >();
    for (const step of steps) {
      if (step.approval === undefined) continue;
      const issues = approvalProblems(step.approval, everyone).map(
        (problem) => ({
          ...problem,
          sentence: translate(
            `library.editor.ask.problem.${
              problem.kind === "notMember" && problem.name === ""
                ? "unknownMember"
                : problem.kind
            }` as never,
            {
              name: problem.name,
              organization: organization.data?.name ?? "",
            } as never,
          ),
        }),
      );
      if (issues.length > 0) found.set(step.id, issues);
    }
    return found;
  }, [steps, everyone, organization.data?.name, translate]);
  const cardLines = useMemo<ReadonlyMap<string, string>>(() => {
    const lines = new Map<string, string>();
    for (const step of steps) {
      if (step.approval === undefined) continue;
      const who = askedWho(
        step.approval.audience,
        members.data ? people : null,
      );
      const named = who.kind === "one" ? who.name : translate(
        `library.editor.ask.card.${who.kind}` as never,
        who as never,
      );
      lines.set(
        step.id,
        translate("library.editor.ask.card.line" as never, {
          who: named,
        } as never),
      );
    }
    return lines;
  }, [steps, people, members.data, translate]);
  const needs = useMemo(
    () => startNeeds(draft?.normalizedSpec),
    [draft],
  );
  const repositories = useQuery({
    ...repositoriesAllQueryOptions(api, scope),
    enabled: scope.organizationId !== null && editor.starts.length > 0,
  });
  const startIssues = useMemo(
    () =>
      startProblems(editor.starts, needs).map((problem) => ({
        ...problem,
        sentence: translate(
          `library.editor.start.problem.row.${problem.kind}`,
          { number: problem.number, name: inputLabel(problem.name) },
        ),
        target: {
          startId: problem.startId,
          kind: problem.kind,
          name: problem.name,
        },
      })),
    [editor.starts, needs, translate],
  );
  const automatic = automaticStarts(editor.starts);
  const startCard = startCardOf(editor.starts, translate);
  const problemsByStep = useMemo<ReadonlyMap<string, string>>(() => {
    const merged = new Map(checker.byStep);
    for (const [id, issues] of approvalIssues) {
      merged.set(id, issues[0].sentence);
    }
    for (const id of skillProblemSteps) {
      if (!merged.has(id)) merged.set(id, SKILL_PROBLEM_SENTENCE);
    }
    if (startIssues.length > 0) merged.set(START_ID, startIssues[0].sentence);
    return merged;
  }, [checker.byStep, approvalIssues, skillProblemSteps, startIssues]);
  // Steps whose only problem is a skill: the Skills section carries it, not a notice above it.
  const skillOnlySteps = useMemo<ReadonlySet<string>>(() => {
    const only = new Set(checker.skillOnly);
    for (const id of skillProblemSteps) {
      if (!checker.byStep.has(id)) only.add(id);
    }
    return only;
  }, [checker.byStep, checker.skillOnly, skillProblemSteps]);
  // Every problem, in the order the page shows them: a card that needs setup
  // first (one problem each), then a definition whose steps cannot be read,
  // then whatever the checker found that those do not already count.
  const rows = useMemo<readonly ProblemRow[]>(() => {
    const out: ProblemRow[] = startIssues.map((issue) => ({
      key: `start-${issue.startId}-${issue.name}`,
      name: translate("library.editor.start.title"),
      sentence: issue.sentence,
      stepId: START_ID,
      field: "start" as const,
      start: issue.target,
      blocking: true,
    }));
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
    for (const step of drawn) {
      for (const issue of approvalIssues.get(step.id) ?? []) {
        out.push({
          key: `ask-${step.id}-${issue.field}-${issue.name}`,
          name: stepName(step, translate),
          sentence: issue.sentence,
          stepId: step.id,
          field: issue.field,
          blocking: true,
        });
      }
    }
    for (const [id, sentence] of problemsByStep) {
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
  }, [tree, checker, problemsByStep, approvalIssues, startIssues, translate]);
  const blocked = rows.some((row) => row.blocking === true);
  const [focusRequest, setFocusRequest] = useState<
    {
      readonly stepId: string;
      readonly field: NonNullable<ProblemRow["field"]>;
      readonly request: number;
      readonly start: StartFocus | null;
    } | null
  >(null);

  const problemCount = rows.length;
  const newerUnused = inUse === null ? undefined : (versions.data?.items ?? [])
    .filter((item) =>
      item.status === "published" && item.revision > inUse.revision
    )
    .sort((a, b) => b.revision - a.revision)[0];
  const unusedRevision = publishedUnused
    ? draft.revision
    : draftDiffers
    ? undefined
    : newerUnused?.revision;
  const cleanWord = unusedRevision !== undefined
    ? translate("library.editor.publishedUnused", { version: unusedRevision })
    : draftDiffers
    ? translate("library.editor.ready" as never)
    : translate("library.editor.noChanges");
  const problemWord = problemCount === 0
    ? cleanWord
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
  const resolve = (stepPath: string) =>
    setResolving((previous) => new Set(previous).add(stepPath));
  const attachNow = (
    stepId: string,
    choice: SkillChoice,
    replaces?: SlotReplaces,
  ) => {
    const step = editor.steps.find((held) => held.id === stepId);
    if (step === undefined || step.skills.includes(choice.value)) return;
    if (choice.group === "private") confirmed.current.add(choice.value);
    // A choice takes the place of the skill the slot named, when it named one.
    const kept = replaces?.versionId == null
      ? step.skills
      : step.skills.filter((id) => id !== replaces.versionId);
    // Only a slot that names no skill is settled by path: the server keeps one such slot
    // per step. A row that names a version is settled by taking that version out of the step.
    if (replaces !== undefined && replaces.versionId === null) {
      resolve(replaces.stepPath);
    }
    dispatch({
      kind: "skills",
      id: stepId,
      skills: [...kept, choice.value],
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
    if (selectedId === START_ID) {
      return {
        kind: "start",
        starts: {
          starts: editor.starts,
          needs,
          problems: startIssues,
          repositories: {
            state: repositories.data !== undefined
              ? "ready"
              : repositories.isError
              ? "failed"
              : "loading",
            list: (repositories.data ?? []).map((one) => ({
              id: one.id,
              name: `${one.owner}/${one.name}`,
              eventRepositoryId: eventRepositoryId(one.providerRepoId),
            })),
            onRetry: () => void repositories.refetch(),
          },
          onChange: canManage
            ? (starts, typing) => {
              const removed = editor.starts.findIndex((one) =>
                !starts.some((kept) => kept.id === one.id)
              );
              dispatch({
                kind: "starts",
                starts,
                ...(typing === undefined ? {} : { typing }),
              });
              if (removed >= 0) {
                setDeleted(
                  translate("library.editor.start.heading", {
                    number: removed + 1,
                  }),
                );
              }
            }
            : undefined,
          focus: focusRequest?.stepId === START_ID ? focusRequest.start : null,
        },
      };
    }
    const group = groupsOfTree(tree).find((held) => held.id === selectedId);
    if (group !== undefined) {
      if (group.loop !== undefined) {
        const loop = group.loop;
        return {
          kind: "loop",
          at: loop.path.join("/"),
          name: translate(GROUP_LABEL[group.label] as never),
          fix: loop.fix,
          values: { min: loop.min, max: loop.max, allow: loop.allow },
          cap: repeatCap(rawSpec),
          ...(loop.fix
            ? { help: translate("library.editor.group.fixHelpShort" as never) }
            : {}),
          onCommit: (values) => {
            dispatch({ kind: "loop", path: loop.path, ...values });
          },
          onPending: setLoopPending,
        };
      }
      return {
        kind: "codeOnly",
        name: translate(GROUP_LABEL[group.label] as never),
        problem: undefined,
        ...(group.label === "each"
          ? { help: translate("library.editor.group.eachHelp" as never) }
          : group.max === undefined
          ? {}
          : { help: translate("library.editor.group.fixHelp" as never) }),
      };
    }
    // The Skills section a step's panel draws: its rows and the picker that attaches one.
    const skillsFor = (
      live: (typeof steps)[number] | undefined,
      step: TreeStep,
    ): { skills: StepSkills; attach: StepAttach | null } => ({
      skills: skillsOf(
        live?.agentVersionId != null,
        stepPaths.get(step.id),
        skillsRead,
        live?.skills ?? [],
        catalog.data ?? [],
        editable
          ? (row) => () => {
            // Someone else's private skill asks first: only its owner can attach it again.
            if (row.status !== "available") {
              // A slot: a missing skill is gone at once (the save drops the
              // placeholder); the others remove like any skill, with Undo.
              if (row.versionId === null) {
                resolve(row.stepPath);
                setSkillToast({
                  text: say("slot.removed", {
                    step: stepName(step, translate),
                  }),
                });
              } else {
                removeNow(step.id, row.versionId, row.name, row.published);
              }
              return;
            }
            if (row.versionId === null) return;
            if (row.theirs) {
              setRemovingOther({
                stepId: step.id,
                versionId: row.versionId,
                name: row.name,
                owner: row.owner,
                published: row.published,
              });
            } else {
              removeNow(step.id, row.versionId, row.name, row.published);
            }
          }
          : null,
        resolving,
      ),
      attach: editable && live?.agentVersionId != null
        ? {
          state: catalog.isError
            ? "failed"
            : catalog.isPending
            ? "loading"
            : "ready",
          offered: (catalog.data ?? []).length,
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
          canChoose: (value: string) =>
            (catalog.data ?? []).some((skill) =>
              skill.activeVersionId === value
            ),
          onChoose: (value: string, replaces?: SlotReplaces) => {
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
              setAttaching({ stepId: step.id, choice, replaces });
            } else attachNow(step.id, choice, replaces);
          },
        }
        : null,
    });

    const step = stepsOfTree(tree).find((held) => held.id === selectedId);
    if (step === undefined) return null;
    if (step.codeOnly === true) {
      return {
        kind: "codeOnly",
        name: stepName(step, translate),
        problem: skillOnlySteps.has(step.id)
          ? undefined
          : problemsByStep.get(step.id),
        agentFromSetup: checker.unboundActions.has(step.uses),
        // A skill is not part of the code a person cannot edit here: an agent step
        // written in code still shows its Skills section (design-ux, #431).
        ...skillsFor(steps.find((held) => held.id === selectedId), step),
      };
    }
    const live = steps.find((held) => held.id === selectedId);
    const index = live === undefined ? -1 : steps.indexOf(live);
    const issues = approvalIssues.get(step.id) ?? [];
    const approval = live?.approval === undefined ? undefined : {
      stepId: live.id,
      fields: live.approval,
      onChange: editable
        ? (fields: NonNullable<EditorStep["approval"]>, typing?: string) =>
          dispatch({
            kind: "approval",
            id: live.id,
            approval: fields,
            ...(typing === undefined ? {} : { typing }),
          })
        : undefined,
      people: {
        state: members.isError
          ? "failed" as const
          : members.data === undefined
          ? "loading" as const
          : "ready" as const,
        list: people,
        onRetry: () => void members.refetch(),
      },
      promptProblem: issues.find((issue) => issue.field === "prompt")?.sentence,
      audienceProblems: issues.filter((issue) => issue.field === "audience")
        .map((issue) => issue.sentence),
      focus: focusRequest?.stepId === live.id &&
          focusRequest.field !== "start"
        ? { field: focusRequest.field, request: focusRequest.request }
        : null,
    };
    return {
      kind: "step",
      name: stepName(step, translate),
      deletable: editable,
      uses: step.uses,
      approval,
      agentFromSetup: checker.unboundActions.has(step.uses),
      code: step.code,
      problem: step.problem === undefined
        ? undefined
        : step.problem === "unknown"
        ? translate("library.editor.problem.unknown" as never)
        : translate("library.editor.problem.unreadable" as never),
      ...skillsFor(live, step),
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
    resolving,
    problemsByStep,
    skillOnlySteps,
    checker.unboundActions,
    approvalIssues,
    people,
    members.status,
    focusRequest,
    editor.starts,
    needs,
    startIssues,
    repositories.data,
    repositories.isError,
    canManage,
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
                    setPublishOpen(false);
                    setSelectedId(row.stepId);
                    if (row.field !== undefined && row.stepId !== null) {
                      const request = Date.now();
                      setFocusRequest({
                        stepId: row.stepId,
                        field: row.field,
                        request,
                        start: row.start === undefined
                          ? null
                          : { ...row.start, request },
                      });
                    }
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

  const showsSteps = !forbidden && !missing && !offline && !loading &&
    draft !== null;
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
            problems={problemsByStep}
            lines={cardLines}
            {...(startCard === undefined ? {} : { start: startCard })}
            canManage={canManage}
            editable={editable}
            onAdd={(afterId) => setPickerAfter(afterId)}
            onSelect={setSelectedId}
            onViewAsCode={() => setCodeOpen(true)}
            pickerAt={pickerAfter}
            onPick={(uses) => {
              const afterId = pickerAfter ?? null;
              const id = freeStepId(editor, uses);
              const step = {
                id,
                uses,
                agentVersionId: null,
                skills: [],
                ...(uses === APPROVAL_ACTION ? { approval: NEW_APPROVAL } : {}),
              };
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
            view={diagramView}
          />
        </UI.Stack>
        {panelTarget === null ? null : (
          <StepPanel
            target={panelTarget}
            onViewAsCode={phone ? null : () => setCodeOpen(true)}
          />
        )}
      </UI.Inline>
    );

  const editing = canManage && draft !== null;
  const tryAgain = (variant: "secondary" | "quiet") => (
    shownSave.kind === "failed"
      ? (
        <UI.Button
          data-retry-save="true"
          variant={variant}
          onClick={() => save.mutate(steps)}
        >
          {translate("library.editor.save.tryAgain" as never)}
        </UI.Button>
      )
      : null
  );
  const notSaved = shownSave.kind === "failed";
  const problems = problemCount === 0
    ? notSaved ? null : (
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
    );
  const viewAsCodeButton = (
    <UI.Button
      variant="secondary"
      onClick={() => setCodeOpen(true)}
    >
      {translate("library.editor.viewAsCode" as never)}
    </UI.Button>
  );
  const pressPublish = () => {
    if (notSaved) {
      setSaveState({ kind: "saving" });
      setPublishAfterSave(true);
      save.mutate(steps);
      return;
    }
    if (changed || save.isPending || shownSave.kind === "saving") {
      setPublishAfterSave(true);
    } else setPublishOpen(true);
    publish.reset();
  };
  const publishButton = (
    <UI.Button
      loading={publishAfterSave}
      onClick={pressPublish}
      variant="primary"
    >
      {translate("library.editor.publish" as never)}
    </UI.Button>
  );

  return (
    <>
      {editing && !phone
        ? (
          <ShellSlot name="actions">
            <UI.Inline gap="compact">
              {tryAgain("secondary")}
              <UI.Text variant="muted" role="status">
                {stateWord}
              </UI.Text>
              {problems}
              {panelTarget === null ? viewAsCodeButton : null}
              {publishButton}
            </UI.Inline>
          </ShellSlot>
        )
        : null}
      {
        /* `list` rather than `split`: the subtitle is a stack of sentences, and
          `split` nests it in a paragraph, which a stack cannot live inside. */
      }
      <UI.PageHeader
        aside={showsSteps && !phone
          ? (
            <div data-ui-region="workflow-view-switch">
              <DiagramViewSwitch onChange={setDiagramView} view={diagramView} />
            </div>
          )
          : undefined}
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
            {editing && phone
              ? (
                <UI.Inline gap="compact">
                  <UI.Text variant="muted" role="status">
                    {stateWord}
                  </UI.Text>
                  {tryAgain("quiet")}
                  {problems}
                </UI.Inline>
              )
              : null}
          </UI.Stack>
        }
        actions={editing && phone
          ? (
            <>
              {viewAsCodeButton}
              {publishButton}
            </>
          )
          : null}
        actionsLayout="row"
      />
      {breadcrumbs}
      <LeaveGuard
        count={unsaved}
        copy={{
          title: "library.editor.leave.title",
          body: "library.editor.leave.body",
          stay: "library.editor.leave.stay",
          confirm: "library.editor.leave.confirm",
        }}
        discard={() => {}}
        path={`/library/workflows/${workflowId}/edit`}
      />
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
                attachNow(
                  attaching.stepId,
                  attaching.choice,
                  attaching.replaces,
                );
                setAttaching(null);
              }}
            >
              {say("confirm.action", {})}
            </UI.Button>
          }
        >
          <UI.Stack gap="compact">
            <UI.Text>
              {
                /* The workflow and the skill are named in bold, wherever the sentence puts them. */
              }
              {say("confirm.lead", {
                workflow: "%%workflow%%",
                skill: "%%skill%%",
                version: String(attaching.choice.revision),
              }).split(/(%%workflow%%|%%skill%%)/).map((part, index) =>
                part === "%%workflow%%" || part === "%%skill%%"
                  ? (
                    <strong key={index}>
                      {part === "%%workflow%%"
                        ? workflow.data?.name ?? ""
                        : attaching.choice.name}
                    </strong>
                  )
                  : part
              )}
            </UI.Text>
            {/* A real bulleted list, so a screen reader announces the count. */}
            <ul aria-label={say("confirm.listLabel", {})}>
              <li>{say("confirm.see", {})}</li>
              <li>{say("confirm.files", {})}</li>
              <li>{say("confirm.quote", {})}</li>
              <li>
                {say("confirm.version", {
                  version: String(attaching.choice.revision),
                })}
              </li>
            </ul>
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
                  removingOther.published,
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
            title={publishedUnused
              ? translate("library.editor.publish.useTitle", {
                version: String(draft.revision),
              })
              : draftDiffers
              ? translate("library.editor.publish.title", {
                version: String(publishRevision),
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
            confirmAction={draftDiffers && !blocked
              ? (
                <UI.Inline gap="compact">
                  {publishedUnused ? null : (
                    <UI.Button
                      variant="secondary"
                      disabled={publish.isPending}
                      loading={publish.isPending}
                      onClick={() => publish.mutate(false)}
                    >
                      {translate("library.editor.publish.only")}
                    </UI.Button>
                  )}
                  <UI.Button
                    variant="primary"
                    disabled={publish.isPending}
                    onClick={() => publish.mutate(true)}
                  >
                    {publishedUnused
                      ? translate("library.workflow.versions.use")
                      : translate("library.editor.publish.andUse")}
                  </UI.Button>
                </UI.Inline>
              )
              : undefined}
          >
            {draftDiffers
              ? (
                <UI.Stack gap="tight">
                  <UI.Text>
                    {blocked
                      ? translate("library.editor.publish.blocked")
                      : publish.error instanceof ActivationFailed
                      ? null
                      : publishedUnused
                      ? translate("library.editor.publish.useBody", {
                        version: String(draft.revision),
                      })
                      : translate("library.editor.publish.body")}
                  </UI.Text>
                  <UI.Text variant="muted">
                    {translate("library.workflow.steps.never" as never)}
                  </UI.Text>
                  {blocked || automatic === 0 ? null : (
                    <UI.Text>
                      {translate(
                        publishedUnused
                          ? "library.editor.start.useNote"
                          : "library.editor.start.publishNote",
                        { count: automatic },
                      )}
                    </UI.Text>
                  )}
                  <PublishSummary
                    blocked={blocked}
                    changes={changes}
                    inUseRevision={inUse?.revision ?? null}
                    problemCount={problemCount}
                    startsChanged={startsChanged}
                  />
                  {publish.error === null
                    ? null
                    : (
                      <UI.InlineNotice tone="error" role="alert">
                        {publish.error instanceof ActivationFailed
                          ? translate(
                            "library.editor.publish.notUsed",
                            {
                              version: String(publish.error.revision),
                            },
                          )
                          : translate(
                            isConflictFailure(publish.error)
                              ? "library.editor.publish.stale"
                              : "library.editor.publish.failed",
                          )}
                      </UI.InlineNotice>
                    )}
                  {problemCount === 0 ? null : problemList}
                </UI.Stack>
              )
              : (
                <UI.Text>
                  {translate("library.editor.publish.nothingBody")}
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
      /** Null for a slot that names no skill at all. */
      readonly versionId: string | null;
      readonly stepPath: string;
      readonly status: StepSkillRow["status"];
      readonly name: string;
      readonly owner: string;
      readonly theirs: boolean;
      readonly published: boolean;
    }) => () => void)
    | null,
  /** Steps whose open slots the person has settled and the draft has not saved yet. */
  resolving: ReadonlySet<string>,
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
      item.skillVersionId === null
        ? !resolving.has(item.stepPath)
        : held.includes(item.skillVersionId)
    )
    .map((item, index) => ({
      key: `${item.stepPath}#${index}`,
      name: item.skillName,
      revision: item.revision,
      scope: item.scope,
      owner: item.ownerDisplayName,
      mine: item.mine,
      status: item.status,
      stepPath: item.stepPath,
      versionId: item.skillVersionId,
      ...(removable === null ? {} : {
        onRemove: removable({
          versionId: item.skillVersionId,
          stepPath: item.stepPath,
          status: item.status,
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
          stepPath,
          status: "available",
          name: skill.name,
          owner: "",
          theirs: false,
          published: false,
        }),
      }),
    });
  }
  // The rows that need a choice come first, then the skills that work.
  rows.sort((a, b) =>
    Number(a.status === "available") - Number(b.status === "available")
  );
  return { kind: "ready", rows };
}
