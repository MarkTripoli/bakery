import { z } from "zod";
import { descriptionDefectKind } from "@bakery/contracts/description-quality";

export type SchemaDescriptionDefect = {
  path: string;
  kind: "missing" | "invalid" | "unknown-node";
};

export class SchemaDescriptionError extends Error {
  readonly defects: readonly SchemaDescriptionDefect[];
  constructor(defects: readonly SchemaDescriptionDefect[]) {
    super(
      `invalid schema descriptions: ${
        defects.map((d) => `${d.path} (${d.kind})`).join(", ")
      }`,
    );
    this.name = "SchemaDescriptionError";
    this.defects = defects;
  }
}

type Def = Record<string, unknown>;

const KNOWN_NODE_TYPES = new Set([
  "any",
  "array",
  "bigint",
  "boolean",
  "catch",
  "custom",
  "date",
  "default",
  "enum",
  "file",
  "int",
  "intersection",
  "lazy",
  "literal",
  "map",
  "nan",
  "never",
  "nonoptional",
  "null",
  "nullable",
  "number",
  "object",
  "optional",
  "pipe",
  "prefault",
  "promise",
  "readonly",
  "record",
  "set",
  "string",
  "success",
  "symbol",
  "template_literal",
  "transform",
  "tuple",
  "undefined",
  "union",
  "unknown",
  "void",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

// Keys through which a node may hold child schemas.
const CHILD_KEYS = [
  ["[]", "element"],
  ["?", "innerType"],
  ["{key}", "keyType"],
  ["{value}", "valueType"],
  ["<in>", "in"],
  ["<out>", "out"],
  ["<left>", "left"],
  ["<right>", "right"],
  ["{catchall}", "catchall"],
  ["{rest}", "rest"],
] as const;

const isSchema = (value: unknown): value is z.core.$ZodType =>
  isRecord(value) && isRecord((value as { _zod?: unknown })._zod);

function defOf(node: z.core.$ZodType): Def {
  const def = (node as { _zod: { def?: unknown } })._zod.def;
  return isRecord(def) ? def : {};
}

function descriptionOf(node: z.core.$ZodType): unknown {
  return z.globalRegistry.get(node)?.description;
}

function children(node: z.core.$ZodType): Array<[string, unknown]> {
  const def = defOf(node);
  const out: Array<[string, unknown]> = [];
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (isRecord(shape)) {
    for (const [key, child] of Object.entries(shape)) {
      out.push([`.${key}`, child]);
    }
  }
  for (const [suffix, key] of CHILD_KEYS) {
    const child = def[key];
    if (!child) continue;
    // A strict object's closed catchall is a ZodNever marker, not a field.
    if (
      key === "catchall" && isSchema(child) && defOf(child).type === "never"
    ) {
      continue;
    }
    out.push([suffix, child]);
  }
  if (Array.isArray(def.options)) {
    def.options.forEach((child, i) => out.push([`|${i}`, child]));
  }
  if (Array.isArray(def.items)) {
    def.items.forEach((child, i) => out.push([`[${i}]`, child]));
  }
  // Template literals hold schema parts among plain string literals.
  if (def.type === "template_literal" && Array.isArray(def.parts)) {
    def.parts.forEach((part, i) => {
      if (isSchema(part)) out.push([`<part${i}>`, part]);
    });
  }
  if (typeof def.getter === "function") {
    out.push(["<lazy>", def.getter()]);
  }
  return out;
}

function visit(
  node: unknown,
  path: string,
  defects: SchemaDescriptionDefect[],
  seen: Set<object>,
): void {
  if (!isSchema(node)) {
    defects.push({ path, kind: "unknown-node" });
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  const type = defOf(node).type;
  if (typeof type !== "string" || !KNOWN_NODE_TYPES.has(type)) {
    // Fail closed: an unrecognised node may hide undescribed children.
    defects.push({ path, kind: "unknown-node" });
    return;
  }
  const kind = descriptionDefectKind(descriptionOf(node), path);
  if (kind) defects.push({ path, kind });
  for (const [suffix, child] of children(node)) {
    visit(child, `${path}${suffix}`, defects, seen);
  }
}

/** Returns every node whose description is missing, filler, or unknown to the walker. */
export function findSchemaDescriptionDefects(
  schema: unknown,
  path = "schema",
): SchemaDescriptionDefect[] {
  const defects: SchemaDescriptionDefect[] = [];
  visit(schema, path, defects, new Set());
  return defects;
}

/** Throws SchemaDescriptionError listing exact paths when any node lacks a meaningful description. */
export function assertSchemaDescriptions(
  schema: unknown,
  path = "schema",
): void {
  const defects = findSchemaDescriptionDefects(schema, path);
  if (defects.length) throw new SchemaDescriptionError(defects);
}
