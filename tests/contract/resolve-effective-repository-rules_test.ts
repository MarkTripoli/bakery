import { assertEquals } from "@std/assert";
import { z } from "zod";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import {
  EffectiveRepositoryRulesSchema,
  OrganizationRepositoryRulesSchema,
  RepositoryRuleOverridesSchema,
} from "../../packages/contracts/src/repository-rules.ts";

function walk(node: unknown, dotted: string, defects: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, dotted, defects));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const isSchemaNode = "type" in record || "anyOf" in record ||
    "oneOf" in record || "const" in record || "enum" in record;
  if (
    isSchemaNode &&
    descriptionDefectKind(record.description, dotted) !== undefined
  ) defects.push(dotted);
  for (const [key, child] of Object.entries(record)) {
    if (key === "required" || key === "enum") continue;
    if (key === "properties" && child && typeof child === "object") {
      for (const [name, property] of Object.entries(child)) {
        walk(property, `${dotted}.${name}`, defects);
      }
      continue;
    }
    walk(child, dotted, defects);
  }
}

Deno.test("every repository rules schema node carries a quality description", () => {
  for (
    const schema of [
      OrganizationRepositoryRulesSchema,
      RepositoryRuleOverridesSchema,
      EffectiveRepositoryRulesSchema,
    ]
  ) {
    const json = z.toJSONSchema(schema, {
      unrepresentable: "any",
      io: "input",
    });
    const defects: string[] = [];
    walk(json, "root", defects);
    assertEquals(defects, []);
  }
});
