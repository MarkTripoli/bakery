import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";

type AstNode = {
  type: string;
  parent?: AstNode;
  [key: string]: unknown;
};

const zodConstructors = new Set([
  "any",
  "array",
  "bigint",
  "boolean",
  "catch",
  "date",
  "default",
  "discriminatedUnion",
  "enum",
  "file",
  "function",
  "instanceof",
  "intersection",
  "json",
  "lazy",
  "literal",
  "map",
  "nan",
  "nativeEnum",
  "never",
  "null",
  "number",
  "object",
  "preprocess",
  "promise",
  "record",
  "set",
  "strictObject",
  "string",
  "symbol",
  "templateLiteral",
  "transform",
  "tuple",
  "undefined",
  "union",
  "unknown",
  "void",
]);

const zodCompositions = new Set([
  "and",
  "array",
  "base64",
  "brand",
  "catch",
  "catchall",
  "datetime",
  "default",
  "describe",
  "email",
  "endsWith",
  "extend",
  "finite",
  "gt",
  "gte",
  "int",
  "length",
  "lt",
  "lte",
  "max",
  "meta",
  "min",
  "negative",
  "nonempty",
  "nonnegative",
  "nonpositive",
  "nullable",
  "nullish",
  "omit",
  "optional",
  "or",
  "passthrough",
  "partial",
  "pipe",
  "positive",
  "prefault",
  "readonly",
  "refine",
  "regex",
  "required",
  "rest",
  "safe",
  "strict",
  "strip",
  "superRefine",
  "transform",
  "trim",
  "url",
  "uuid",
]);

const transparentExpressions = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function asAstNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as AstNode;
  return typeof node.type === "string" ? node : undefined;
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function identifierName(value: unknown): string | undefined {
  const node = asAstNode(value);
  if (!node) return undefined;
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function memberName(value: unknown): string | undefined {
  const node = asAstNode(value);
  if (!node || node.type !== "MemberExpression") return undefined;
  return identifierName(node.property);
}

function isZodConstructor(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = asAstNode(node.callee);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) {
    return false;
  }
  const object = asAstNode(callee.object);
  const name = memberName(callee);
  return identifierName(object) === "z" && !!name && zodConstructors.has(name);
}

function isDescribedHelperCall(node: AstNode): boolean {
  return node.type === "CallExpression" &&
    identifierName(asAstNode(node.callee)) === "described";
}

function staticValue(
  node: AstNode,
): { known: true; value: unknown } | { known: false } {
  if (node.type === "Literal") return { known: true, value: node.value };
  if (node.type !== "TemplateLiteral") return { known: false };
  if (arrayValues(node.expressions).length > 0) return { known: false };
  const value = arrayValues(node.quasis).map((value) => {
    const quasi = asAstNode(value);
    const templateValue = quasi?.value;
    const strings = templateValue && typeof templateValue === "object"
      ? templateValue as Record<string, unknown>
      : quasi;
    if (!strings) return "";
    return typeof strings.cooked === "string"
      ? strings.cooked
      : typeof strings.raw === "string"
      ? strings.raw
      : "";
  }).join("");
  return { known: true, value };
}

function staticString(node: AstNode): string | undefined {
  const value = staticValue(node);
  return value.known && typeof value.value === "string"
    ? value.value
    : undefined;
}

function unwrap(node: AstNode): AstNode {
  let current = node;
  while (true) {
    const parent = current.parent;
    if (!parent || !transparentExpressions.has(parent.type)) return current;
    if (parent.expression !== current) return current;
    current = parent;
  }
}

function outermostComposition(node: AstNode): AstNode {
  let current = node;
  while (true) {
    const member = current.parent;
    if (!member || member.type !== "MemberExpression") return current;
    if (member.object !== current) return current;
    const method = memberName(member);
    if (!method || !zodCompositions.has(method)) return current;
    const call = member.parent;
    if (!call || call.type !== "CallExpression" || call.callee !== member) {
      return current;
    }
    current = call;
  }
}

