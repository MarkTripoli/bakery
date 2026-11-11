import { StandardError } from "@bakery/contracts/http";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "@bakery/contracts/workflow-action-registry";
import {
  type AgentBindingSource,
  isAgentVersionSelector,
  selectStepAgentVersion,
  workflowActionCapabilities,
} from "@bakery/persistence";
import {
  compileWorkflowDocument,
  WORKFLOW_COMPILER_VERSION,
} from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type AgentVersionSelection,
  resolveAgentVersionSelections,
} from "../work/agent-run-admission.ts";
import {
  extractFixedWorkflowSteps,
  workflowRequiresRepository,
} from "../work/run-steps.ts";

/** One finding; `path` is a JSON Pointer and no submitted value is ever echoed. */
export type WorkflowValidationIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

export type WorkflowValidationReport = Readonly<{
  valid: boolean;
  errors: readonly WorkflowValidationIssue[];
  warnings: readonly WorkflowValidationIssue[];
  normalizedDigest: string | null;
  /** Compiler identity; present on every report. */
  compilerVersion: string;
  /** Compiler semantic digest; null when the compiler rejected the definition. */
  semanticDigest: string | null;
  /** Compiler findings (JSON Pointer, stable code, catalogued message). Advisory: they do not change `valid`. */
  compilerDiagnostics: readonly WorkflowValidationIssue[];
  graph?: unknown;
  requiresRepository?: boolean;
  registryVersion?: number;
  registryDigest?: string;
}>;

export const MAX_WORKFLOW_DEFINITION_BYTES = 100_000;
const MAX_ISSUES = 100;
const MAX_STEPS = 100;
const MAX_AGENT_BINDINGS = 17;
const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
/**
 * Keys no definition may carry at the root or on a step: they would smuggle a
 * model/billing override, credentials or executable code past the immutable
 * agent version. A denylist, so grammar growth elsewhere cannot collide.
 */
