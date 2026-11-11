#!/usr/bin/env node
// bakery-ui: read-only MCP server over the UI component catalog, the route
// reference ledger and the architecture checker. Dependency-free stdio
// JSON-RPC 2.0, one JSON message per line (MCP protocol 2025-06-18).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CATALOG_LEVELS,
  findComponents,
  getComponent,
  getComposition,
  loadCatalog,
} from "../packages/ui/catalog/index.ts";
import { parseRouteReferenceLedger } from "../packages/ui/catalog/route-references.ts";
import { describeFile } from "./check-ui-architecture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINES = "docs/technical-design/ui-baselines";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PAPER_FILE_URL = "https://app.paper.design/file";
const MANIFESTS = {
  auth: `${BASELINES}/paper-baselines.json`,
  enterprise: `${BASELINES}/enterprise-baselines.json`,
  settings: `${BASELINES}/settings-baselines.json`,
  entitlements: `${BASELINES}/entitlements-baselines.json`,
  artifacts: `${BASELINES}/artifacts-baselines.json`,
};
const MAX_MATCHES = 10;

const INSTRUCTIONS =
  "Bakery UI catalog. Before writing a raw element such as <table>, <p> or <input> in apps/web, call ui_find_component with that element; use the @bakery/ui component it names. Read ui_component for variants, a11y and Paper frames, ui_composition for the required and forbidden component mix of a screen pattern, and ui_route_reference for the Paper frames and golden cases of a route. After editing a module call ui_check_file; it returns exactly the diagnostics the CI architecture check reports for that file.";

class ToolError extends Error {}

const FindComponentInput = z
  .object({
    need: z
      .string()
      .optional()
      .describe(
        "Free-text description of the UI need, for example 'table of records'; matched against component names, descriptions and usage text.",
      ),
    element: z
      .string()
      .optional()
      .describe(
        "Raw intrinsic tag you are about to write, for example 'table'; returns the components that replace it.",
      ),
    level: z
      .enum(CATALOG_LEVELS)
      .optional()
      .describe("Restrict results to one Atomic Design level."),
    role: z
      .string()
      .optional()
      .describe(
        "Restrict results to components whose root carries this ARIA role.",
      ),
  })
  .strict()
  .describe("Search criteria; give at least one field.");

const ComponentInput = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("Catalog component id such as 'ui.dataTable'."),
  })
  .strict()
  .describe("Which catalog component to read.");

const CompositionInput = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Composition id such as 'work-queue'; omit to list every composition.",
      ),
    file: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Repo-relative module path; returns the compositions the checker applies to it.",
      ),
  })
  .strict()
  .describe(
    "Composition selector; id and file narrow the answer, both may be omitted.",
  );

const RouteReferenceInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Route path as declared in routeCoverage, for example '/settings/appearance'; $param segments match any segment.",
      ),
  })
  .strict()
  .describe("Which route to look up in the route reference ledger.");

const CheckFileInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Repo-relative path of a TypeScript or JavaScript module to check; must stay inside the repository.",
      ),
  })
  .strict()
  .describe("Which module the architecture checker should report on.");

function insideRoot(path) {
  const absolute = resolve(ROOT, path);
  const rel = relative(ROOT, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(
      `path ${JSON.stringify(path)} is outside the repository`,
    );
  }
  if (!existsSync(absolute)) {
    throw new ToolError(`path ${JSON.stringify(path)} does not exist`);
  }
  const real = realpathSync(absolute);
  const realRel = relative(realpathSync(ROOT), real);
  if (
    realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)
  ) {
    throw new ToolError(
      `path ${JSON.stringify(path)} resolves outside the repository`,
    );
  }
  return rel.split(sep).join("/");
}

function summarize(match) {
  const { entry } = match;
  return {
    id: entry.id,
    name: entry.name,
    level: entry.level,
    score: match.score,
    reasons: match.reasons,
    description: entry.description,
    whenToUse: entry.usage.whenToUse,
    whenNotToUse: entry.usage.whenNotToUse,
    replacesElements: entry.usage.replacesElements,
    role: entry.a11y.role ?? null,
    storyTitle: entry.storyTitle,
  };
}

function paperFrames(frames) {
  return frames.map((frame) => ({
    ...frame,
    pageUrl: `${PAPER_FILE_URL}/${frame.fileId}/${frame.pageId}`,
  }));
}

function findComponent({ need, element, level, role }) {
  if (!need && !element && !level && !role) {
    throw new ToolError("give at least one of need, element, level or role");
  }
  const matches = findComponents(
    { query: need, element, level, role },
    loadCatalog(),
  );
  return {
    total: matches.length,
    matches: matches.slice(0, MAX_MATCHES).map(summarize),
  };
}

function component({ id }) {
  const catalog = loadCatalog();
  const entry = getComponent(id, catalog);
  if (!entry) {
    throw new ToolError(
      `unknown component ${
        JSON.stringify(id)
      }; call ui_find_component to search`,
    );
  }
  const names = new Map(catalog.entries.map((other) => [other.id, other.name]));
  return {
    ...entry,
    paper: paperFrames(entry.paper),
    alternatives: entry.usage.alternatives.map((alternative) => ({
      ...alternative,
      name: names.get(alternative.use) ?? null,
    })),
    compositions: catalog.compositions
      .filter((composition) =>
        composition.appliesTo.includes(entry.id) ||
        composition.requires.some((group) => group.anyOf.includes(entry.id)) ||
        composition.forbids.includes(entry.id)
      )
      .map((composition) => composition.id),
  };
}

