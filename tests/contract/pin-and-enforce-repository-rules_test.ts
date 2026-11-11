import { assert, assertEquals } from "@std/assert";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";

type JsonSchemaNode = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
};

const generated = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../packages/contracts/generated/contracts.json",
      import.meta.url,
    ),
  ),
);

/** Every generated object that declares the frozen execution context. */
function executionContexts(): Array<[string, JsonSchemaNode]> {
  const found: Array<[string, JsonSchemaNode]> = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as JsonSchemaNode & Record<string, unknown>;
    if (record.properties && "fixedPolicyDigest" in record.properties) {
      found.push([path, record]);
    }
    for (const [key, child] of Object.entries(record)) {
      walk(child, `${path}/${key}`);
    }
  };
  walk(generated, "");
  return found;
}

Deno.test("every generated execution context carries an optional, described rules pin", () => {
  const contexts = executionContexts();
  assert(contexts.length > 0);
  for (const [path, context] of contexts) {
    const pin = context.properties?.repositoryRules;
    assert(pin, `${path} lacks repositoryRules`);
    // Optional: snapshots admitted before pinning must stay readable.
    assert(!context.required?.includes("repositoryRules"), path);
    assertEquals(pin.type, "object", path);
    assertEquals(pin.additionalProperties, false, path);
    assertEquals(
      Object.keys(pin.properties ?? {}).sort(),
      [
        "digest",
        "entries",
        "organizationRevision",
        "profileId",
        "profileRevision",
      ],
      path,
    );
    assertEquals([...(pin.required ?? [])].sort(), [
      "digest",
      "entries",
      "organizationRevision",
      "profileId",
      "profileRevision",
    ], path);
    assertEquals(descriptionDefectKind(pin.description, path), undefined);
    for (const [name, child] of Object.entries(pin.properties ?? {})) {
      assertEquals(
        descriptionDefectKind(child.description, `${path}.${name}`),
        undefined,
        `${path}.${name}`,
      );
    }
  }
});

Deno.test("workflow publication, activation and run start document the rule behavior", async () => {
  const transport = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/technical-design/transport-schemas.json",
        import.meta.url,
      ),
    ),
  ) as { inputs: Record<string, { description: string }> };
  const text = (name: string) => transport.inputs[name]?.description ?? "";
  for (const name of ["WorkflowVersionPublish", "WorkflowActivationCreate"]) {
    assert(text(name).includes("`require`"), name);
    assert(text(name).includes("UNPROCESSABLE"), name);
  }
  assert(
    text("WorkflowVersionPublish").includes("repository_rule_stage_missing"),
  );
  assert(
    text("WorkflowVersionPublish").includes(
      "repository_rule_stage_before_revision",
    ),
  );
  assert(text("RunCreate").includes("repository_rules_unavailable"));
  assert(text("RunCreate").includes("immutable run snapshot"));
  // The typed error is one the catalog already allows for both operations.
  for (
    const action of ["workflowVersions.publish", "workflowActivations.create"]
  ) {
    const entry = catalogActions.find((candidate) =>
      candidate.action === action
    );
    assert(entry, action);
    assert(entry.errors.includes("UNPROCESSABLE"), action);
  }
  const start = catalogActions.find(({ action }) => action === "runs.create");
  assert(start?.errors.includes("STATE_CONFLICT"));
});