const BINDING_OVERRIDE_KEYS: readonly string[] = Object.freeze([
  "billing",
  "model",
  "provider",
  "harness",
  "credentials",
  "credential",
  "apiKey",
  "secret",
  "agentConfig",
  "config",
  "run",
  "script",
  "command",
  "code",
  "env",
  "exec",
  "token",
  "password",
]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointerSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${escapePointerSegment(segment)}`).join(
    "",
  );
}

function issue(path: string, code: string): WorkflowValidationIssue {
  return Object.freeze({ path, code, message: code.replaceAll("_", " ") });
}

/**
 * Converts a JSON Pointer into the segment array the problem body keeps
 * (`sanitizeIssues` drops string paths). All-digit segments become integers.
 */
export function jsonPointerToSegments(
  value: string,
): readonly (string | number)[] {
  if (value === "") return [];
  if (!value.startsWith("/")) {
    throw new TypeError("JSON Pointer must be empty or start with a slash");
  }
  return value.slice(1).split("/").map((raw) => {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    return /^(?:0|[1-9][0-9]{0,14})$/.test(segment) ? Number(segment) : segment;
  });
}

let registryDigestCache: Promise<string> | undefined;

function registryDigest(): Promise<string> {
  registryDigestCache ??= sha256Hex(canonicalJson(WORKFLOW_ACTION_METADATA));
  return registryDigestCache;
}

function isKnownAction(action: string): boolean {
  return Object.hasOwn(WORKFLOW_ACTION_METADATA, action);
}

function isExecutableAction(action: string): boolean {
  try {
    workflowActionCapabilities(action);
    return true;
  } catch {
    return false;
  }
}

function actionCapabilities(action: string, requires: unknown): string[] {
  try {
    return [...workflowActionCapabilities(action, requires)];
  } catch (error) {
    if (
      error instanceof StandardError &&
      error.params?.reason === "workflow_action_requirements_invalid"
    ) throw error;
    const metadata = Object.entries(WORKFLOW_ACTION_METADATA).find(([name]) =>
      name === action
    )?.[1];
    return [...(metadata?.capabilities ?? [])];
  }
}

function checkKinds(
  definition: RecordValue,
  errors: WorkflowValidationIssue[],
): void {
  const workflow = definition.workflow;
  const kinds: { path: string; value: unknown }[] = [];
  if (workflow !== undefined) {
    if (!isRecord(workflow)) {
      errors.push(issue(pointer("workflow"), "workflow_kind_unsupported"));
      return;
    }
    if (workflow.kind !== undefined) {
      kinds.push({ path: pointer("workflow", "kind"), value: workflow.kind });
    }
  }
  const documentKind = definition.kind;
  const documentIsWorkflow = documentKind === "workflow";
  if (documentKind !== undefined && !documentIsWorkflow) {
    kinds.push({ path: pointer("kind"), value: documentKind });
  }
  let fixed = documentIsWorkflow;
  for (const kind of kinds) {
    if (kind.value === "fixed") fixed = true;
    else errors.push(issue(kind.path, "workflow_kind_unsupported"));
  }
  if (!fixed && errors.every((e) => e.code !== "workflow_kind_unsupported")) {
    errors.push(issue(pointer("kind"), "workflow_kind_unsupported"));
  }
}

function checkAgents(
  definition: RecordValue,
  errors: WorkflowValidationIssue[],
): void {
  const agents = definition.agents;
  if (agents === undefined) return;
  if (!isRecord(agents)) {
    errors.push(issue(pointer("agents"), "agents_not_object"));
    return;
  }
  const entries = Object.entries(agents);
  if (entries.length > MAX_AGENT_BINDINGS) {
    errors.push(issue(pointer("agents"), "workflow_structure_invalid"));
  }
  for (const [action, agentVersionId] of entries) {
    const path = pointer("agents", action);
    if (!ACTION_NAME_PATTERN.test(action) || !isKnownAction(action)) {
      // Unknown keys are submitted text; report at the container instead.
      errors.push(issue(pointer("agents"), "agent_binding_action_unknown"));
    } else if (
      !isAgentVersionSelector(agentVersionId)
    ) {
      errors.push(issue(path, "agent_binding_id_invalid"));
    }
  }
}

function checkSteps(
  definition: RecordValue,
  errors: WorkflowValidationIssue[],
  warnings: WorkflowValidationIssue[],
): void {
  const steps = definition.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(issue(pointer("steps"), "steps_required"));
    return;
  }
  if (steps.length > MAX_STEPS) {
    errors.push(issue(pointer("steps"), "steps_too_many"));
    return;
  }
  const agents = isRecord(definition.agents) ? definition.agents : {};
  const seen = new Set<string>();
  const warned = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) {
      errors.push(issue(pointer("steps", index), "step_not_object"));
      continue;
    }
    const id = step.id;
    if (typeof id !== "string" || !STEP_ID_PATTERN.test(id)) {
      errors.push(issue(pointer("steps", index, "id"), "step_id_invalid"));
    } else if (seen.has(id)) {
      errors.push(issue(pointer("steps", index, "id"), "step_id_duplicate"));
    } else {
      seen.add(id);
    }
    const action = step.uses;
    if (typeof action !== "string" || !ACTION_NAME_PATTERN.test(action)) {
      errors.push(
        issue(pointer("steps", index, "uses"), "step_action_invalid"),
      );
    } else if (!isKnownAction(action)) {
      errors.push(issue(pointer("steps", index, "uses"), "action_unknown"));
    } else {
      if (!isExecutableAction(action) && !warned.has(`x:${action}`)) {
        warned.add(`x:${action}`);
        warnings.push(
          issue(pointer("steps", index, "uses"), "action_not_executable"),
        );
      }
      let capabilities: string[] = [];
      try {
        capabilities = actionCapabilities(action, step.requires);
      } catch {
        errors.push(
          issue(pointer("steps", index, "requires"), "step_requires_invalid"),
        );
      }
      if (
        capabilities.includes("model") &&
        selectStepAgentVersion({
            action,
            stepAgentVersionId: isAgentVersionSelector(step.agentVersionId)
              ? step.agentVersionId
              : undefined,
            workflowAgents: agents as Record<string, string>,
            profileAgentBindings: undefined,
          }).source === "none" &&
        !warned.has(`m:${action}`)
      ) {
        warned.add(`m:${action}`);
        warnings.push(
          issue(pointer("steps", index, "uses"), "model_agent_unbound"),
        );
      }
    }
    if (
      Object.hasOwn(step, "agentVersionId") &&
      !isAgentVersionSelector(step.agentVersionId)
    ) {
      errors.push(
        issue(
          pointer("steps", index, "agentVersionId"),
          "step_agent_version_invalid",
        ),
      );
    }
    for (const key of BINDING_OVERRIDE_KEYS) {
      if (Object.hasOwn(step, key)) {
        errors.push(
          issue(
            pointer("steps", index, key),
            "step_binding_override_forbidden",
          ),
        );
      }
    }
    const requires = step.requires;
    if (
      requires !== undefined &&
      (!Array.isArray(requires) ||
        requires.some((value) =>
          typeof value !== "string" || value.trim() === ""
        ))
    ) {
      const path = pointer("steps", index, "requires");
      if (
        !errors.some((e) =>
          e.path === path && e.code === "step_requires_invalid"
        )
      ) {
        errors.push(issue(path, "step_requires_invalid"));
      }
    }
  }
}

async function compilerReport(definition: unknown): Promise<
  Pick<
    WorkflowValidationReport,
    "compilerVersion" | "semanticDigest" | "compilerDiagnostics"
  >
> {
  const result = await compileWorkflowDocument(definition, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  return {
    compilerVersion: WORKFLOW_COMPILER_VERSION,
    semanticDigest: result.ok ? result.digest : null,
    compilerDiagnostics: Object.freeze(
      result.diagnostics.slice(0, MAX_ISSUES).map(({ path, code, message }) =>
        Object.freeze({ path, code, message })
      ),
    ),
  };
}

/**
 * Pure, organization-independent pass over a candidate definition. Enriches
 * the report with graph, repository need and registry identity when valid.
 */
export async function validateWorkflowDefinitionStatic(
  definition: unknown,
): Promise<WorkflowValidationReport> {
  const errors: WorkflowValidationIssue[] = [];
  const warnings: WorkflowValidationIssue[] = [];
  const compiled = await compilerReport(definition);
  const finish = (): WorkflowValidationReport =>
    Object.freeze({
      ...compiled,
      valid: false,
      errors: Object.freeze(errors.slice(0, MAX_ISSUES)),
      warnings: Object.freeze(warnings.slice(0, MAX_ISSUES)),
      normalizedDigest: null,
    });

  if (!isRecord(definition)) {
    errors.push(issue("", "definition_not_object"));
    return finish();
  }
  let canonical: string;
  try {
    canonical = canonicalJson(definition);
  } catch {
    errors.push(issue("", "definition_not_object"));
    return finish();
  }
  if (
    new TextEncoder().encode(canonical).byteLength >
      MAX_WORKFLOW_DEFINITION_BYTES
  ) {
    errors.push(issue("", "definition_too_large"));
    return finish();
  }

  checkKinds(definition, errors);
  checkAgents(definition, errors);
  for (const key of BINDING_OVERRIDE_KEYS) {
    if (Object.hasOwn(definition, key)) {
      errors.push(issue(pointer(key), "step_binding_override_forbidden"));
    }
  }
  checkSteps(definition, errors, warnings);

  let graph: unknown;
  let requiresRepository = false;
  if (errors.length === 0) {
    try {
      const steps = extractFixedWorkflowSteps(definition);
      requiresRepository = workflowRequiresRepository(definition);
      graph = {
        kind: "fixed",
        steps: steps.map((step) => ({
          id: step.key,
          uses: step.action,
          requires: [...(step.requires ?? [])],
        })),
      };
    } catch {
      errors.push(issue("", "workflow_structure_invalid"));
    }
  }
  if (errors.length > 0) return finish();

  return Object.freeze({
    ...compiled,
    valid: true,
    errors: Object.freeze([]),
    warnings: Object.freeze(warnings.slice(0, MAX_ISSUES)),
    normalizedDigest: await sha256Hex(canonical),
    graph,
    requiresRepository,
    registryVersion: WORKFLOW_ACTION_REGISTRY_VERSION,
    registryDigest: await registryDigest(),
  });
}

function bindingIssue(
  path: string,
  error: unknown,
): WorkflowValidationIssue | null {
  if (!(error instanceof StandardError)) return null;
  const reason = error.params?.reason;
  if (error.code === "STATE_CONFLICT" && typeof reason === "string") {
    return issue(path, reason);
  }
  if (error.code === "UNPROCESSABLE") {
    const issues = error.params?.issues;
    const code = Array.isArray(issues) && isRecord(issues[0])
      ? issues[0].code
      : undefined;
    if (typeof code === "string") return issue(path, code);
  }
  return null;
}

/** Binding failures that depend on one step's `requires`, not on the agent version alone. */
const STEP_POLICY_CODES: ReadonlySet<string> = new Set([
  "agent_action_capability_denied",
  "model_agent_required",
  "model_billing_required",
]);

/**
 * The action-level failure names the bound agent and only the first policy
 * code the batch hit. This re-resolves each selection alone (locks are already
 * held) so the author learns every step whose `requires` the policy rejects,
 * each with its own code.
 */
async function attributePolicyToSteps(
  transaction: PgTransactionClient,
  organizationId: string,
  selections: readonly (AgentVersionSelection & { position: number })[],
  errors: WorkflowValidationIssue[],
): Promise<void> {
  for (const selection of selections) {
    if (errors.length >= MAX_ISSUES) return;
    try {
      await resolveAgentVersionSelections(transaction, organizationId, [{
        stepKey: selection.stepKey,
        agentVersionId: selection.agentVersionId,
        required: selection.required,
      }]);
    } catch (error) {
      const mapped = bindingIssue("", error);
      if (mapped === null) throw error;
      if (!STEP_POLICY_CODES.has(mapped.code)) continue;
      errors.push(
        issue(pointer("steps", selection.position, "requires"), mapped.code),
      );
    }
  }
}

/** One step's effective binding as resolved at validation time. */
export type WorkflowStepBindingReport = Readonly<{
  stepId: string;
  action: string;
  source: AgentBindingSource;
  agentVersionId: string | null;
  revision: number | null;
  digest: string | null;
  requiredCapabilities: readonly string[];
  modelBillingRequired: boolean;
}>;

export type WorkflowBindingsResult = Readonly<{
  errors: readonly WorkflowValidationIssue[];
  /** Every step's binding; empty when `errors` is non-empty. */
  bindings: readonly WorkflowStepBindingReport[];
}>;

type BoundSelection = AgentVersionSelection & {
  action: string;
  position: number;
  source: AgentBindingSource;
};

/**
 * Org-scoped pass: resolves each bound agent version through the same helper
 * run admission uses, so a publishable binding cannot fail admission. Runs
 * inside the caller's transaction; locks follow admission order (agent
 * definitions FOR SHARE by id, then skill rows FOR UPDATE). Unrecognized
 * errors propagate. `source` is never `profile`: validation has no repository.
 */
export async function validateWorkflowBindings(
  transaction: PgTransactionClient,
  organizationId: string,
  definition: unknown,
): Promise<WorkflowBindingsResult> {
  const empty: WorkflowBindingsResult = Object.freeze({
    errors: Object.freeze([]),
    bindings: Object.freeze([]),
  });
  if (!isRecord(definition)) return empty;
  let steps;
  try {
    steps = extractFixedWorkflowSteps(definition);
  } catch {
    return empty;
  }
  const selections: BoundSelection[] = [];
  const unbound: {
    step: (typeof steps)[number];
    required: string[];
  }[] = [];
  for (const step of steps) {
    let required: string[];
    try {
      required = actionCapabilities(step.action, step.requires);
    } catch {
      continue; // reported by the static pass as step_requires_invalid
    }
    const { source, agentVersionId } = selectStepAgentVersion({
      action: step.action,
      stepAgentVersionId: step.stepAgentVersionId,
      workflowAgents: step.workflowAgentVersionId === null
        ? undefined
        : { [step.action]: step.workflowAgentVersionId },
      profileAgentBindings: undefined,
    });
    if (agentVersionId === null) {
      unbound.push({ step, required });
      continue;
    }
    selections.push({
      action: step.action,
      position: step.position,
      source,
      stepKey: step.key,
      agentVersionId,
      required,
    });
  }
  const toSelection = (
    { stepKey, agentVersionId, required }: BoundSelection,
  ) => ({
    stepKey,
    agentVersionId,
    required,
  });
  const errors: WorkflowValidationIssue[] = [];
  let resolved: Awaited<ReturnType<typeof resolveAgentVersionSelections>> = {};
  if (selections.length > 0) {
    try {
      // One batched call: same lock order and per-step policy check as admission.
      resolved = await resolveAgentVersionSelections(
        transaction,
        organizationId,
        selections.map(toSelection),
      );
    } catch (batchError) {
      if (bindingIssue("", batchError) === null) throw batchError;
      // Locks are already held; attribute per binding target without new lock order risk.
      const groups = new Map<string, {
        path: string;
        selections: BoundSelection[];
      }>();
      for (const selection of selections) {
        const workflowLevel = selection.source === "workflow";
        const key = workflowLevel
          ? `w:${selection.action}`
          : `s:${selection.position}`;
        const group = groups.get(key) ?? {
          path: workflowLevel
            ? pointer("agents", selection.action)
            : pointer("steps", selection.position, "agentVersionId"),
          selections: [],
        };
        group.selections.push(selection);
        groups.set(key, group);
      }
      const ordered = [...groups.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
      );
      for (const group of ordered) {
        if (errors.length >= MAX_ISSUES) break;
        try {
          await resolveAgentVersionSelections(
            transaction,
            organizationId,
            group.selections.map(toSelection),
          );
        } catch (error) {
          const mapped = bindingIssue(group.path, error);
          if (mapped === null) throw error;
          errors.push(mapped);
          if (STEP_POLICY_CODES.has(mapped.code)) {
            await attributePolicyToSteps(
              transaction,
              organizationId,
              group.selections,
              errors,
            );
          }
        }
      }
      return Object.freeze({
        errors: Object.freeze(errors),
        bindings: Object.freeze([]),
      });
    }
  }
  const bindings: WorkflowStepBindingReport[] = [
    ...selections.map((selection) => {
      const agent = resolved[selection.stepKey];
      return Object.freeze({
        stepId: selection.stepKey,
        action: selection.action,
        source: selection.source,
        agentVersionId: selection.agentVersionId,
        revision: agent?.revision ?? null,
        digest: agent?.digest ?? null,
        requiredCapabilities: Object.freeze([...selection.required]),
        modelBillingRequired: selection.required.includes("model"),
        position: selection.position,
      });
    }),
    ...unbound.map(({ step, required }) =>
      Object.freeze({
        stepId: step.key,
        action: step.action,
        source: "none" as const,
        agentVersionId: null,
        revision: null,
        digest: null,
        requiredCapabilities: Object.freeze([...required]),
        modelBillingRequired: required.includes("model"),
        position: step.position,
      })
    ),
  ].sort((a, b) => a.position - b.position).map(
    ({ position: _position, ...binding }) => Object.freeze(binding),
  );
  return Object.freeze({
    errors: Object.freeze(errors),
    bindings: Object.freeze(bindings),
  });
}
