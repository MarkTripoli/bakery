import { integrationManifestSchema } from "./manifest.ts";
import type { IntegrationManifest } from "./manifest.ts";
import type { RequestTemplate } from "./request.ts";
import { isStrictObject } from "./request.ts";
import { findSchemaDescriptionDefects } from "./descriptions.ts";
import { isDefinedAction } from "./action.ts";
import type { DefinedAction, ExactRef } from "./action.ts";
import { IntegrationActivationError } from "./errors.ts";
import type { IntegrationDefect } from "./errors.ts";

export const SUPPORTED_SDK_VERSIONS: readonly number[] = [1];

export type IntegrationHandlers = Readonly<Record<string, DefinedAction>>;
export type IntegrationDefinitionInput = {
  manifest: unknown;
  handlers: IntegrationHandlers;
};
export type DefinedIntegration = Readonly<{
  manifest: IntegrationManifest;
  handlers: IntegrationHandlers;
}>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; defects: readonly IntegrationDefect[] };

const key = (r: ExactRef) => `${r.id}@${r.version}`;
const rank = { read: 1, write: 2 } as const;

/** Pure activation parity check; collects every defect instead of stopping at the first. */
export function validateIntegration(
  definition: IntegrationDefinitionInput,
): ValidationResult {
  const defects: IntegrationDefect[] = [];
  const add = (code: string, path: string, message: string) =>
    defects.push({ code, path, message });

  const parsed = integrationManifestSchema.safeParse(definition.manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add(
        "manifest-invalid",
        `manifest.${issue.path.join(".")}`,
        issue.message,
      );
    }
    return { ok: false, defects };
  }
  const manifest = parsed.data;
  if (!SUPPORTED_SDK_VERSIONS.includes(manifest.sdkVersion)) {
    add("sdk-version", "manifest.sdkVersion", "unsupported sdkVersion");
  }

  const templates = new Map<string, RequestTemplate>(
    manifest.requests.map((t) => [key(t), t]),
  );
  for (const t of manifest.requests) {
    const base = `request ${key(t)}`;
    const schemas: [string, unknown][] = [
      ["input", t.input],
      ["response", t.response],
      ...(t.body ? [["body", t.body] as [string, unknown]] : []),
    ];
    for (const [name, schema] of schemas) {
      for (const d of findSchemaDescriptionDefects(schema, `${base}.${name}`)) {
        add(
          `description-${d.kind}`,
          d.path,
          "schema node lacks a meaningful description",
        );
      }
    }
  }

  const declared = new Set(manifest.actions.map(key));
  for (const k of declared) {
    if (!Object.hasOwn(definition.handlers, k)) {
      add("missing-handler", `handlers.${k}`, "declared action has no handler");
    }
  }
  for (const [k, handler] of Object.entries(definition.handlers)) {
    const path = `handlers.${k}`;
    if (!isDefinedAction(handler)) {
      add("handler-unbranded", path, "handler was not created by defineAction");
      continue;
    }
    if (!declared.has(k)) {
      add(
        "undeclared-handler",
        path,
        "handler is not declared in manifest actions",
      );
    }
    if (key(handler) !== k) {
      add("handler-version-mismatch", path, `handler is ${key(handler)}`);
    }
    if (!manifest.resourceKinds.includes(handler.resourceKind)) {
      add("resource-kind", path, "action resource kind is not declared");
    }
    if (!isStrictObject(handler.input)) {
      add("input-not-strict", path, "action input root must be z.strictObject");
    }
    for (
      const [name, schema] of [["input", handler.input], [
        "output",
        handler.output,
      ]] as const
    ) {
      for (const d of findSchemaDescriptionDefects(schema, `${path}.${name}`)) {
        add(
          `description-${d.kind}`,
          d.path,
          "schema node lacks a meaningful description",
        );
      }
    }

    const resolve = (refs: readonly ExactRef[], label: string) => {
      const out: RequestTemplate[] = [];
      for (const ref of refs) {
        const t = templates.get(key(ref));
        if (!t) {
          add(
            "undeclared-request",
            path,
            `${label} ${key(ref)} is not declared`,
          );
        } else {
          if (t.resourceKind !== handler.resourceKind) {
            add(
              "request-resource-kind",
              path,
              `${label} ${key(ref)} uses another resource kind`,
            );
          }
          out.push(t);
        }
      }
      return out;
    };
    const used = resolve(handler.requests, "request");
    const recovery = resolve(
      handler.reconcileRequests ?? [],
      "reconcile request",
    );

    if (handler.effect === "read") {
      if (used.some((t) => t.effect !== "read")) {
        add("effect-parity", path, "read action uses a non-read request");
      }
    } else if (handler.effect === "native-idempotent") {
      if (used.some((t) => t.effect === "write" && !t.idempotent)) {
        add(
          "effect-parity",
          path,
          "native-idempotent action uses a non-idempotent write",
        );
      }
    }
    const hasReconcile = typeof handler.reconcile === "function";
    if (handler.effect === "reconcile") {
      if (!hasReconcile) {
        add(
          "reconcile-handler",
          path,
          "reconcile effect needs a reconcile handler",
        );
      }
      if (recovery.length === 0) {
        add(
          "reconcile-requests",
          path,
          "reconcile effect needs reconcileRequests",
        );
      }
    } else {
      if (hasReconcile) {
        add(
          "reconcile-handler",
          path,
          "reconcile handler on a non-reconcile action",
        );
      }
      if (recovery.length) {
        add(
          "reconcile-requests",
          path,
          "reconcileRequests on a non-reconcile action",
        );
      }
    }
    if (recovery.some((t) => t.effect !== "read")) {
      add("effect-parity", path, "reconcile requests must be read-only");
    }

    for (const t of [...used, ...recovery]) {
      for (const [perm, level] of Object.entries(t.providerPermissions)) {
        const have = handler.providerPermissions[perm];
        if (!have || rank[have] < rank[level]) {
          add(
            "provider-permissions",
            path,
            `action lacks ${perm}:${level} required by ${key(t)}`,
          );
        }
      }
    }
  }
  return defects.length ? { ok: false, defects } : { ok: true };
}

const definedIntegrations = new WeakSet<object>();

/** True only for values produced by `defineIntegration`. */
export function isDefinedIntegration(
  value: unknown,
): value is DefinedIntegration {
  return typeof value === "object" && value !== null &&
    definedIntegrations.has(value);
}

/** Validates, then brands. Throws IntegrationActivationError listing every defect. */
export function defineIntegration(
  manifest: unknown,
  handlers: IntegrationHandlers,
): DefinedIntegration {
  const result = validateIntegration({ manifest, handlers });
  if (!result.ok) throw new IntegrationActivationError(result.defects);
  const defined: DefinedIntegration = Object.freeze({
    manifest: integrationManifestSchema.parse(manifest),
    handlers: Object.freeze({ ...handlers }),
  });
  definedIntegrations.add(defined);
  return defined;
}
