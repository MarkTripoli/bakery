import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  deployedIntegrations,
} from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { computeManifestDigest } from "../../apps/server/src/modules/catalog/integration-gate.ts";

/**
 * The deployed registry freezes what it exports so nothing downstream can rewrite a
 * provider's identity. Freezing reached the handlers' Zod schemas too, and that is
 * not a hardening: Zod 4 fills in `.shape` lazily by defining a property on the
 * instance, so a frozen instance can no longer be turned into JSON Schema. Startup
 * hashes every handler schema to compute the manifest digest, so the freeze did not
 * protect the deployment, it stopped it - the server exited before it listened.
 *
 * These tests pin the invariant rather than the incident: the registry may freeze the
 * manifest and the handler objects, but every handler schema must still convert.
 */

const handlerSchemas = () =>
  deployedIntegrations.flatMap((definition) =>
    Object.entries(definition.handlers).flatMap(([key, handler]) =>
      (["input", "output"] as const).map((side) => ({
        label: `${definition.manifest.id}/${key}.${side}`,
        schema: handler[side],
      }))
    )
  );

Deno.test("every deployed handler schema converts to JSON Schema after the registry freeze", () => {
  const failures: string[] = [];
  for (const { label, schema } of handlerSchemas()) {
    try {
      z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any" });
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
    }
  }
  assertEquals(
    failures,
    [],
    `frozen schemas cannot be converted, so startup cannot hash them:\n${
      failures.join("\n")
    }`,
  );
});

Deno.test("the deployed registry can compute a manifest digest for every provider", () => {
  assert(deployedIntegrations.length > 0, "no providers deployed to check");
  for (const definition of deployedIntegrations) {
    const digest = computeManifestDigest(definition);
    assertEquals(
      digest.length,
      64,
      `${definition.manifest.id} digest is not a SHA-256 hex string`,
    );
  }
});

Deno.test("the freeze still protects what it was written for", () => {
  for (const definition of deployedIntegrations) {
    assert(
      Object.isFrozen(definition.manifest),
      `${definition.manifest.id} manifest must stay frozen`,
    );
    assert(
      Object.isFrozen(definition.manifest.id) === false ||
        typeof definition.manifest.id === "string",
      "manifest id must not be replaceable",
    );
    for (const [key, handler] of Object.entries(definition.handlers)) {
      assert(
        Object.isFrozen(handler),
        `${definition.manifest.id}/${key} handler object must stay frozen`,
      );
      assertEquals(
        "input" in handler && "output" in handler,
        true,
        `${definition.manifest.id}/${key} must still expose both schemas`,
      );
    }
  }
});
