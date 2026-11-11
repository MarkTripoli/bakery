import { createHash } from "node:crypto";
import { z } from "zod";
import { catalogActions, contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  INTEGRATION_SCOPE_OPERATIONS,
  type IntegrationScope,
  IntegrationScopeSchema,
  parseActionReference,
} from "@bakery/contracts/integrations";
import {
  type ActionContext,
  type BakeryOperation,
  deepFreeze,
  type DefinedAction,
  type DefinedIntegration,
  IntegrationActivationError,
  type IntegrationDefect,
  isDefinedIntegration,
  type ReconciliationContext,
  type RequestRef,
  validateIntegration,
} from "@bakery/integration-sdk";
import {
  assertHostProfile,
  getHostProfile,
  type HostAuthProfile,
} from "./integration-gate-profiles.ts";
import { markProviderFailure } from "./integration-provider-outcome.ts";

type PermissionLevel = "read" | "write";
const LEVEL_RANK: Record<PermissionLevel, number> = { read: 1, write: 2 };

/** Why a capability, feature or activation is not usable. Mirrors `IntegrationCapability.unavailableReason`. */
export const INTEGRATION_UNAVAILABLE_REASONS = [
  "resource_unselected",
  "bakery_scope_missing",
  "provider_permission_missing",
  "connection_disabled",
  "auth_required",
  "unsupported",
] as const;
export type IntegrationUnavailableReason =
  (typeof INTEGRATION_UNAVAILABLE_REASONS)[number];

export type ActiveAction = Readonly<{
  providerId: string;
  id: string;
  version: number;
  handler: DefinedAction;
  /** Transport effect: read only for `read` actions, write for every other effect. */
  effect: "read" | "write";
  resourceKind: string;
  providerPermissions: Readonly<Record<string, PermissionLevel>>;
}>;

export type ActiveIntegration = Readonly<{
  providerId: string;
  version: string;
  manifestDigest: string;
  profile: HostAuthProfile;
  definition: DefinedIntegration;
  actions: readonly ActiveAction[];
}>;

export type ActiveIntegrationRegistry = Readonly<{
  integrations: readonly ActiveIntegration[];
  get(providerId: string): ActiveIntegration | undefined;
  findAction(
    providerId: string,
    actionId: string,
    version: number,
  ): ActiveAction | undefined;
}>;

const activeRegistries = new WeakSet<object>();

/** True only for registries produced by `activateDeployedIntegrations`. */
export function isActiveRegistry(
  value: unknown,
): value is ActiveIntegrationRegistry {
  return typeof value === "object" && value !== null &&
    activeRegistries.has(value);
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Canonical JSON-safe form: zod schemas become JSON Schema, object keys are sorted. */
function canonicalValue(value: unknown): unknown {
  if (value instanceof z.ZodType) {
    return canonicalValue(z.toJSONSchema(value, { unrepresentable: "any" }));
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === "function") continue;
      out[key] = canonicalValue(child);
    }
    return out;
  }
  return value;
}