function descriptionMetadataStatus(
  node: AstNode,
  path: string,
): "valid" | "invalid" | "missing" | "unknown" {
  if (node.type !== "CallExpression") return "missing";
  const callee = asAstNode(node.callee);
  if (isDescribedHelperCall(node)) {
    const argument = asAstNode(arrayValues(node.arguments)[1]);
    if (!argument) return "missing";
    const description = staticValue(argument);
    if (!description.known) return "unknown";
    return descriptionDefectKind(description.value, path) ? "invalid" : "valid";
  }
  const method = memberName(callee);
  if (method === "describe") {
    const argument = asAstNode(arrayValues(node.arguments)[0]);
    if (!argument) return "invalid";
    const description = staticValue(argument);
    if (!description.known) return "unknown";
    return descriptionDefectKind(description.value, path) ? "invalid" : "valid";
  }
  if (method !== "meta") return "missing";
  const metadata = asAstNode(arrayValues(node.arguments)[0]);
  if (!metadata || metadata.type !== "ObjectExpression") return "unknown";
  const properties = Array.isArray(metadata.properties)
    ? metadata.properties
    : [];
  const descriptionProperty = properties.find((value) => {
    const property = asAstNode(value);
    return property?.type === "Property" &&
      identifierName(property.key) === "description";
  });
  if (!descriptionProperty) return "missing";
  const property = asAstNode(descriptionProperty);
  const value = asAstNode(property?.value);
  if (!value) return "invalid";
  const description = staticValue(value);
  if (!description.known) return "unknown";
  return descriptionDefectKind(description.value, path) ? "invalid" : "valid";
}

function isDescribedHelperArgument(node: AstNode): boolean {
  const expression = unwrap(node);
  const parent = expression.parent;
  if (!parent || parent.type !== "CallExpression") return false;
  if (identifierName(parent.callee) !== "described") return false;
  return arrayValues(parent.arguments).some((argument) => {
    const argumentNode = asAstNode(argument);
    return argumentNode !== undefined && unwrap(argumentNode) === expression;
  });
}

function isVariableDeclaration(node: AstNode): boolean {
  const declaration = node.parent;
  return declaration?.type === "VariableDeclaration";
}

function isZodCallArgument(node: AstNode): boolean {
  const expression = unwrap(node);
  const call = asAstNode(expression.parent);
  if (!call || !isZodConstructor(call)) return false;
  return arrayValues(call.arguments).some((argument) =>
    asAstNode(argument) === expression
  );
}

function isExpressionFunctionBody(node: AstNode): boolean {
  const callback = asAstNode(node.parent);
  if (!callback || callback.type !== "ArrowFunctionExpression") return false;
  if (callback.body !== node) return false;
  return true;
}

function isBranchExpression(parent: AstNode, expression: AstNode): boolean {
  if (parent.type === "ConditionalExpression") {
    return parent.consequent === expression || parent.alternate === expression;
  }
  if (parent.type === "LogicalExpression") {
    return parent.left === expression || parent.right === expression;
  }
  if (parent.type === "SequenceExpression") {
    return arrayValues(parent.expressions).some((value) =>
      asAstNode(value) === expression
    );
  }
  return false;
}

function escapesSchema(node: AstNode): boolean {
  const expression = unwrap(node);
  const parent = expression.parent;
  if (!parent) return false;
  if (isBranchExpression(parent, expression)) return escapesSchema(parent);
  if (parent.type === "VariableDeclarator") {
    return parent.init === expression && isVariableDeclaration(parent);
  }
  if (parent.type === "Property") return parent.value === expression;
  if (parent.type === "ReturnStatement") return parent.argument === expression;
  if (parent.type === "CallExpression" || parent.type === "NewExpression") {
    return arrayValues(parent.arguments).some((argument) => {
      const argumentNode = asAstNode(argument);
      return argumentNode !== undefined && unwrap(argumentNode) === expression;
    });
  }
  if (parent.type === "ArrayExpression") {
    return isZodCallArgument(parent) || escapesSchema(parent);
  }
  if (parent.type === "ArrowFunctionExpression") {
    return isExpressionFunctionBody(expression);
  }
  return parent.type === "ExportDefaultDeclaration" &&
    parent.declaration === expression;
}

