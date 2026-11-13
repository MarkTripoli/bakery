import { decodeWorkflowYaml } from "../../../packages/contracts/src/workflow-compiler/mod.ts";

const DOC = new URL(
  "../../../docs/technical-design/06-workflows-delivery-and-acceptance.md",
  import.meta.url,
);

/**
 * The production strict YAML 1.2 profile (one document, unique keys, no
 * aliases, tags, directives, merge keys or inexact numbers). Throws on any
 * violation, naming the diagnostic code.
 */
export function strictYaml(text: string): unknown {
  const result = decodeWorkflowYaml(text);
  if (!result.ok) {
    throw new Error(
      `strict YAML refused: ${result.diagnostics.map((d) => d.code).join(",")}`,
    );
  }
  return result.value;
}

/** First fenced yaml block after the "## Workflow DSL" heading of doc 06. */
export async function specimenYamlText(): Promise<string> {
  const text = await Deno.readTextFile(DOC);
  const start = text.indexOf("\n## Workflow DSL");
  if (start < 0) throw new Error("Workflow DSL heading not found");
  const open = text.indexOf("```yaml\n", start);
  if (open < 0) throw new Error("specimen block not found");
  const bodyStart = open + "```yaml\n".length;
  const close = text.indexOf("\n```", bodyStart);
  if (close < 0) throw new Error("specimen block is not closed");
  return text.slice(bodyStart, close + 1);
}

/** The doc 06 authoring specimen decoded under the strict YAML profile. */
export async function specimenDefinition(): Promise<Record<string, unknown>> {
  return strictYaml(await specimenYamlText()) as Record<string, unknown>;
}