function composition({ id, file }) {
  const catalog = loadCatalog();
  const decorate = (value) => ({
    ...value,
    paper: paperFrames(value.paper),
  });
  if (id) {
    const found = getComposition(id, catalog);
    if (!found) {
      throw new ToolError(
        `unknown composition ${JSON.stringify(id)}; known: ${
          catalog.compositions.map((entry) => entry.id).join(", ")
        }`,
      );
    }
    return { compositions: [decorate(found)] };
  }
  if (file) {
    const described = describeFile(insideRoot(file), { root: ROOT });
    return {
      file: described.file,
      compositions: described.compositions.map((applied) =>
        decorate(getComposition(applied, catalog))
      ),
    };
  }
  return { compositions: catalog.compositions.map(decorate) };
}

function patternMatches(pattern, path) {
  const wanted = pattern.split("/");
  const actual = path.split("/");
  return wanted.length === actual.length &&
    wanted.every((segment, index) =>
      segment.startsWith("$") || segment === actual[index]
    );
}

function routeReference({ path }) {
  const ledgerPath = join(ROOT, BASELINES, "route-references.json");
  const parsed = parseRouteReferenceLedger(
    JSON.parse(readFileSync(ledgerPath, "utf8")),
  );
  if (!parsed.success) {
    throw new ToolError(
      `route reference ledger is invalid:\n${parsed.issues.join("\n")}`,
    );
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const entries = parsed.ledger.entries;
  const entry = entries.find((candidate) => candidate.path === normalized) ??
    entries.find((candidate) => patternMatches(candidate.path, normalized)) ??
    entries.find((candidate) => patternMatches(normalized, candidate.path));
  if (!entry) {
    throw new ToolError(
      `no ledger entry for ${JSON.stringify(path)}; known paths: ${
        entries.map((candidate) => candidate.path).join(", ")
      }`,
    );
  }
  let cases = [];
  if (entry.manifest) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, MANIFESTS[entry.manifest]), "utf8"),
    );
    const byId = new Map(
      manifest.cases.map((baseline) => [baseline.id, baseline]),
    );
    cases = (entry.cases ?? []).map((caseId) => {
      const baseline = byId.get(caseId);
      return baseline
        ? {
          id: caseId,
          manifest: MANIFESTS[entry.manifest],
          frameId: baseline.frameId,
          pageId: baseline.pageId,
          design: baseline.design,
          referencePng: baseline.imagePath,
          referencePngExists: existsSync(join(ROOT, baseline.imagePath)),
        }
        : { id: caseId, manifest: MANIFESTS[entry.manifest], missing: true };
    });
  }
  return { entry: { ...entry, frames: paperFrames(entry.frames) }, cases };
}

function checkFileTool({ path }) {
  const described = describeFile(insideRoot(path), { root: ROOT });
  return {
    file: described.file,
    clean: described.diagnostics.length === 0,
    diagnostics: described.diagnostics,
    compositions: described.compositions,
  };
}

const TOOLS = [
  {
    name: "ui_find_component",
    title: "Find a UI component",
    description:
      "Rank catalog components for a need or a raw element. Call before writing raw markup in apps/web.",
    schema: FindComponentInput,
    run: findComponent,
  },
  {
    name: "ui_component",
    title: "Read a UI component",
    description:
      "Full catalog entry for one component id: usage, alternatives, a11y, tokens, variants, Paper frames and story title.",
    schema: ComponentInput,
    run: component,
  },
  {
    name: "ui_composition",
    title: "Read UI compositions",
    description:
      "Screen-pattern compositions: required and forbidden components and Paper frames; filter by id or by the module they apply to.",
    schema: CompositionInput,
    run: composition,
  },
  {
    name: "ui_route_reference",
    title: "Read a route reference",
    description:
      "Route reference ledger entry for a route path, with its Paper frames, golden cases and reference PNG paths.",
    schema: RouteReferenceInput,
    run: routeReference,
  },
  {
    name: "ui_check_file",
    title: "Check a module against the UI rules",
    description:
      "Diagnostics the CI architecture check reports for one module (same code path as pnpm ui:architecture:check, minus the merge-base contraction).",
    schema: CheckFileInput,
    run: checkFileTool,
  },
];

const toolByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? {} : { structuredContent: value }),
    isError,
  };
}

function callTool(params) {
  const tool = toolByName.get(params?.name);
  if (!tool) {
    const error = new Error(`unknown tool ${JSON.stringify(params?.name)}`);
    error.rpcCode = -32602;
    throw error;
  }
  const parsed = tool.schema.safeParse(params.arguments ?? {});
  if (!parsed.success) {
    return toolResult({
      error: parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "(arguments)"}: ${issue.message}`
      ).join("; "),
    }, true);
  }
  try {
    return toolResult(tool.run(parsed.data));
  } catch (cause) {
    return toolResult({
      error: cause instanceof Error ? cause.message : String(cause),
    }, true);
  }
}

function handle(method, params) {
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "bakery-ui",
          title: "Bakery UI catalog",
          version: "1.0.0",
        },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: listTools() };
    case "tools/call":
      return callTool(params);
    default: {
      const error = new Error(`method not found: ${method}`);
      error.rpcCode = -32601;
      throw error;
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

export function respond(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (
    request === null || typeof request !== "object" || Array.isArray(request)
  ) {
    send({ id: null, error: { code: -32600, message: "invalid request" } });
    return;
  }
  const isNotification = !("id" in request);
  if (typeof request.method !== "string") {
    if (!isNotification && "method" in request) {
      send({
        id: request.id,
        error: { code: -32600, message: "invalid request" },
      });
    }
    return;
  }
  if (isNotification) return;
  try {
    send({ id: request.id, result: handle(request.method, request.params) });
  } catch (cause) {
    send({
      id: request.id,
      error: {
        code: cause.rpcCode ?? -32603,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim()) respond(line);
  });
}
