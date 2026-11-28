import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  allOrganizationMembersQueryOptions,
  attachableSkillsQueryOptions,
  effectiveAccessQueryOptions,
  groupsQueryOptions,
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
import { DraftKeptNotice } from "./DraftKeptNotice.tsx";
import { rewriteDraft } from "./leftover-draft.ts";
import { PublishSummary } from "./PublishSummary.tsx";
import {
  EditorToast,
  type PublishedNotice,
  useEditorNotice,
} from "./EditorToast.tsx";
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
import type {
  SkillResponse,
  WorkflowVersionResponse,
  WorkflowVersionSkills,
} from "../../api/client.ts";
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
  groupStartsOf,
  isPlainGroup,
  type LoopEdit,
  nodeIds,
  skillsOfNode,
} from "./editor-state.ts";
import { LeaveGuard } from "../repository-rules/leave-guard.tsx";
import { useConnectivity } from "../../app/connectivity.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { authoredYaml } from "./authored-yaml.ts";
import { readableSource } from "./readable-source.ts";
import { useStepKeys } from "./use-step-keys.ts";
import { useEscapeClosesPanel } from "./use-escape-closes-panel.ts";
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
import {
  documentKey,
  documentsBefore,
  NEW_NOTIFY,
  NOTIFY_ACTION,
  type NotifyNext,
  notifyOfNode,
  type NotifyProblem,
  notifyProblems,
  type NotifyWarning,
  notifyWarnings,
} from "./notify-step.ts";
import {
  type ListStates,
  notifyCardLine,
  notifyChoices,
  whoName,
} from "./notify-copy.ts";
import {
  isTaskField,
  NEW_TASK,
  TASK_ACTION,
  taskOfNode,
  type TaskProblem,
  taskProblems,
} from "./task-step.ts";
import { ACTION_TITLES, stepName } from "./workflow-state.ts";
import {
  type GroupLabel,
  groupsOfTree,
  stepsOfTree,
  treeOf,
  type TreeStep,
} from "./workflow-tree.ts";

const GROUP_STEP_TYPES: readonly string[] = [APPROVAL_ACTION, NOTIFY_ACTION];

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
  | { readonly kind: "failed" }
  | { readonly kind: "conflict" }
  | { readonly kind: "offline" };

const waits = (kind: SaveState["kind"]) =>
  kind === "failed" || kind === "conflict" || kind === "offline";

/**
 * One line of the problems list (design-ux's ruling, comment 6917906748): what
 * it is about, the sentence, and the one action that answers it. A row with no
 * step to select can only be read in the code, so it offers "View as code" —
 * a button never points at nothing.
 */
type ProblemRow = {
  readonly key: string;
  readonly field?:
    | ApprovalProblem["field"]
    | NotifyProblem["field"]
    | TaskProblem["field"]
    | "start";
  readonly start?: Omit<StartFocus, "request">;
  readonly blocking?: boolean;
  /** The step or group's name; empty for a problem that has no place in the drawing. */
  readonly name: string;
  readonly sentence: string;
  readonly stepId: string | null;
};