function schemaPath(node: AstNode): string {
  const expression = unwrap(node);
  const parent = expression.parent;
  if (parent?.type === "Property") {
    const name = identifierName(parent.key);
    return name ? `schema.${name}` : "schema";
  }
  if (parent?.type === "VariableDeclarator" && isVariableDeclaration(parent)) {
    const name = identifierName(parent.id);
    return name ? `schema.${name}` : "schema";
  }
  return "schema";
}

function descriptionRule(
  context: Deno.lint.RuleContext,
): Deno.lint.LintVisitor {
  return {
    CallExpression(node) {
      const candidate = asAstNode(node);
      if (
        !candidate ||
        (!isZodConstructor(candidate) && !isDescribedHelperCall(candidate))
      ) return;
      const expression = outermostComposition(candidate);
      if (!escapesSchema(expression)) return;
      const metadata = descriptionMetadataStatus(
        expression,
        schemaPath(expression),
      );
      if (metadata === "valid" || metadata === "unknown") return;
      if (isDescribedHelperArgument(expression)) {
        return;
      }
      context.report({
        node: expression as unknown as Deno.lint.Node,
        message:
          "Zod schemas must end with .describe(...), .meta({ description }), or described(...).",
        hint:
          "Add terminal description metadata before the schema escapes its local expression.",
      });
    },
  };
}

function normalizePath(value: string): string {
  const withoutScheme = value.replace(/^file:\/\//, "");
  const absolute = withoutScheme.startsWith("/");
  const parts: string[] = [];
  for (const part of withoutScheme.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function resolveImport(filename: string, source: string): string {
  if (!source.startsWith(".")) return normalizePath(source);
  const normalizedFile = normalizePath(filename);
  const directory = normalizedFile.slice(0, normalizedFile.lastIndexOf("/"));
  return normalizePath(`${directory}/${source}`);
}

function isClientRoot(filename: string): boolean {
  const path = normalizePath(filename);
  return ["apps/web", "packages/ui"].some((root) =>
    path === root || path.startsWith(`${root}/`) || path.includes(`/${root}/`)
  );
}

function isServerOnlyImport(filename: string, source: string): boolean {
  const path = resolveImport(filename, source);
  return /(?:^|\/)apps\/server(?:\/|$)/.test(path) ||
    path === "@bakery/server" || path.startsWith("@bakery/server/") ||
    path === "@bakery/contracts/server" ||
    path.startsWith("@bakery/contracts/server/") ||
    path.includes("/server-only/") || path.endsWith("/server-only") ||
    /(?:^|\/)server-only(?:\.[^/]+)+$/.test(path) ||
    /(?:^|\/)[^/]+\.server(?:\.[^/]+)+$/.test(path);
}

function importSource(node: AstNode): string | undefined {
  if (
    node.type !== "ImportDeclaration" &&
    node.type !== "ExportNamedDeclaration" &&
    node.type !== "ExportAllDeclaration" && node.type !== "ImportExpression"
  ) return undefined;
  const source = asAstNode(node.source);
  return source ? staticString(source) : undefined;
}

function importBoundaryRule(
  context: Deno.lint.RuleContext,
): Deno.lint.LintVisitor {
  if (!isClientRoot(context.filename)) return {};
  const check = (node: Deno.lint.Node) => {
    const candidate = asAstNode(node);
    if (!candidate) return;
    const source = importSource(candidate);
    if (!source || !isServerOnlyImport(context.filename, source)) return;
    context.report({
      node,
      message: "Client code must not import server authority.",
      hint: "Import only client-safe shared contracts from a client root.",
    });
  };
  return {
    ImportDeclaration: check,
    ExportAllDeclaration: check,
    ExportNamedDeclaration: check,
    ImportExpression: check,
  };
}

const plugin: Deno.lint.Plugin = {
  name: "bakery-contracts",
  rules: {
    "described-zod-schema": { create: descriptionRule },
    "no-client-server-import": { create: importBoundaryRule },
  },
};

export default plugin;
