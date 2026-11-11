import { isAlias, isScalar, parseAllDocuments, visit } from "yaml";
import { isExactNumberText } from "../../../packages/contracts/src/workflow-compiler/mod.ts";

const DOC = new URL(
  "../../../docs/technical-design/06-workflows-delivery-and-acceptance.md",
  import.meta.url,
);

/**
 * Strict YAML 1.2 profile: one document, unique keys, no aliases, custom
 * tags, merge keys or inexact numbers. Throws on any violation.
 */
export function strictYaml(text: string): unknown {
  const documents = parseAllDocuments(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    keepSourceTokens: true,
  });
  if (documents.length !== 1) throw new Error("multiple YAML documents");
  const [document] = documents;
  if (!document) throw new Error("empty YAML");
  if (document.errors.length > 0) throw new Error("YAML errors");
  if (document.warnings.length > 0) throw new Error("YAML warnings");
  visit(document, {
    Alias() {
      throw new Error("YAML alias rejected");
    },
    Node(_key, node) {
      const tag = (node as { tag?: string }).tag;
      if (tag && !tag.startsWith("tag:yaml.org,2002:")) {
        throw new Error("YAML custom tag rejected");
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new Error("YAML merge key rejected");
      }
    },
    Scalar(_key, node) {
      if (typeof node.value === "number") {
        const source = (node as unknown as { srcToken?: { source?: string } })
          .srcToken?.source;
        if (!isExactNumberText(source ?? String(node.value))) {
          throw new Error("YAML number is not exact");
        }
      }
    },
  });
  if (isAlias(document.contents)) throw new Error("YAML alias rejected");
  return document.toJS();
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