function approvalPart(uses: string, node: Record<string, unknown>) {
  const approval = uses === APPROVAL_ACTION ? approvalOfNode(node) : null;
  const notify = uses === NOTIFY_ACTION ? notifyOfNode(node) : null;
  const task = uses === TASK_ACTION ? taskOfNode(node) : null;
  return {
    ...(approval === null ? {} : { approval }),
    ...(notify === null ? {} : { notify }),
    ...(task === null ? {} : { task }),
  };
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
    const entry = (raw: unknown, list?: string): EditorStep[] => {
      const step = record(raw);
      const id = typeof step.id === "string" ? step.id : "";
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (id === "") return [];
      return [{
        ...(list === undefined ? {} : { list }),
        id,
        uses,
        agentVersionId: typeof step.agentVersionId === "string"
          ? step.agentVersionId
          : null,
        skills: skillsOfNode(step),
        ...approvalPart(uses, step),
      }];
    };
    return steps.flatMap((raw) =>
      isPlainGroup(raw)
        ? raw.steps.flatMap((inner) => entry(inner, raw.id))
        : entry(raw)
    );
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
  const [notice, setNotice] = useEditorNotice(editor);
  // null until the version being edited is known: an unknown baseline is not a
  // change, so the leave warning is never armed on a page nobody has touched.
  const lastSaved = useRef<string | null>(null);
  // The version the last save returned: a second edit made while the draft is
  // still being read again must send this one, not the one it last read.
  const savedVersion = useRef<
    | { id: string; version: number; digest: string; sourceYaml?: string }
    | null
  >(null);
  const [reloads, setReloads] = useState(0);
  const away = useConnectivity() === "offline";
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
    return saved?.id === draft.id && saved.version > draft.version ? saved : {
      id: draft.id,
      version: draft.version,
      digest: draft.digest,
      sourceYaml: draft.sourceYaml,
    };
  };
  const openDraft = async () => {
    if (draft === null) throw new Error("no draft version");
    const created = await api.createWorkflowVersion({
      organizationId: scope.organizationId as string,
      workflowId,
      input: {
        definition: draft.normalizedSpec,
        ...await authoredYaml(draft.sourceYaml, draft.normalizedSpec),
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
      sourceYaml: created.data.sourceYaml,
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
  }, [draft?.id, versionSteps, versionStarts, reloads]);

  const reloadDraft = async () => {
    await queryClient.invalidateQueries({ queryKey: ["protected"] });
    resetFor.current = undefined;
    savedVersion.current = null;
    lastSaved.current = null;
    setResolving(new Set());
    setSelectedId(null);
    setNotice(null);
    setReloads((count) => count + 1);
  };

  useEffect(() => {
    if (!away && saveState.kind === "offline") {
      setSaveState({ kind: "saved" });
    }
  }, [away, saveState.kind]);

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
      const definition = definitionOf(
        record(draft.normalizedSpec),
        steps,
        editor.loops,
      );
      const authored = await authoredYaml(target.sourceYaml, definition);
      const result = await api.updateWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: target.id,
        version: target.version,
        input: {
          definition: definition as never,
          ...authored,
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
        sourceYaml: result.data.sourceYaml,
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
    onError: (error) => {
      setSaveState({
        kind: isConflictFailure(error)
          ? "conflict"
          : away
          ? "offline"
          : "failed",
      });
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
  });

  const [draftKept, setDraftKept] = useState<
    { readonly used: WorkflowVersionResponse; readonly held: string } | null
  >(null);
  const [rewriting, setRewriting] = useState(false);
  const draftNow = () =>
    JSON.stringify([
      writeTarget()?.version,
      editor.steps,
      editor.loops,
      editor.starts,
    ]);
  const rebaseLeftoverDraft = async (used: WorkflowVersionResponse) => {
    const target = draft?.status === "draft" ? writeTarget() : null;
    if (target === null) return;
    const held = draftNow();
    setRewriting(true);
    const written = await rewriteDraft(
      api,
      scope.organizationId as string,
      workflowId,
      target,
      used,
    );
    setDraftKept(written ? null : { used, held });
    setRewriting(false);
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  };
  const retryRebase = (kept: NonNullable<typeof draftKept>) => {
    if (draftNow() !== kept.held) return setDraftKept(null);
    void rebaseLeftoverDraft(kept.used);
  };

  const publish = useMutation({
    mutationKey: ["workflowVersions.publish"],
    mutationFn: async (alsoUse: boolean) => {
      const latest = otherUnused === undefined ? writeTarget() : null;
      let versionId = otherUnused?.id ?? draft?.id ?? "";
      let revision = otherUnused?.revision ?? draft?.revision ?? 0;
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
        if (!alsoUse) return { versionId, revision };
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
      if (otherUnused !== undefined) await rebaseLeftoverDraft(otherUnused);
      return { versionId, revision };
    },
    onError: (error) => {
      if (error instanceof ActivationFailed) {
        setPublishedOnly(error.versionId);
        setNotice(null);
        setPublishOpen(true);
      }
      if (error instanceof ActivationFailed || isConflictFailure(error)) {
        void queryClient.invalidateQueries({ queryKey: ["protected"] });
      }
    },
    onSuccess: async ({ versionId, revision }, alsoUse) => {
      setPublishedOnly(alsoUse ? null : versionId);
      await queryClient.invalidateQueries({ queryKey: ["protected"] });
      setPublishOpen(false);
      setNotice({ kind: "published", versionId, revision, used: alsoUse });
    },
  });

  const activateNamed = useMutation({
    mutationKey: ["workflowVersions.activate"],
    mutationFn: async ({ versionId }: PublishedNotice) => {
      const used = await api.activateWorkflowVersion({
        organizationId: scope.organizationId as string,
        id: workflowId,
        versionId,
        version: workflow.data?.version ?? 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!used.ok) throw used.error;
    },
    onSuccess: async (_, named) => {
      await queryClient.invalidateQueries({ queryKey: ["protected"] });
      setPublishedOnly(null);
      setNotice({ ...named, used: true, refused: false });
    },
    onError: (_, named) => {
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      setNotice({ ...named, refused: true });
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
  const pendingChanges = draft !== null && (changes.differs || startsChanged);
  const newerUnused = inUse === null ? undefined : (versions.data?.items ?? [])
    .filter((item) =>
      item.status === "published" && item.revision > inUse.revision
    )
    .sort((a, b) => b.revision - a.revision)[0];
  const unused = publishedUnused
    ? draft
    : pendingChanges
    ? undefined
    : newerUnused;
  const otherUnused = unused !== undefined && unused.id !== draft?.id
    ? unused
    : undefined;
  const draftDiffers = pendingChanges || unused !== undefined;

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
  const grouped = !plainList && (rawSteps?.some(isPlainGroup) ?? false);
  const tree = useMemo(() => {
    if (rawSteps === null) return treeOf({});
    if (grouped) return treeOf(definitionOf(rawSpec, steps));
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
  }, [rawSpec, rawSteps, plainList, grouped, steps]);
  // Slice 1 adds, moves and removes only the actions of a straight line; a
  // definition that holds groups is drawn and read, never rewritten.
  const editable = canManage && (plainList || grouped);
  const canChange = (step: EditorStep | undefined) =>
    editable && step !== undefined && (plainList || step.list !== undefined);
  const deletable = (step: EditorStep | undefined) =>
    canChange(step) &&
    (!grouped || steps.filter((one) => one.list === step?.list).length > 1);
  const written = (id: string) =>
    stepsOfTree(tree).find((one) => one.id === id)?.codeOnly === true;
  const focusBlock = (id: string) =>
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>(
        `[data-card="${CSS.escape(id)}"] button`,
      )
    );
  const moveStep = (id: string, by: -1 | 1) => {
    const index = steps.findIndex((one) => one.id === id);
    const other = steps[index + by];
    if (
      written(id) || !canChange(steps[index]) || other === undefined ||
      other.list !== steps[index].list
    ) return;
    dispatch({ kind: "move", id, index: index + by });
    focusBlock(id);
  };
  const removeStep = (id: string) => {
    const drawn = stepsOfTree(tree).find((one) => one.id === id);
    const index = steps.findIndex((one) => one.id === id);
    if (written(id) || !deletable(steps[index]) || drawn === undefined) return;
    setNotice({ kind: "deleted", name: stepName(drawn, translate) });
    dispatch({ kind: "remove", id });
    setSelectedId(null);
    focusBlock((steps[index + 1] ?? steps[index - 1])?.id ?? "start");
  };
  useStepKeys(editable, {
    move: moveStep,
    remove: removeStep,
    undo: () => dispatch({ kind: "undo" }),
    redo: () => dispatch({ kind: "redo" }),
  });
  const groupStarts = useMemo(
    () => grouped ? groupStartsOf(tree, steps) : new Map(),
    [grouped, tree, steps],
  );
  const addAfter = grouped
    ? new Set<string | null>([
      ...groupStarts.keys(),
      ...steps.filter((step) => step.list !== undefined).map((step) => step.id),
    ])
    : undefined;
  const addBefore = new Map<string | null, string>(
    [...groupStarts].flatMap(([block, first]) =>
      block === null ? [] : [[block, first.uses]]
    ),
  );

  // Checking is continuous: the draft is checked against the server as it
  // changes, and each problem lands on the step its pointer names. A problem
  // that points at no step is the workflow's own, and the chip still counts it.
  const [checker, setChecker] = useState<{
    readonly byStep: ReadonlyMap<string, string>;
    /** Steps whose only problems are skills needing a choice: their Skills section says it. */
    readonly skillOnly: ReadonlySet<string>;
    readonly refused: ReadonlySet<string>;
    readonly refusedElsewhere: boolean;
    /** Problems that name a step the page does not draw, so no card can hold them. */
    readonly unmapped: readonly string[];
    readonly workflow: readonly string[];
    readonly unboundActions: ReadonlySet<string>;
  }>({
    byStep: new Map(),
    skillOnly: new Set(),
    refused: new Set(),
    refusedElsewhere: false,
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
    onSuccess: ({ report, definition }) => {
      const found = [...(report.errors ?? []), ...(report.warnings ?? [])];
      const sorted = problemsOf(withoutUnboundAgent(found), definition);
      const byStep = new Map<string, string>();
      const skillOnly = new Set<string>();
      for (const [id, held] of sorted.byStep) {
        byStep.set(id, stepProblemLine(held) ?? "");
        if (held.every((problem) => SKILL_PROBLEM_CODES.has(problem.code))) {
          skillOnly.add(id);
        }
      }
      const refused = problemsOf(
        withoutUnboundAgent(report.errors ?? []),
        definition,
      );
      setChecker({
        byStep,
        skillOnly,
        refused: new Set(refused.byStep.keys()),
        refusedElsewhere: refused.unmapped.length + refused.workflow.length > 0,
        unmapped: sorted.unmapped.map((problem) =>
          problemSentence(problem.code)
        ),
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
        refused: new Set(),
        refusedElsewhere: false,
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
    if (!canManage || draft === null || waits(saveState.kind) || away) return;
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
    away,
  ]);

  useEffect(() => {
    if (!publishAfterSave) return;
    if (waits(saveState.kind)) {
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

  const closePanel = useCallback(() => setSelectedId(null), []);
  useEscapeClosesPanel(selectedId !== null, closePanel);

  const unsaved = changed || loopPending || save.isPending ||
      saveState.kind !== "saved" || badBudget
    ? 1
    : 0;

  const shownSave: SaveState = forcedSaveState() ?? saveState;
  const unsent = waits(shownSave.kind) || away && changed;
  const stateWord = shownSave.kind === "saving"
    ? translate("library.editor.save.saving" as never)
    : unsent
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
  const notifies = steps.some((step) => step.notify !== undefined);
  const asks = notifies || steps.some((step) => step.approval !== undefined);
  const groups = useQuery({
    ...groupsQueryOptions(api, scope),
    enabled: notifies && scope.organizationId !== null,
  });
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
  const choices = useMemo(
    () => notifyChoices(groups.data, people, translate),
    [groups.data, people, translate],
  );
  const lists = useMemo<ListStates>(() => ({
    people: members.isError
      ? "failed"
      : members.data === undefined
      ? "loading"
      : "ready",
    groups: groups.isError
      ? "failed"
      : groups.data === undefined
      ? "loading"
      : "ready",
  }), [members.isError, members.data, groups.isError, groups.data]);
  const notifyNotes = useMemo(() => {
    const directory = {
      people: everyone === null ? null : new Set(
        everyone.filter((one) => one.active).map((one) => one.principalId),
      ),
      groups: groups.data === undefined ? null : new Map([
        ...groups.data.groups.map((group) =>
          [`group:${group.id}`, group.memberCount] as const
        ),
        ...groups.data.fromRoles.map((role) =>
          [`role:${role.roleKey}`, role.memberCount] as const
        ),
      ]),
    };
    const sentence = ({ field, kind, who }: NotifyWarning) => {
      const name = whoName(who, choices, lists, translate);
      if (kind === "personGone") {
        return translate("library.editor.notify.warning.personGone", {
          name: choices.some((choice) => choice.value === who)
            ? name
            : translate("library.editor.notify.warning.thisPerson"),
        });
      }
      return translate(`library.editor.notify.warning.${field}.${kind}`, {
        name,
      });
    };
    const found = new Map<
      string,
      readonly (NotifyWarning & { readonly sentence: string })[]
    >();
    for (const step of steps) {
      if (step.notify === undefined) continue;
      const warnings = notifyWarnings(step.notify, directory).map(
        (warning) => ({ ...warning, sentence: sentence(warning) }),
      );
      if (warnings.length > 0) found.set(step.id, warnings);
    }
    return found;
  }, [steps, everyone, groups.data, choices, lists, translate]);
  const rememberedNext = useRef(new Map<string, NotifyNext>());
  const rememberNext = useCallback((next: NotifyNext) => {
    if (selectedId !== null) rememberedNext.current.set(selectedId, next);
  }, [selectedId]);
  const notifyIssues = useMemo(() => {
    const found = new Map<
      string,
      readonly (NotifyProblem & { readonly sentence: string })[]
    >();
    for (const step of steps) {
      if (step.notify === undefined) continue;
      const issues = notifyProblems(
        step.notify,
        documentsBefore(steps, step.id).map(documentKey),
      ).map((problem) => ({
        ...problem,
        sentence: translate(`library.editor.notify.problem.${problem.kind}`),
      }));
      if (issues.length > 0) found.set(step.id, issues);
    }
    return found;
  }, [steps, translate]);
  const taskIssues = useMemo(() => {
    const found = new Map<
      string,
      readonly (TaskProblem & { readonly sentence: string })[]
    >();
    for (const step of steps) {
      if (step.task === undefined) continue;
      const issues = taskProblems(step.task).map((problem) => ({
        ...problem,
        sentence: translate(`library.editor.task.problem.${problem.field}`),
      }));
      if (issues.length > 0) found.set(step.id, issues);
    }
    return found;
  }, [steps, translate]);
  const cardLines = useMemo<ReadonlyMap<string, string>>(() => {
    const lines = new Map<string, string>();
    for (const step of steps) {
      if (step.notify !== undefined) {
        const line = notifyCardLine(step.notify, choices, lists, translate);
        if (line !== null) lines.set(step.id, line);
      }
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
  }, [steps, people, members.data, choices, lists, translate]);
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
    for (
      const [id, issues] of [...approvalIssues, ...notifyIssues, ...taskIssues]
    ) {
      merged.set(id, issues[0].sentence);
    }
    for (const id of skillProblemSteps) {
      if (!merged.has(id)) merged.set(id, SKILL_PROBLEM_SENTENCE);
    }
    if (startIssues.length > 0) merged.set(START_ID, startIssues[0].sentence);
    return merged;
  }, [
    checker.byStep,
    approvalIssues,
    notifyIssues,
    taskIssues,
    skillProblemSteps,
    startIssues,
  ]);
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
      for (const issue of notifyIssues.get(step.id) ?? []) {
        out.push({
          key: `notify-${step.id}-${issue.kind}`,
          name: stepName(step, translate),
          sentence: issue.sentence,
          stepId: step.id,
          field: issue.field,
          blocking: true,
        });
      }
      for (const warning of notifyNotes.get(step.id) ?? []) {
        out.push({
          key: `notify-${step.id}-${warning.field}-${warning.kind}`,
          name: stepName(step, translate),
          sentence: warning.sentence,
          stepId: step.id,
        });
      }
      for (const issue of taskIssues.get(step.id) ?? []) {
        out.push({
          key: `task-${step.id}-${issue.field}`,
          name: stepName(step, translate),
          sentence: issue.sentence,
          stepId: step.id,
          field: issue.field,
          blocking: true,
        });
      }
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
  }, [
    tree,
    checker,
    problemsByStep,
    approvalIssues,
    notifyIssues,
    notifyNotes,
    taskIssues,
    startIssues,
    translate,
  ]);
  const blocked = checker.refused.size > 0 || checker.refusedElsewhere ||
    rows.some((row) => row.blocking === true);
  const [focusRequest, setFocusRequest] = useState<
    {
      readonly stepId: string;
      readonly field: NonNullable<ProblemRow["field"]>;
      readonly request: number;
      readonly start: StartFocus | null;
    } | null
  >(null);

  const problemCount = rows.length;
  const shown = otherUnused === undefined
    ? {
      changes,
      startsChanged,
      automatic,
      blocked,
      problemCount,
    }
    : {
      changes: publishChanges(
        inUse?.normalizedSpec,
        record(otherUnused.normalizedSpec),
        (key) => translate(key),
      ),
      startsChanged: !sameStarts(
        startsOfVersion(otherUnused.starts),
        inUseStarts,
      ),
      automatic: automaticStarts(startsOfVersion(otherUnused.starts)),
      blocked: false,
      problemCount: 0,
    };
  const cleanWord = unused !== undefined
    ? translate("library.editor.publishedUnused", { version: unused.revision })
    : draftDiffers
    ? translate("library.editor.ready")
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
      setNotice({
        kind: "skill",
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
    setNotice({
      kind: "skill",
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
                setNotice({
                  kind: "deleted",
                  name: translate("library.editor.start.heading", {
                    number: removed + 1,
                  }),
                });
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
                setNotice({
                  kind: "skill",
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
      attach: canChange(live) && live?.agentVersionId != null
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
      onChange: canChange(live)
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
          (focusRequest.field === "prompt" ||
            focusRequest.field === "audience")
        ? { field: focusRequest.field, request: focusRequest.request }
        : null,
    };
    return {
      kind: "step",
      name: stepName(step, translate),
      deletable: deletable(live),
      uses: step.uses,
      approval,
      notify: live?.notify === undefined ? undefined : {
        stepId: live.id,
        fields: live.notify,
        onChange: canChange(live)
          ? (fields: NonNullable<EditorStep["notify"]>, typing?: string) =>
            dispatch({
              kind: "notify",
              id: live.id,
              notify: fields,
              ...(typing === undefined ? {} : { typing }),
            })
          : undefined,
        choices,
        lists,
        onRetry: () => {
          void members.refetch();
          void groups.refetch();
        },
        remembered: rememberedNext.current.get(live.id) ?? null,
        onRemember: rememberNext,
        whoWarning: notifyNotes.get(live.id)?.find((one) => one.field === "who")
          ?.sentence,
        nextWarning: notifyNotes.get(live.id)?.find((one) =>
          one.field === "next"
        )?.sentence,
        documents: documentsBefore(steps, live.id).map((one) => ({
          value: documentKey(one),
          label: translate(ACTION_TITLES[one.uses]),
        })),
        fromProblem: notifyIssues.get(live.id)?.find((one) =>
          one.field === "from"
        )?.sentence,
        nextProblem: notifyIssues.get(live.id)?.find((one) =>
          one.field === "next"
        )?.sentence,
        focus: focusRequest?.stepId === live.id &&
            (focusRequest.field === "from" || focusRequest.field === "next")
          ? { field: focusRequest.field, request: focusRequest.request }
          : null,
      },
      task: live?.task === undefined ? undefined : {
        stepId: live.id,
        fields: live.task,
        onChange: canChange(live)
          ? (fields: NonNullable<EditorStep["task"]>, typing?: string) =>
            dispatch({
              kind: "task",
              id: live.id,
              task: fields,
              ...(typing === undefined ? {} : { typing }),
            })
          : undefined,
        problems: Object.fromEntries(
          (taskIssues.get(live.id) ?? []).map((issue) => [
            issue.field,
            issue.sentence,
          ]),
        ),
        focus: focusRequest?.stepId === live.id &&
            isTaskField(focusRequest.field)
          ? { field: focusRequest.field, request: focusRequest.request }
          : null,
      },
      agentFromSetup: checker.unboundActions.has(step.uses),
      code: step.code,
      problem: step.problem === undefined
        ? undefined
        : step.problem === "unknown"
        ? translate("library.editor.problem.unknown" as never)
        : translate("library.editor.problem.unreadable" as never),
      ...skillsFor(live, step),
      canMoveUp: index > 0 && steps[index - 1].list === live?.list,
      canMoveDown: index >= 0 && index < steps.length - 1 &&
        steps[index + 1].list === live?.list,
      disabled: !canChange(live) || index < 0,
      onMoveUp: () => {
        if (live === undefined) return;
        dispatch({ kind: "move", id: live.id, index: index - 1 });
      },
      onMoveDown: () => {
        if (live === undefined) return;
        dispatch({ kind: "move", id: live.id, index: index + 1 });
      },
      onRemove: () => {
        if (live !== undefined) removeStep(live.id);
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
    notifyIssues,
    notifyNotes,
    taskIssues,
    choices,
    lists,
    rememberNext,
    groups.status,
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
            {...(addAfter === undefined
              ? {}
              : { addAfter, addBefore, offer: GROUP_STEP_TYPES })}
            onAdd={(afterId) => setPickerAfter(afterId)}
            onSelect={setSelectedId}
            onViewAsCode={() => setCodeOpen(true)}
            pickerAt={pickerAfter}
            onPick={(uses) => {
              const afterId = pickerAfter ?? null;
              const id = freeStepId(editor, uses, nodeIds(rawSteps));
              const opening = grouped ? groupStarts.get(afterId) : undefined;
              const list = grouped
                ? opening?.list ??
                  steps.find((one) => one.id === afterId)?.list
                : undefined;
              const step = {
                id,
                uses,
                agentVersionId: null,
                skills: [],
                ...(uses === APPROVAL_ACTION ? { approval: NEW_APPROVAL } : {}),
                ...(uses === NOTIFY_ACTION ? { notify: NEW_NOTIFY } : {}),
                ...(uses === TASK_ACTION ? { task: NEW_TASK } : {}),
                ...(list === undefined ? {} : { list }),
              };
              dispatch({ kind: "add", step });
              if (opening !== undefined) {
                const first = steps.findIndex((one) => one.list === list);
                dispatch({ kind: "move", id, index: first });
              } else if (afterId !== null) {
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
  const notSaved = unsent;
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
    if (saveState.kind === "conflict" || away) {
      setNotice({ kind: "refused", why: away ? "away" : "conflict" });
      return;
    }
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
            {shownSave.kind !== "conflict" ? null : (
              <UI.AlertBanner
                action={
                  <UI.Button
                    onClick={() => void reloadDraft()}
                    variant="secondary"
                  >
                    {translate("library.editor.conflictReload")}
                  </UI.Button>
                }
                tone="warning"
              >
                {translate("library.editor.conflict")}
              </UI.AlertBanner>
            )}
            {!away || !canManage
              ? null
              : (
                <UI.InlineNotice tone="warning" role="status">
                  {translate("library.editor.offlineEditing")}
                </UI.InlineNotice>
              )}
            {draftKept === null ? null : (
              <DraftKeptNotice
                onRetry={() => retryRebase(draftKept)}
                pending={rewriting}
                version={draftKept.used.revision}
              />
            )}
            {access.data === undefined || canManage
              ? null
              : (
                <UI.Text variant="muted">
                  {translate("library.editor.memberOnly")}
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
        safest
      />
      {body}
      {notice === null ||
          (notice.kind === "refused" &&
            !(notice.why === "away" ? away : saveState.kind === "conflict"))
        ? null
        : (
          <EditorToast
            notice={notice}
            onUndoDelete={() => dispatch({ kind: "undo" })}
            onUse={(version) =>
              away
                ? setNotice({ ...version, refused: true })
                : activateNamed.mutate(version)}
            onClose={() => setNotice(null)}
          />
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
            title={unused !== undefined
              ? translate("library.editor.publish.useTitle", {
                version: String(unused.revision),
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
            confirmAction={draftDiffers && !shown.blocked
              ? (
                <UI.Inline gap="compact">
                  {unused !== undefined ? null : (
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
                    {publish.error instanceof ActivationFailed
                      ? translate("library.editor.save.tryAgain")
                      : unused !== undefined
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
                    {shown.blocked
                      ? translate("library.editor.publish.blocked")
                      : publish.error instanceof ActivationFailed
                      ? null
                      : unused !== undefined
                      ? translate("library.editor.publish.useBody", {
                        version: String(unused.revision),
                      })
                      : translate("library.editor.publish.body")}
                  </UI.Text>
                  <UI.Text variant="muted">
                    {translate("library.workflow.steps.never" as never)}
                  </UI.Text>
                  {shown.blocked || shown.automatic === 0 ? null : (
                    <UI.Text>
                      {translate(
                        unused !== undefined
                          ? "library.editor.start.useNote"
                          : "library.editor.start.publishNote",
                        { count: shown.automatic },
                      )}
                    </UI.Text>
                  )}
                  <PublishSummary
                    blocked={shown.blocked}
                    changes={shown.changes}
                    inUseRevision={inUse?.revision ?? null}
                    problemCount={shown.problemCount}
                    publishedBefore={versions.data?.items.some((item) =>
                      item.status === "published"
                    ) ?? false}
                    startsChanged={shown.startsChanged}
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
                  {shown.problemCount === 0 ? null : problemList}
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
              code={readableSource(
                versionSource(
                  workflow.data ?? { name: "", description: "" },
                  draft,
                ).sourceYaml ?? "",
              )}
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