/** SHA-256 over the manifest and each handler's declared contract; installs pin this value. */
export function computeManifestDigest(definition: DefinedIntegration): string {
  const handlers: Record<string, unknown> = {};
  for (const key of sortedKeys(definition.handlers)) {
    const h = definition.handlers[key]!;
    handlers[key] = {
      input: h.input,
      output: h.output,
      effect: h.effect,
      resourceKind: h.resourceKind,
      requests: h.requests,
      reconcileRequests: h.reconcileRequests ?? [],
      providerPermissions: h.providerPermissions,
      resourceProjection: h.resourceProjection ?? [],
      maxOutputBytes: h.maxOutputBytes,
    };
  }
  const canonical = JSON.stringify(
    canonicalValue({ manifest: definition.manifest, handlers }),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

const refKey = (id: string, version: number) => `${id}@${version}`;

/**
 * Activates explicitly deployed natives. Fails closed: any defect in any
 * integration throws one `IntegrationActivationError` listing all of them.
 */
export function activateDeployedIntegrations(
  list: readonly unknown[],
  catalog: readonly { readonly action: string }[] = catalogActions,
): ActiveIntegrationRegistry {
  const defects: IntegrationDefect[] = [];
  const add = (code: string, path: string, message: string) =>
    defects.push({ code, path, message });
  const knownOperations = new Set(catalog.map((entry) => entry.action));
  const integrations: ActiveIntegration[] = [];
  const providerIds = new Set<string>();
  const actionRefs = new Set<string>();

  for (const [index, candidate] of list.entries()) {
    const at = `deployed[${index}]`;
    if (!isDefinedIntegration(candidate)) {
      add("integration-unbranded", at, "not created by defineIntegration");
      continue;
    }
    const { manifest } = candidate;
    const base = `deployed.${manifest.id}`;
    const revalidated = validateIntegration({
      manifest: candidate.manifest,
      handlers: candidate.handlers,
    });
    if (!revalidated.ok) {
      for (const d of revalidated.defects) {
        add(d.code, `${base}.${d.path}`, d.message);
      }
      continue;
    }
    const before = defects.length;
    if (providerIds.has(manifest.id)) {
      add("duplicate-provider", base, "provider id deployed twice");
    }
    providerIds.add(manifest.id);

    const profile = getHostProfile(manifest.authenticationProfile);
    if (!profile) {
      add(
        "unknown-profile",
        `${base}.authenticationProfile`,
        "authentication profile is not a host profile",
      );
      continue;
    }
    try {
      assertHostProfile(profile);
    } catch (error) {
      add("invalid-profile", `${base}.authenticationProfile`, String(error));
      continue;
    }

    const vocabulary = (
      path: string,
      permissions: Readonly<Record<string, PermissionLevel>>,
    ) => {
      for (const [name, level] of Object.entries(permissions)) {
        const allowed = Object.hasOwn(profile.providerPermissions, name)
          ? profile.providerPermissions[name]!
          : [];
        if (!allowed.includes(level)) {
          add(
            "permission-vocabulary",
            path,
            `${name}:${level} is outside the ${profile.id} vocabulary`,
          );
        }
      }
    };

    for (const kind of manifest.resourceKinds) {
      if (!Object.hasOwn(profile.resourceKinds, kind)) {
        add(
          "unknown-resource-kind",
          `${base}.resourceKinds`,
          `${kind} is not a ${profile.id} resource kind`,
        );
      }
    }
    for (const request of manifest.requests) {
      const path = `${base}.requests.${refKey(request.id, request.version)}`;
      vocabulary(path, request.providerPermissions);
      const kind = Object.hasOwn(profile.resourceKinds, request.resourceKind)
        ? profile.resourceKinds[request.resourceKind]
        : undefined;
      if (!kind) continue;
      const bindingKeys = Object.keys(kind.bindingSchema.shape);
      for (const [param, source] of Object.entries(request.pathParams)) {
        if (source.startsWith("binding:")) {
          const attribute = source.slice("binding:".length);
          if (!bindingKeys.includes(attribute)) {
            add(
              "unknown-binding-key",
              `${path}.pathParams.${param}`,
              `${attribute} is not a binding attribute of ${request.resourceKind}`,
            );
          }
        }
      }
    }
    for (const feature of manifest.optionalFeatures) {
      vocabulary(
        `${base}.optionalFeatures.${feature.id}`,
        feature.providerPermissions,
      );
    }
    for (
      const scope of [...manifest.bakery.required, ...manifest.bakery.optional]
    ) {
      for (const operation of INTEGRATION_SCOPE_OPERATIONS[scope]) {
        if (!knownOperations.has(operation)) {
          add(
            "unknown-operation",
            `${base}.bakery`,
            `${scope} maps to ${operation}, which is not a catalog action`,
          );
        }
      }
    }

    const actions: ActiveAction[] = [];
    for (const ref of manifest.actions) {
      const key = refKey(ref.id, ref.version);
      const path = `${base}.actions.${key}`;
      const handler = candidate.handlers[key]!;
      if (actionRefs.has(key)) {
        add("duplicate-action", path, "action reference deployed twice");
      }
      actionRefs.add(key);
      vocabulary(path, handler.providerPermissions);
      const kind = Object.hasOwn(profile.resourceKinds, handler.resourceKind)
        ? profile.resourceKinds[handler.resourceKind]
        : undefined;
      for (const attribute of handler.resourceProjection ?? []) {
        if (!kind?.projectable.includes(attribute)) {
          add(
            "projection-not-projectable",
            path,
            `${attribute} is not a projectable attribute of ${handler.resourceKind}`,
          );
        }
      }
      actions.push(Object.freeze({
        providerId: manifest.id,
        id: ref.id,
        version: ref.version,
        handler,
        effect: handler.effect === "read" ? "read" : "write",
        resourceKind: handler.resourceKind,
        providerPermissions: handler.providerPermissions,
      }));
    }
    if (defects.length === before) {
      integrations.push(Object.freeze({
        providerId: manifest.id,
        version: manifest.version,
        manifestDigest: computeManifestDigest(candidate),
        profile,
        definition: candidate,
        actions: Object.freeze(actions),
      }));
    }
  }
  if (defects.length) throw new IntegrationActivationError(defects);

  const byId = new Map(integrations.map((i) => [i.providerId, i]));
  const registry: ActiveIntegrationRegistry = Object.freeze({
    integrations: Object.freeze(integrations),
    get: (providerId: string) => byId.get(providerId),
    findAction: (providerId: string, actionId: string, version: number) =>
      byId.get(providerId)?.actions.find((a) =>
        a.id === actionId && a.version === version
      ),
  });
  activeRegistries.add(registry);
  return registry;
}

export type DiscoveredProvider = Readonly<{
  providerId: string;
  version: string;
  manifestDigest: string;
  authenticationProfile: string;
  resourceKinds: readonly string[];
  scopes: Readonly<{
    required: readonly IntegrationScope[];
    optional: readonly IntegrationScope[];
  }>;
  actions: readonly Readonly<{
    id: string;
    version: number;
    effect: "read" | "write";
  }>[];
  features: readonly Readonly<{ id: string; description: string }>[];
}>;

/** Lists activated providers. Static metadata only: no connection, grant or secret state. */
export function discoverProviders(
  registry: ActiveIntegrationRegistry,
): readonly DiscoveredProvider[] {
  if (!isActiveRegistry(registry)) throw new Error("registry is not active");
  return deepFreeze(registry.integrations.map((i) => ({
    providerId: i.providerId,
    version: i.version,
    manifestDigest: i.manifestDigest,
    authenticationProfile: i.profile.id,
    resourceKinds: [...i.definition.manifest.resourceKinds],
    scopes: {
      required: [...i.definition.manifest.bakery.required],
      optional: [...i.definition.manifest.bakery.optional],
    },
    actions: i.actions.map((a) => ({
      id: a.id,
      version: a.version,
      effect: a.effect,
    })),
    features: i.definition.manifest.optionalFeatures.map((f) => ({
      id: f.id,
      description: f.description,
    })),
  })));
}

export type GrantDirection = "into_bakery" | "out_of_bakery";

/**
 * Server-internal grant row: the `IntegrationGrantCreate` field names plus the
 * host fields the store adds. Never accepted from a client.
 */
export type IntegrationGrantRecord =
  & Omit<
    z.infer<(typeof contractSchemas)["IntegrationGrantCreate"]>,
    "expiresAt"
  >
  & Readonly<{
    grantId: string;
    organizationId: string;
    connectionId: string;
    expiresAt?: string | null;
    revokedAt: string | null;
    policyRevision: number;
  }>;

export type AuthoritySnapshot = Readonly<{
  organizationId: string;
  actor: Readonly<{
    principalId: string;
    subjectType: "principal" | "automation";
    automationDefinitionId?: string;
    active: boolean;
    membershipRoleKey?: string;
    permissions: readonly string[];
  }>;
  install: Readonly<{
    id: string;
    providerId: string;
    manifestDigest: string;
    enabled: boolean;
    approvedScopes: readonly IntegrationScope[];
  }>;
  connection: Readonly<{
    id: string;
    installId: string;
    state: "active" | "reconnect_required" | "disabled";
    providerPermissions: Readonly<Record<string, PermissionLevel>>;
  }>;
  resource: Readonly<{
    id: string;
    kind: string;
    selected: boolean;
    available: boolean;
    binding: Readonly<Record<string, unknown>>;
    applicationId?: string;
    repositoryId?: string;
  }>;
  grants: readonly IntegrationGrantRecord[];
  policyRevision: number;
}>;

export type SnapshotKey = Readonly<{
  organizationId: string;
  actorRef: string;
  connectionId: string;
  resourceId: string;
}>;

/** Loads fresh authority from the store. Callers never cache the result across checks. */
export type AuthoritySnapshotPort = {
  load(key: SnapshotKey): Promise<AuthoritySnapshot | null>;
};

/**
 * True when the grant is a live, exact out-of-bakery grant for this actor,
 * action version, connection and resource. Equality only; any malformed
 * capability never matches.
 */
export function grantAllowsAction(
  grant: IntegrationGrantRecord,
  snapshot: AuthoritySnapshot,
  actionId: string,
  version: number,
  now: Date,
): boolean {
  const parsed = parseGrantCapability(grant);
  if (
    parsed?.direction !== "out_of_bakery" || parsed.actionId !== actionId ||
    parsed.version !== version
  ) return false;
  if (
    grant.organizationId !== snapshot.organizationId ||
    grant.connectionId !== snapshot.connection.id ||
    grant.resourceId !== snapshot.resource.id
  ) return false;
  if (!grantIsLive(grant, now)) return false;
  return grantSubjectMatches(grant, snapshot.actor);
}

type SnapshotActor = AuthoritySnapshot["actor"];

/** Plain equality of the grant subject against the live actor; role keys stay opaque. */
function grantSubjectMatches(
  grant: IntegrationGrantRecord,
  actor: SnapshotActor,
): boolean {
  if (grant.subjectType === "principal") {
    return actor.subjectType === "principal" &&
      grant.subjectPrincipalId !== undefined &&
      grant.subjectPrincipalId === actor.principalId;
  }
  if (grant.subjectType === "automation") {
    return actor.subjectType === "automation" &&
      grant.automationDefinitionId !== undefined &&
      grant.automationDefinitionId === actor.automationDefinitionId;
  }
  if (grant.subjectType === "organization_role") {
    return actor.subjectType === "principal" &&
      actor.membershipRoleKey !== undefined &&
      grant.subjectRole === actor.membershipRoleKey;
  }
  return false;
}

function grantIsLive(grant: IntegrationGrantRecord, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt === undefined || grant.expiresAt === null) return true;
  const expires = Date.parse(grant.expiresAt);
  // A non-finite expiry is treated as already expired.
  return Number.isFinite(expires) && expires > now.getTime();
}

export type ParsedGrantCapability =
  | Readonly<{
    direction: "out_of_bakery";
    actionId: string;
    version: number;
  }>
  | Readonly<{
    direction: "into_bakery";
    scope: IntegrationScope;
    target: Readonly<{ applicationId: string } | { repositoryId: string }>;
  }>;

/**
 * Strict grammar for a grant row. out_of_bakery: a bare action id plus an
 * explicit version and resource. into_bakery: exactly one scope and exactly
 * one internal target, no version. Wildcards, families, `@` suffixes and
 * `latest` never parse, so such a row can never match.
 */
export function parseGrantCapability(
  grant: IntegrationGrantRecord,
): ParsedGrantCapability | null {
  if (grant.direction === "out_of_bakery") {
    if (
      !grant.actionVersion || !grant.resourceId ||
      grant.applicationId || grant.repositoryId
    ) return null;
    const reference = parseActionReference(
      `${grant.capability}@${grant.actionVersion}`,
    );
    if (!reference || reference.id !== grant.capability) return null;
    return {
      direction: "out_of_bakery",
      actionId: reference.id,
      version: reference.version,
    };
  }
  if (grant.direction === "into_bakery") {
    const scope = IntegrationScopeSchema.safeParse(grant.capability);
    if (!scope.success || grant.actionVersion || grant.resourceId) return null;
    const hasApp = Boolean(grant.applicationId);
    const hasRepo = Boolean(grant.repositoryId);
    if (hasApp === hasRepo) return null;
    return {
      direction: "into_bakery",
      scope: scope.data,
      target: hasApp
        ? { applicationId: grant.applicationId! }
        : { repositoryId: grant.repositoryId! },
    };
  }
  return null;
}

export type ScopeReport = Readonly<{
  scope: IntegrationScope;
  requirement: "required" | "optional";
  status: "approved" | "missing";
}>;
export type FeatureReport = Readonly<{
  id: string;
  status: "available" | "unsupported";
  reason: IntegrationUnavailableReason | null;
}>;
export type CapabilityEntry = z.infer<
  (typeof contractSchemas)["IntegrationCapability"]
>;
export type ConnectionCapabilityReport = Readonly<{
  providerId: string;
  providerVersion: string;
  manifestDigest: string;
  activation: "ready" | "blocked";
  blockedReason: IntegrationUnavailableReason | null;
  scopes: readonly ScopeReport[];
  features: readonly FeatureReport[];
  actions: readonly CapabilityEntry[];
}>;

export function permissionsMet(
  held: Readonly<Record<string, PermissionLevel>>,
  needed: Readonly<Record<string, PermissionLevel>>,
): boolean {
  return Object.entries(needed).every(([name, level]) => {
    const have = Object.hasOwn(held, name) ? held[name] : undefined;
    return have !== undefined && LEVEL_RANK[have] >= LEVEL_RANK[level];
  });
}

type ConnectionAssessment = Readonly<{
  scopes: readonly ScopeReport[];
  blockedReason: IntegrationUnavailableReason | null;
  features: readonly FeatureReport[];
}>;

/** Connection-wide state shared by the capability report and invocation authorization. */
function assessConnection(
  provider: ActiveIntegration,
  snapshot: AuthoritySnapshot,
): ConnectionAssessment {
  const manifest = provider.definition.manifest;
  const approved = new Set<string>(snapshot.install.approvedScopes);
  const scopes: ScopeReport[] = [
    ...manifest.bakery.required.map((scope) => ({
      scope,
      requirement: "required" as const,
      status: approved.has(scope) ? "approved" as const : "missing" as const,
    })),
    ...manifest.bakery.optional.map((scope) => ({
      scope,
      requirement: "optional" as const,
      status: approved.has(scope) ? "approved" as const : "missing" as const,
    })),
  ];

  let blockedReason: IntegrationUnavailableReason | null = null;
  if (!snapshot.install.enabled || snapshot.connection.state === "disabled") {
    blockedReason = "connection_disabled";
  } else if (snapshot.connection.state === "reconnect_required") {
    blockedReason = "auth_required";
  } else if (
    snapshot.install.manifestDigest !== provider.manifestDigest ||
    snapshot.connection.installId !== snapshot.install.id
  ) {
    blockedReason = "unsupported";
  } else if (
    scopes.some((s) => s.requirement === "required" && s.status === "missing")
  ) {
    blockedReason = "bakery_scope_missing";
  }

  const features: FeatureReport[] = manifest.optionalFeatures.map((feature) => {
    let reason: IntegrationUnavailableReason | null = null;
    if (feature.scopes.some((scope) => !approved.has(scope))) {
      reason = "bakery_scope_missing";
    } else if (
      !permissionsMet(
        snapshot.connection.providerPermissions,
        feature.providerPermissions,
      )
    ) reason = "provider_permission_missing";
    return {
      id: feature.id,
      status: reason ? "unsupported" as const : "available" as const,
      reason,
    };
  });
  return { scopes, blockedReason, features };
}

/** Why one action cannot run on this snapshot, or null when it can. */
function actionUnavailableReason(
  provider: ActiveIntegration,
  action: ActiveAction,
  snapshot: AuthoritySnapshot,
  assessment: ConnectionAssessment,
): IntegrationUnavailableReason | null {
  if (assessment.blockedReason) return assessment.blockedReason;
  if (
    !snapshot.resource.selected || !snapshot.resource.available ||
    snapshot.resource.kind !== action.resourceKind
  ) return "resource_unselected";
  if (
    !permissionsMet(
      snapshot.connection.providerPermissions,
      action.providerPermissions,
    )
  ) return "provider_permission_missing";
  const gating = provider.definition.manifest.optionalFeatures
    .map((feature, i) => ({ feature, report: assessment.features[i]! }))
    .filter(({ feature }) =>
      feature.actions.some((a) =>
        a.id === action.id && a.version === action.version
      )
    );
  if (gating.length && gating.every((g) => g.report.reason !== null)) {
    return gating[0]!.report.reason;
  }
  return null;
}

/**
 * Effective capabilities for one actor on one connection and resource. Reloads
 * the snapshot on every call. Unsupported features and actions stay listed with
 * an explicit reason; nothing is silently omitted.
 */
export async function computeConnectionCapabilities(
  registry: ActiveIntegrationRegistry,
  port: AuthoritySnapshotPort,
  key: SnapshotKey,
  options: { now?: Date } = {},
): Promise<ConnectionCapabilityReport> {
  if (!isActiveRegistry(registry)) throw new Error("registry is not active");
  const snapshot = await port.load(key);
  if (
    !snapshot || snapshot.organizationId !== key.organizationId ||
    snapshot.connection.id !== key.connectionId ||
    snapshot.resource.id !== key.resourceId ||
    (snapshot.actor.principalId !== key.actorRef &&
      snapshot.actor.automationDefinitionId !== key.actorRef)
  ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const provider = registry.get(snapshot.install.providerId);
  if (!provider) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const now = options.now ?? new Date();
  const assessment = assessConnection(provider, snapshot);
  const { scopes, blockedReason, features } = assessment;
  // Same liveness and permission gate as evaluateInvocation.
  const actorMayInvoke = snapshot.actor.active &&
    snapshot.actor.permissions.includes("integrationConnection:invoke");

  const actions: CapabilityEntry[] = provider.actions.map((action) => {
    const reason = actionUnavailableReason(
      provider,
      action,
      snapshot,
      assessment,
    );
    const required = Object.entries(action.providerPermissions).map(
      ([name, level]) => `${name}:${level}`,
    );
    return contractSchemas.IntegrationCapability.parse({
      actionId: action.id,
      actionVersion: action.version,
      effect: action.effect,
      resourceKinds: [action.resourceKind],
      inputSchema: z.toJSONSchema(action.handler.input, {
        unrepresentable: "any",
        io: "input",
      }),
      outputSchema: z.toJSONSchema(action.handler.output, {
        unrepresentable: "any",
        io: "output",
      }),
      requiredProviderPermissions: required,
      granted: actorMayInvoke &&
        snapshot.grants.some((grant) =>
          grantAllowsAction(grant, snapshot, action.id, action.version, now)
        ),
      available: actorMayInvoke && reason === null,
      unavailableReason: reason,
    }) as CapabilityEntry;
  });

  return deepFreeze({
    providerId: provider.providerId,
    providerVersion: provider.version,
    manifestDigest: provider.manifestDigest,
    activation: blockedReason ? "blocked" as const : "ready" as const,
    blockedReason,
    scopes,
    features,
    actions,
  });
}

/** Reasons an invocation can hit `STATE_CONFLICT`: the report reasons plus an incomplete resource binding. */
export const INTEGRATION_CONFLICT_REASONS = [
  ...INTEGRATION_UNAVAILABLE_REASONS,
  "resource_binding_incomplete",
] as const;
export type IntegrationConflictReason =
  (typeof INTEGRATION_CONFLICT_REASONS)[number];

const notFound = () => new StandardError({ code: "RESOURCE_NOT_FOUND" });
const forbidden = () => new StandardError({ code: "AUTH_FORBIDDEN" });
const unprocessable = (detail: string) =>
  new StandardError({ code: "UNPROCESSABLE", detail });
const conflict = (reason: IntegrationConflictReason) =>
  new StandardError({
    code: "STATE_CONFLICT",
    detail: reason,
    params: { reason },
  });

/** Host-only facts about one invocation; the client supplies none of them. */
export type InvocationEnvelope = Readonly<{
  organizationId: string;
  actorRef: string;
  connectionId: string;
  effectId: string;
}>;

export type InternalTarget = Readonly<
  { applicationId: string } | { repositoryId: string }
>;

/** Result of a successful `authorizeInvocation`: everything the contexts and broker bind to. */
export type BoundInvocation = Readonly<{
  organizationId: string;
  actor: Readonly<{
    principalId: string;
    subjectType: "principal" | "automation";
    automationDefinitionId?: string;
  }>;
  actorRef: string;
  providerId: string;
  installId: string;
  connectionId: string;
  resource: Readonly<{
    id: string;
    kind: string;
    binding: Readonly<Record<string, unknown>>;
    applicationId?: string;
    repositoryId?: string;
  }>;
  grantId: string;
  policyRevision: number;
  manifestDigest: string;
  actionRef: Readonly<{ id: string; version: number }>;
  effectId: string;
}>;

export type Evaluation = Readonly<{
  snapshot: AuthoritySnapshot;
  provider: ActiveIntegration;
  action: ActiveAction;
  binding: Readonly<Record<string, unknown>>;
  grant: IntegrationGrantRecord;
}>;

/**
 * Applies the invocation error table in order against a freshly loaded
 * snapshot. Shared by the first authorization and every later recheck.
 */
async function evaluateInvocation(
  registry: ActiveIntegrationRegistry,
  port: AuthoritySnapshotPort,
  key: SnapshotKey,
  ref: Readonly<{ id: string; version: number }>,
  now: Date,
): Promise<Evaluation> {
  if (!isActiveRegistry(registry)) throw new Error("registry is not active");
  const snapshot = await port.load(key);
  if (
    !snapshot || snapshot.organizationId !== key.organizationId ||
    snapshot.connection.id !== key.connectionId ||
    snapshot.resource.id !== key.resourceId ||
    (snapshot.actor.principalId !== key.actorRef &&
      snapshot.actor.automationDefinitionId !== key.actorRef)
  ) throw notFound();
  const provider = registry.get(snapshot.install.providerId);
  const action = provider?.actions.find((a) =>
    a.id === ref.id && a.version === ref.version
  );
  if (!provider || !action) throw notFound();
  if (snapshot.resource.kind !== action.resourceKind) throw notFound();

  if (
    !snapshot.actor.active ||
    !snapshot.actor.permissions.includes("integrationConnection:invoke")
  ) throw forbidden();

  const assessment = assessConnection(provider, snapshot);
  const reason = actionUnavailableReason(
    provider,
    action,
    snapshot,
    assessment,
  );
  if (reason) throw conflict(reason);
  const kind =
    Object.hasOwn(provider.profile.resourceKinds, action.resourceKind)
      ? provider.profile.resourceKinds[action.resourceKind]
      : undefined;
  const binding = kind?.bindingSchema.safeParse(snapshot.resource.binding);
  if (!binding?.success) throw conflict("resource_binding_incomplete");

  const grant = snapshot.grants.find((g) =>
    grantAllowsAction(g, snapshot, ref.id, ref.version, now)
  );
  if (!grant) {
    const otherVersion = snapshot.grants.some((g) => {
      const parsed = parseGrantCapability(g);
      return parsed?.direction === "out_of_bakery" &&
        parsed.actionId === ref.id && parsed.version !== ref.version &&
        grantAllowsAction(g, snapshot, parsed.actionId, parsed.version, now);
    });
    throw otherVersion
      ? new StandardError({ code: "PRECONDITION_FAILED" })
      : forbidden();
  }
  return { snapshot, provider, action, binding: binding.data, grant };
}

/** Denies when the live actor, install or manifest differs from what the invocation was bound to. */
export function assertNoDrift(
  snapshot: AuthoritySnapshot,
  provider: ActiveIntegration,
  bound: BoundInvocation,
): void {
  if (
    snapshot.actor.principalId !== bound.actor.principalId ||
    snapshot.install.id !== bound.installId ||
    provider.manifestDigest !== bound.manifestDigest
  ) throw forbidden();
}

/**
 * Re-runs the full error table for an already bound invocation against a
 * freshly loaded snapshot. The broker calls this before every provider
 * request so a revocation between calls denies the next one.
 */
export function reauthorizeBound(
  registry: ActiveIntegrationRegistry,
  port: AuthoritySnapshotPort,
  bound: BoundInvocation,
  now: Date = new Date(),
): Promise<Evaluation> {
  return evaluateInvocation(
    registry,
    port,
    snapshotKeyOf(bound),
    bound.actionRef,
    now,
  );
}

function snapshotKeyOf(bound: BoundInvocation): SnapshotKey {
  return {
    organizationId: bound.organizationId,
    actorRef: bound.actorRef,
    connectionId: bound.connectionId,
    resourceId: bound.resource.id,
  };
}

const EffectIdSchema = z.uuid().describe(
  "Host-minted effect identifier for one invocation attempt; must be a UUID.",
);

/**
 * Authorizes one invocation. The snapshot is reloaded here and nowhere
 * cached. Returns the frozen binding the contexts and broker use; the
 * arguments are validated against the exact action version last.
 */
export async function authorizeInvocation(
  registry: ActiveIntegrationRegistry,
  port: AuthoritySnapshotPort,
  envelope: InvocationEnvelope,
  rawInput: unknown,
  options: { now?: Date } = {},
): Promise<BoundInvocation> {
  const input = contractSchemas.IntegrationActionInput.safeParse(rawInput);
  if (!input.success) throw unprocessable("invalid invocation input");
  const effectId = EffectIdSchema.safeParse(envelope.effectId);
  if (!effectId.success) throw unprocessable("invalid effect id");
  const { actionId, actionVersion, resourceId } = input.data;
  const { snapshot, provider, action, binding, grant } =
    await evaluateInvocation(
      registry,
      port,
      {
        organizationId: envelope.organizationId,
        actorRef: envelope.actorRef,
        connectionId: envelope.connectionId,
        resourceId,
      },
      { id: actionId, version: actionVersion },
      options.now ?? new Date(),
    );
  if (!action.handler.input.safeParse(input.data.arguments).success) {
    throw unprocessable("invalid action arguments");
  }
  const resource = snapshot.resource;
  return deepFreeze({
    organizationId: snapshot.organizationId,
    actor: {
      principalId: snapshot.actor.principalId,
      subjectType: snapshot.actor.subjectType,
      ...(snapshot.actor.automationDefinitionId === undefined
        ? {}
        : { automationDefinitionId: snapshot.actor.automationDefinitionId }),
    },
    actorRef: envelope.actorRef,
    providerId: provider.providerId,
    installId: snapshot.install.id,
    connectionId: snapshot.connection.id,
    resource: {
      id: resource.id,
      kind: resource.kind,
      binding: structuredClone(binding),
      ...(resource.applicationId === undefined
        ? {}
        : { applicationId: resource.applicationId }),
      ...(resource.repositoryId === undefined
        ? {}
        : { repositoryId: resource.repositoryId }),
    },
    grantId: grant.grantId,
    policyRevision: snapshot.policyRevision,
    manifestDigest: provider.manifestDigest,
    actionRef: { id: action.id, version: action.version },
    effectId: effectId.data,
  });
}

/** Operations `bakery.call` refuses even with a scope and a grant. */
export const BAKERY_CALL_DENIED_OPERATIONS: readonly string[] = Object.freeze([
  "integrationConnections.invoke",
]);

/** The only Bakery operations an `effect: "read"` action may call. */
export const BAKERY_READ_OPERATIONS: readonly string[] = Object.freeze([
  "tasks.get",
  "tasks.list",
  "conversations.get",
  "conversations.list",
  "messages.list",
  "artifacts.get",
  "artifacts.list",
]);

export type BakeryOperationRequest = Readonly<{
  organizationId: string;
  actor: BoundInvocation["actor"];
  effectId: string;
  installId: string;
  connectionId: string;
  target: InternalTarget;
  operation: BakeryOperation;
  input: unknown;
}>;

/** Dispatches an already authorized Bakery operation. */
export type BakeryOperationPort = {
  call(request: BakeryOperationRequest): Promise<unknown>;
};

/** Default port: every operation is denied until a real dispatcher is wired. */
export const denyAllBakeryOperations: BakeryOperationPort = Object.freeze({
  call: () => Promise.reject(forbidden()),
});

/** Executes a template-bound provider request for an authorized invocation. The provider broker implements it. */
export type ProviderRequestPort = {
  /** `allowed` is the host-built set the calling context may use; the broker defaults to the action's execute requests. */
  request(
    bound: BoundInvocation,
    ref: RequestRef,
    input: unknown,
    allowed?: readonly Readonly<{ id: string; version: number }>[],
    signal?: AbortSignal,
  ): Promise<unknown>;
};

/** Default port: no provider request leaves the process. */
export const denyAllProviderRequests: ProviderRequestPort = Object.freeze({
  request: () =>
    Promise.reject(
      markProviderFailure(forbidden(), { kind: "not_sent", retryable: false }),
    ),
});

export type ContextDeps = Readonly<{
  registry: ActiveIntegrationRegistry;
  snapshots: AuthoritySnapshotPort;
  providerRequests?: ProviderRequestPort;
  bakeryOperations?: BakeryOperationPort;
  signal?: AbortSignal;
  now?: () => Date;
  catalog?: readonly {
    readonly action: string;
    readonly permission: string | null;
  }[];
}>;

const frozenNull = <T extends object>(value: T): T =>
  Object.freeze(Object.assign(Object.create(null), value)) as T;

function activeActionOf(
  deps: ContextDeps,
  bound: BoundInvocation,
): ActiveAction {
  const action = deps.registry.findAction(
    bound.providerId,
    bound.actionRef.id,
    bound.actionRef.version,
  );
  if (!action) throw notFound();
  return action;
}

function projectionOf(
  action: ActiveAction,
  bound: BoundInvocation,
): ActionContext["resource"] {
  const projection: Record<string, unknown> = { kind: bound.resource.kind };
  for (const attribute of action.handler.resourceProjection ?? []) {
    if (Object.hasOwn(bound.resource.binding, attribute)) {
      projection[attribute] = bound.resource.binding[attribute];
    }
  }
  return deepFreeze(frozenNull(projection)) as ActionContext["resource"];
}

function providerPort(
  deps: ContextDeps,
  bound: BoundInvocation,
  allowed: readonly Readonly<{ id: string; version: number }>[],
): ActionContext["provider"] {
  const requests = deps.providerRequests ?? denyAllProviderRequests;
  return frozenNull({
    request(ref: RequestRef, input: unknown): Promise<unknown> {
      if (
        typeof ref !== "object" || ref === null ||
        !allowed.some((a) => a.id === ref.id && a.version === ref.version)
      ) return Promise.reject(unprocessable("undeclared request reference"));
      return requests.request(
        bound,
        { id: ref.id, version: ref.version },
        input,
        allowed,
        deps.signal,
      );
    },
  });
}

/** Context for `execute`: exactly signal, bakery, provider, effect and resource. */
export function createActionContext(
  bound: BoundInvocation,
  deps: ContextDeps,
): ActionContext {
  const action = activeActionOf(deps, bound);
  return frozenNull({
    signal: deps.signal ?? new AbortController().signal,
    bakery: frozenNull({
      call: (operation: BakeryOperation, input: unknown) =>
        bakeryCall(deps, bound, operation, input),
    }),
    provider: providerPort(deps, bound, action.handler.requests),
    effect: deepFreeze({ id: bound.effectId }),
    resource: projectionOf(action, bound),
  });
}

/** Context for recovery: read-only provider access, the original input, and no `bakery`. */
export function createReconciliationContext<I = unknown>(
  bound: BoundInvocation,
  input: unknown,
  deps: ContextDeps,
): ReconciliationContext<I> {
  const action = activeActionOf(deps, bound);
  const parsed = action.handler.input.safeParse(input);
  if (!parsed.success) throw unprocessable("invalid reconciliation input");
  return frozenNull({
    signal: deps.signal ?? new AbortController().signal,
    provider: providerPort(deps, bound, action.handler.reconcileRequests ?? []),
    effect: deepFreeze({ id: bound.effectId }),
    input: deepFreeze(structuredClone(parsed.data)) as Readonly<I>,
    resource: projectionOf(action, bound),
  });
}

/**
 * `bakery.call`: reload the snapshot, recheck the invocation, then require a
 * mapped, approved scope, a target-matched into_bakery grant and the catalog
 * permission before the port sees the call.
 */
async function bakeryCall(
  deps: ContextDeps,
  bound: BoundInvocation,
  operation: BakeryOperation,
  input: unknown,
): Promise<unknown> {
  const now = (deps.now ?? (() => new Date()))();
  const { snapshot, provider } = await evaluateInvocation(
    deps.registry,
    deps.snapshots,
    snapshotKeyOf(bound),
    bound.actionRef,
    now,
  );
  assertNoDrift(snapshot, provider, bound);
  if (
    typeof operation !== "string" ||
    BAKERY_CALL_DENIED_OPERATIONS.includes(operation)
  ) throw forbidden();
  // A read action may never reach a mutating Bakery operation.
  const boundAction = provider.actions.find((a) =>
    a.id === bound.actionRef.id && a.version === bound.actionRef.version
  );
  if (
    !boundAction ||
    (boundAction.effect === "read" &&
      !BAKERY_READ_OPERATIONS.includes(operation))
  ) throw forbidden();

  const manifest = provider.definition.manifest;
  const approved = new Set<string>(snapshot.install.approvedScopes);
  const scopes = [...manifest.bakery.required, ...manifest.bakery.optional]
    .filter((scope) =>
      approved.has(scope) &&
      (INTEGRATION_SCOPE_OPERATIONS[scope] as readonly string[]).includes(
        operation,
      )
    );
  const resource = snapshot.resource;
  // Dispatch only the target of the grant that matched, never a wider one.
  const grantTargetFor = (scope: IntegrationScope): InternalTarget | null => {
    for (const grant of snapshot.grants) {
      const parsed = parseGrantCapability(grant);
      if (parsed?.direction !== "into_bakery" || parsed.scope !== scope) {
        continue;
      }
      if (
        grant.organizationId !== snapshot.organizationId ||
        grant.connectionId !== snapshot.connection.id ||
        !grantIsLive(grant, now) ||
        !grantSubjectMatches(grant, snapshot.actor)
      ) continue;
      if ("applicationId" in parsed.target) {
        if (
          resource.applicationId !== undefined &&
          parsed.target.applicationId === resource.applicationId
        ) return { applicationId: parsed.target.applicationId };
      } else if (
        resource.repositoryId !== undefined &&
        parsed.target.repositoryId === resource.repositoryId
      ) return { repositoryId: parsed.target.repositoryId };
    }
    return null;
  };
  let target: InternalTarget | null = null;
  for (const scope of scopes) {
    target = grantTargetFor(scope);
    if (target) break;
  }
  if (!target) throw forbidden();

  const catalog = deps.catalog ?? catalogActions;
  const permission = catalog.find((entry) => entry.action === operation)
    ?.permission;
  if (!permission || !snapshot.actor.permissions.includes(permission)) {
    throw forbidden();
  }
  return await (deps.bakeryOperations ?? denyAllBakeryOperations).call({
    organizationId: snapshot.organizationId,
    actor: bound.actor,
    effectId: bound.effectId,
    installId: bound.installId,
    connectionId: bound.connectionId,
    target,
    operation,
    input,
  });
}
