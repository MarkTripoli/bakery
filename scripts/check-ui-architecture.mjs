import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isFile, TypeScriptProject } from "./lib/typescript-project.mjs";
import { parseRouteReferenceLedger } from "../packages/ui/catalog/route-references.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PACKAGE_NAME = "@bakery/ui";
const STYLE_PROPS = new Set(["className", "style"]);
const LEVELS = ["atoms", "molecules", "organisms", "templates"];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXCLUDED_SOURCE_FILES =
  /\.(?:story|stories|spec|test|d)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  "__mocks__",
  "__stories__",
  "__tests__",
  "node_modules",
  "stories",
  "tests",
]);
const RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const RESOLUTION_INDEXES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
];
const SOURCE_EXTENSION_SUBSTITUTIONS = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const ANY_FLAG = 1;
const UNKNOWN_FLAG = 2;
const BASELINE_DIRECTORY = "docs/technical-design/ui-baselines";
const CATALOG_PATH = `${BASELINE_DIRECTORY}/components.json`;
const RUNTIME_PATH = `${BASELINE_DIRECTORY}/runtime-cases.json`;
const PAPER_BASELINES_PATH = `${BASELINE_DIRECTORY}/paper-baselines.json`;
const ROUTE_REFERENCES_PATH = `${BASELINE_DIRECTORY}/route-references.json`;
const ROUTE_REFERENCE_MANIFEST_PATHS = {
  auth: PAPER_BASELINES_PATH,
  enterprise: `${BASELINE_DIRECTORY}/enterprise-baselines.json`,
  settings: `${BASELINE_DIRECTORY}/settings-baselines.json`,
  entitlements: `${BASELINE_DIRECTORY}/entitlements-baselines.json`,
  artifacts: `${BASELINE_DIRECTORY}/artifacts-baselines.json`,
};
const GUARDRAIL_BASELINE_PATH = `${BASELINE_DIRECTORY}/guardrail-baseline.json`;
const APP_SOURCE_PREFIX = "apps/web/src/";
const REMOVAL_LEDGER_PATH = `${BASELINE_DIRECTORY}/coverage-removals.json`;
const REMOVAL_KINDS = [
  "catalog-id",
  "required-case",
  "runtime-case-context-edge",
  "runtime-context",
  "viewport-profile",
  "visual-baseline",
  "section-route",
  "ui-consumer",
  "app-route",
  "route-state",
  "route-reference",
  "catalog-rule",
];
const CONTRACT_TYPE_NAME = "SectionNavigationItem";
const APP_ROUTE_COVERAGE_NAME = "routeCoverage";
const APP_ROUTE_CLASSIFICATIONS = new Set(["production", "fixture"]);
const APP_ROUTE_STATES = new Set([
  "accepted",
  "action",
  "authenticated",
  "auth-required",
  "blocked",
  "busy",
  "cache-scope",
  "canceled",
  "complete",
  "conflict",
  "copied",
  "declined",
  "default",
  "degraded",
  "denied",
  "detail",
  "disabled",
  "empty",
  "enabled",
  "error",
  "existing",
  "expired",
  "factor-required",
  "failed",
  "forbidden",
  "github-disabled",
  "invalid",
  "loading",
  "long-copy",
  "no-access",
  "no-codes",
  "offline",
  "organization-admin",
  "partial",
  "plan-review",
  "prompt",
  "protected",
  "question",
  "rate-limited",
  "ready",
  "reconnecting",
  "recovery",
  "redirect",
  "regenerate",
  "regenerated",
  "remove",
  "removed",
  "rename",
  "revoked",
  "saved",
  "scan",
  "skeleton",
  "stale",
  "submitting",
  "success",
  "throttled",
  "ticket",
  "two-factor",
  "unavailable",
  "unsupported",
  "unsynced",
  "workflow",
  "wrong-account",
]);
const ALIAS_DEPTH_LIMIT = 5;

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function discoverPackages(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packages = [];
  for (const pattern of manifest.workspaces ?? []) {
    const [base, leaf] = pattern.split("/");
    const baseDir = resolve(root, base);
    if (!statSync(baseDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (
      const entry of readdirSync(baseDir, { withFileTypes: true }).sort((
        a,
        b,
      ) => a.name.localeCompare(b.name))
    ) {
      if (!entry.isDirectory()) continue;
      if (leaf && leaf !== "*" && leaf !== entry.name) continue;
      const dir = join(baseDir, entry.name);
      if (isFile(join(dir, "package.json"))) packages.push(dir);
    }
  }
  return packages;
}

function sourceFiles(packageDir) {
  const files = [];
  const srcDir = join(packageDir, "src");
  if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) return files;

  function walk(dir) {
    for (
      const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (
        !SOURCE_EXTENSIONS.test(entry.name) ||
        EXCLUDED_SOURCE_FILES.test(entry.name)
      ) continue;
      files.push(fullPath);
    }
  }

  walk(srcDir);
  return files;
}

function loadAliases(root, packages) {
  const aliases = [];
  for (const dir of [root, ...packages]) {
    const tsconfigPath = join(dir, "tsconfig.json");
    if (!isFile(tsconfigPath)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    } catch {
      continue;
    }
    const paths = config.compilerOptions?.paths;
    if (!paths) continue;
    for (const [key, values] of Object.entries(paths)) {
      const prefix = key.replace(/\*$/, "");
      for (const value of values) {
        aliases.push({ base: dir, prefix, value, exact: !key.endsWith("*") });
      }
    }
  }
  return aliases;
}

function resolveRelative(base) {
  const extension = extname(base);
  const substituted = SOURCE_EXTENSION_SUBSTITUTIONS[extension] ?? [];
  const candidates = [
    base,
    ...substituted.map((replacement) =>
      `${base.slice(0, -extension.length)}${replacement}`
    ),
    ...RESOLUTION_EXTENSIONS.map((suffix) => `${base}${suffix}`),
    ...RESOLUTION_INDEXES.map((name) => join(base, name)),
  ];
  return candidates.find(isFile) ?? null;
}

function createResolver(context, names) {
  const { project, ts } = context;

  function resolveModule(fromFile, specifier) {
    if (specifier.startsWith(".")) {
      const target = resolveRelative(resolve(dirname(fromFile), specifier));
      return target ? { path: resolve(target) } : null;
    }
    for (const alias of context.aliases) {
      const matched = alias.exact
        ? specifier === alias.prefix
        : specifier.startsWith(alias.prefix);
      if (!matched) continue;
      const rest = specifier.slice(alias.prefix.length);
      const substituted = alias.value.includes("*")
        ? alias.value.replace("*", rest)
        : alias.exact
        ? alias.value
        : `${alias.value}${rest}`;
      const target = resolveRelative(resolve(alias.base, substituted));
      if (target) return { path: resolve(target), aliased: true };
    }
    for (const [dir, name] of names) {
      if (specifier === name) {
        const manifest = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        );
        const target = resolveRelative(
          resolve(dir, manifest.exports?.["."] ?? ""),
        );
        return target ? { path: resolve(target) } : null;
      }
      if (specifier.startsWith(`${name}/`)) {
        return { subpath: true, package: name };
      }
    }
    return null;
  }

  function resolveExport(file, name, stack = new Set(), options = {}) {
    const key = `${file}:${name}`;
    if (stack.has(key)) return [];
    const nextStack = new Set(stack).add(key);
    const source = project.source(file);
    const found = [];
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const target = resolveModule(file, statement.moduleSpecifier.text);
          if (!target?.path) continue;
          if (
            statement.exportClause && ts.isNamedExports(statement.exportClause)
          ) {
            for (const item of statement.exportClause.elements) {
              if (item.name.text !== name) continue;
              if (
                !options.types &&
                (statement.isTypeOnly || item.isTypeOnly)
              ) continue;
              found.push(
                ...resolveExport(
                  target.path,
                  item.propertyName?.text ?? item.name.text,
                  nextStack,
                  options,
                ),
              );
            }
          } else if (!statement.exportClause && name !== "default") {
            found.push(...resolveExport(target.path, name, nextStack, options));
          }
        } else if (
          statement.exportClause && ts.isNamedExports(statement.exportClause)
        ) {
          for (const item of statement.exportClause.elements) {
            if (item.name.text !== name) continue;
            found.push(
              ...resolveLocal(
                file,
                item.propertyName?.text ?? item.name.text,
                nextStack,
                options,
              ),
            );
          }
        }
        continue;
      }
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) found.push({ file, node: statement });
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name
          ) found.push({ file, node: statement });
        }
      } else if (
        (ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement)) &&
        statement.name?.text === name
      ) found.push({ file, node: statement });
    }
    return found;
  }

  function exportedNames(file, stack = new Set()) {
    if (stack.has(file)) return new Set();
    const nextStack = new Set(stack).add(file);
    const source = project.source(file);
    const names = new Set();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (
          statement.exportClause && ts.isNamedExports(statement.exportClause)
        ) {
          for (const item of statement.exportClause.elements) {
            if (statement.isTypeOnly || item.isTypeOnly) continue;
            names.add(item.name.text);
          }
        } else if (
          !statement.exportClause && statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const target = resolveModule(file, statement.moduleSpecifier.text);
          if (target?.path) {
            for (const name of exportedNames(target.path, nextStack)) {
              names.add(name);
            }
          }
        }
        continue;
      }
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            names.add(declaration.name.text);
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      ) {
        if (statement.name) names.add(statement.name.text);
      } else if (
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        if (statement.name) names.add(statement.name.text);
      }
    }
    return names;
  }

  function resolveLocal(file, name, stack = new Set(), options = {}) {
    const source = project.source(file);
    for (const statement of source.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement)) &&
        statement.name?.text === name
      ) return [{ file, node: statement }];
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name
          ) return [{ file, node: statement }];
        }
      }
    }
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) || !statement.importClause ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) continue;
      const target = resolveModule(file, statement.moduleSpecifier.text);
      if (!target?.path) continue;
      const clause = statement.importClause;
      if (clause.name?.text === name) {
        return resolveExport(target.path, "default", stack, options);
      }
      if (!clause.namedBindings) continue;
      if (!ts.isNamedImports(clause.namedBindings)) continue;
      for (const item of clause.namedBindings.elements) {
        if (item.name.text !== name) continue;
        return resolveExport(
          target.path,
          item.propertyName?.text ?? item.name.text,
          stack,
          options,
        );
      }
    }
    return [];
  }

  return { resolveModule, resolveExport, resolveLocal, exportedNames };
}

function flattenMessage(messageText) {
  if (typeof messageText === "string") return messageText;
  if (!messageText) return "invalid semantic usage";
  let text = typeof messageText.messageText === "string"
    ? messageText.messageText
    : flattenMessage(messageText.messageText);
  if (messageText.next) text = `${text} ${flattenMessage(messageText.next)}`;
  return text;
}

function underPath(path, dir) {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep)
    ? rel.split(sep)
    : null;
}

function levelOf(uiSrcDir, path) {
  const segments = underPath(path, uiSrcDir);
  if (!segments || segments.length < 2) return null;
  return LEVELS.includes(segments[0]) ? segments[0] : null;
}

function comparablePath(path) {
  if (!path.startsWith("/")) return path;
  return path.split(/[?#]/, 1)[0] || "/";
}

function isFixturePath(relativePath) {
  return relativePath.split("/").some((segment) => segment.includes("fixture"));
}

function readJsonIfPresent(path) {
  if (!isFile(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function viewportProfile(context) {
  return [
    context.viewport
      ? `${context.viewport.width}x${context.viewport.height}`
      : "no-viewport",
    `dpr=${context.dpr}`,
    `theme=${context.theme}`,
    `preference=${context.storedPreference}`,
    `pointer=${context.pointer}`,
    `locale=${context.locale}`,
    `direction=${context.direction}`,
    `timezone=${context.timezone}`,
    `motion=${context.reducedMotion}`,
    `zoom=${context.zoom}`,
    `interaction=${context.interaction}`,
  ].join("|");
}

function routeIdentity(route) {
  return `${route.file}|${route.id}|${route.href}|${route.matches.join(",")}`;
}

/** Non-production app modules the raw-element rule leaves alone. */
function isAppTestPath(relativePath) {
  return /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.split("/").some((segment) =>
      segment === "__tests__" || segment === "__mocks__"
    );
}

/** `*` stays inside one path segment, `**` crosses segments. */
function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 1;
      if (glob[index + 1] === "/") index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

function describeCatalogComponents(entries) {
  return entries.map((entry) => `${entry.id} (${entry.name})`).join(", ");
}

function baselineKey(rule, file, subject) {
  return `${rule}|${file}|${subject}`;
}

/** Guardrail baseline as `rule|file|subject` -> count. */
function parseGuardrailBaseline(text) {
  const parsed = JSON.parse(text);
  const counts = new Map();
  for (const record of parsed.entries ?? []) {
    counts.set(
      baselineKey(record.rule, record.file, record.subject),
      record.count,
    );
  }
  return counts;
}

/**
 * Baselined guardrail debt may only shrink. A base without a ledger has no
 * baseline, so the ledger-introducing branch is not measured against itself.
 */
export function validateGuardrailContraction({ baseCounts, candidateCounts }) {
  if (baseCounts === null || candidateCounts === null) return [];
  return [...candidateCounts]
    .filter(([key, count]) => count > (baseCounts.get(key) ?? 0))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) =>
      `[ui/guardrail-baseline-grew] ${key} allows ${count} versus ${
        baseCounts.get(key) ?? 0
      } at the merge base; fix the code instead of baselining it`
    );
}

export function discoverUiIdentities(
  { root = ROOT, print = console.log } = {},
) {
  const packages = discoverPackages(root);
  const files = packages.flatMap((dir) => sourceFiles(dir)).map((file) =>
    resolve(file)
  );
  const names = new Map();
  for (const dir of packages) {
    names.set(
      dir,
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name,
    );
  }
  const uiPackageDir = packages.find((dir) =>
    names.get(dir) === UI_PACKAGE_NAME
  );
  if (!uiPackageDir) {
    throw new Error(`${root}: no ${UI_PACKAGE_NAME} workspace package`);
  }
  const uiSrcDir = join(uiPackageDir, "src");
  const uiRootFile = resolveRelative(join(uiSrcDir, "index"));
  const sectionNavigationSource = resolveRelative(
    join(uiSrcDir, "organisms/SectionNavigation"),
  );
  const packageByDepth = [...packages].sort((a, b) => b.length - a.length);
  const project = new TypeScriptProject({ cwd: root, files });
  const ts = project.ts;
  const context = {
    root,
    project,
    ts,
    uiSrcDir,
    aliases: loadAliases(root, packages),
  };
  const resolver = createResolver(context, names);
  const diagnostics = [];
  const seen = new Set();
  const consumerPackages = new Set();
  const sectionNavigationUses = new Set();
  const routeArrays = [];
  const routeItems = new Map();
  const appRouteArrays = [];
  const appRouteDefinitions = [];
  const appRoutes = [];
  let routeReferenceEntries = null;
  let guardrailCounts = new Map();
  const catalog = readJsonIfPresent(join(root, CATALOG_PATH));
  const catalogEntries = catalog?.entries ?? [];
  const catalogCompositions = catalog?.compositions ?? [];
  const entriesById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const entriesByElement = new Map();
  for (const entry of catalogEntries) {
    for (const element of entry.usage?.replacesElements ?? []) {
      const list = entriesByElement.get(element) ?? [];
      list.push(entry);
      entriesByElement.set(element, list);
    }
  }
  const rawElementHits = new Map();
  const uiReferences = new Map();
  const guardrailBaselineFile = join(root, GUARDRAIL_BASELINE_PATH);
  const guardrailBaseline = isFile(guardrailBaselineFile)
    ? parseGuardrailBaseline(readFileSync(guardrailBaselineFile, "utf8"))
    : null;
  const guardrailFindings = [];
  const appliedCompositions = new Map();

  function report(file, node, rule, message) {
    const source = project.source(file);
    const position = node.getStart?.() ?? node.pos ?? 0;
    const line = source.getLineAndCharacterOfPosition(position);
    const key = `${file}:${line.line + 1}:${line.character + 1}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({
      file: relative(root, file).split(sep).join("/"),
      line: line.line + 1,
      column: line.character + 1,
      rule,
      message,
    });
  }

  function packageOfFile(file) {
    for (const dir of packageByDepth) {
      if (underPath(file, dir)) return dir;
    }
    return null;
  }

  function markConsumer(file) {
    const dir = packageOfFile(file);
    if (!dir || dir === uiPackageDir) return;
    consumerPackages.add(names.get(dir));
  }

  function moduleTargets(source) {
    const targets = [];
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        targets.push({
          node: statement,
          specifier: statement.moduleSpecifier.text,
        });
      }
      if (
        ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        targets.push({
          node: statement,
          specifier: statement.moduleSpecifier.text,
        });
      }
    }
    function walk(node) {
      node.forEachChild((child) => {
        if (
          ts.isCallExpression(child) &&
          (child.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(child.expression) &&
              child.expression.text === "require")) &&
          child.arguments.length === 1 &&
          ts.isStringLiteral(child.arguments[0])
        ) {
          targets.push({ node: child, specifier: child.arguments[0].text });
        }
        walk(child);
      });
    }
    walk(source);
    return targets;
  }

  function importedDeclarations(node, targetPath) {
    const declarations = [];
    const collect = (name) => {
      declarations.push(...resolver.resolveExport(targetPath, name));
    };
    const collectAll = () => {
      for (const name of resolver.exportedNames(targetPath)) collect(name);
    };
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) collect("default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          collect(item.propertyName?.text ?? item.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        collectAll();
      }
    } else if (
      ts.isExportDeclaration(node) && node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const item of node.exportClause.elements) {
        collect(item.propertyName?.text ?? item.name.text);
      }
    } else if (
      ts.isExportDeclaration(node) && node.exportClause &&
      ts.isNamespaceExport(node.exportClause)
    ) {
      collectAll();
    }
    return declarations;
  }

  function analyzeImports(source, file) {
    const insideUi = Boolean(underPath(file, uiPackageDir));
    const fromLevel = insideUi ? levelOf(uiSrcDir, file) : null;
    for (const { node, specifier } of moduleTargets(source)) {
      const resolved = resolver.resolveModule(file, specifier);
      if (resolved?.subpath) {
        if (resolved.package === UI_PACKAGE_NAME) {
          if (!insideUi) markConsumer(file);
          report(
            file,
            node,
            "ui/internal-module",
            `${specifier} is an internal @bakery/ui path; import the public @bakery/ui entry`,
          );
        }
        continue;
      }
      if (!resolved?.path) continue;
      if (!underPath(resolved.path, uiSrcDir)) continue;
      if (insideUi) {
        const declarations = importedDeclarations(node, resolved.path);
        const levels = declarations.length
          ? declarations.map((declaration) =>
            levelOf(uiSrcDir, declaration.file)
          )
          : [levelOf(uiSrcDir, resolved.path)];
        for (const targetLevel of levels) {
          if (
            fromLevel && targetLevel &&
            LEVELS.indexOf(targetLevel) > LEVELS.indexOf(fromLevel)
          ) {
            report(
              file,
              node,
              "ui/atomic-direction",
              `${fromLevel} imports ${targetLevel}; Atomic levels may only depend downward`,
            );
          }
        }
        continue;
      }
      markConsumer(file);
      if (resolved.path === uiRootFile) continue;
      report(
        file,
        node,
        "ui/internal-module",
        `${specifier} resolves inside @bakery/ui source; import the public @bakery/ui entry`,
      );
    }
  }

  function spreadStyleEscape(file, expression) {
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const name = property.name;
          const key = ts.isIdentifier(name) || ts.isStringLiteral(name)
            ? name.text
            : null;
          if (key && STYLE_PROPS.has(key)) {
            return { node: property, key };
          }
        } else if (ts.isSpreadAssignment(property)) {
          const nested = spreadStyleEscape(file, property.expression);
          if (nested) return nested;
        }
      }
    }
    const checker = project.checker(file);
    const type = checker.getTypeAtLocation(expression);
    if (type.flags === ANY_FLAG || type.flags === UNKNOWN_FLAG) {
      return { node: expression, key: "untyped" };
    }
    return typeStyleEscape(checker, type, expression, 0);
  }

  function typeStyleEscape(checker, type, expression, depth) {
    if (depth > 5) return { node: expression, key: "untyped" };
    if (type.flags === ANY_FLAG || type.flags === UNKNOWN_FLAG) {
      return { node: expression, key: "untyped" };
    }
    const { Union, Intersection, TypeParameter, String: StringType } =
      project.TypeFlags;
    if (type.flags & (Union | Intersection)) {
      let unprovable = false;
      for (const constituent of type.getTypes()) {
        const nested = typeStyleEscape(
          checker,
          constituent,
          expression,
          depth + 1,
        );
        if (nested && nested.key !== "untyped") return nested;
        if (nested) unprovable = true;
      }
      return unprovable ? { node: expression, key: "untyped" } : null;
    }
    if (type.flags & TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type) ??
        checker.getConstraintOfTypeParameter(type);
      if (!constraint) return { node: expression, key: "untyped" };
      const nested = typeStyleEscape(
        checker,
        constraint,
        expression,
        depth + 1,
      );
      if (nested) return nested;
      if (!checker.getPropertiesOfType(constraint).length) {
        return { node: expression, key: "untyped" };
      }
      return null;
    }
    for (const member of checker.getPropertiesOfType(type)) {
      if (STYLE_PROPS.has(member.name)) {
        return { node: expression, key: member.name };
      }
    }
    const stringIndexed = checker.getIndexInfosOfType(type).some((info) =>
      info.keyType.flags & StringType
    );
    if (stringIndexed) return { node: expression, key: "className" };
    return null;
  }

  function resolveJsxTag(file, tagName) {
    if (ts.isIdentifier(tagName)) {
      if (/^[a-z]/.test(tagName.text)) return [];
      return resolver.resolveLocal(file, tagName.text);
    }
    if (
      ts.isPropertyAccessExpression(tagName) &&
      ts.isIdentifier(tagName.expression)
    ) {
      const source = project.source(file);
      const namespace = tagName.expression.text;
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
          continue;
        }
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause.namedBindings;
        if (!bindings || !ts.isNamespaceImport(bindings)) continue;
        if (bindings.name.text !== namespace) continue;
        const target = resolver.resolveModule(
          file,
          statement.moduleSpecifier.text,
        );
        if (!target?.path) continue;
        return resolver.resolveExport(target.path, tagName.name.text);
      }
    }
    return [];
  }

  function analyzeJsx(source, file) {
    if (underPath(file, uiPackageDir)) return;
    const program = project.program(file);

    function visit(node) {
      node.forEachChild((child) => {
        if (
          ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)
        ) {
          const element = child.parent;
          for (const attribute of child.attributes.properties) {
            if (ts.isJsxAttribute(attribute)) {
              const name = attribute.name.text;
              if (STYLE_PROPS.has(name)) {
                report(
                  file,
                  attribute,
                  "ui/no-style-escape",
                  `${name} is unsupported; use an @bakery/ui semantic variant or slot`,
                );
              }
            } else if (ts.isJsxSpreadAttribute(attribute)) {
              const escape = spreadStyleEscape(file, attribute.expression);
              if (escape) {
                report(
                  file,
                  escape.node,
                  escape.key === "untyped"
                    ? "ui/untyped-style-spread"
                    : "ui/no-style-escape",
                  escape.key === "untyped"
                    ? "spread type cannot be proven free of className or style; use an explicit semantic prop type"
                    : `spread contains ${escape.key}; use an @bakery/ui semantic variant or slot`,
                );
              }
            }
          }
          const declarations = resolveJsxTag(file, child.tagName);
          if (
            declarations.length && underPath(declarations[0].file, uiSrcDir)
          ) {
            if (
              declarations.some((declaration) =>
                declaration.file === sectionNavigationSource &&
                declaration.node?.name?.text === "SectionNavigation"
              )
            ) {
              sectionNavigationUses.add(file);
            }
            for (const diagnostic of program.getSemanticDiagnostics(file)) {
              const start = diagnostic.pos ?? diagnostic.start;
              if (start === undefined) continue;
              if (start < element.getStart() || start >= element.getEnd()) {
                continue;
              }
              report(
                file,
                { getStart: () => start, pos: start },
                "ui/invalid-semantic-variant",
                diagnostic.text ?? flattenMessage(diagnostic.messageText),
              );
            }
          }
        }
        visit(child);
      });
    }
    visit(source);
  }

  /**
   * Records, per module outside @bakery/ui, the raw intrinsic elements the
   * catalog says a component replaces and the @bakery/ui declarations its JSX
   * resolves to. Rules run after every module has been visited.
   */
  function collectCompositionFacts(source, file) {
    if (underPath(file, uiPackageDir)) return;
    const relativeFile = relative(root, file).split(sep).join("/");
    const rawScope = relativeFile.startsWith(APP_SOURCE_PREFIX) &&
      !isAppTestPath(relativeFile);
    const references = new Map();
    function visit(node) {
      node.forEachChild((child) => {
        if (
          ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)
        ) {
          const tagName = child.tagName;
          if (ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) {
            if (rawScope && entriesByElement.has(tagName.text)) {
              const hits = rawElementHits.get(file) ?? [];
              hits.push({ node: tagName, element: tagName.text });
              rawElementHits.set(file, hits);
            }
          } else {
            for (const declaration of resolveJsxTag(file, tagName)) {
              if (!underPath(declaration.file, uiSrcDir)) continue;
              const key = declarationKey(declaration);
              if (!references.has(key)) references.set(key, child);
            }
          }
        }
        visit(child);
      });
    }
    visit(source);
    uiReferences.set(file, references);
  }

  function declarationKey(declaration) {
    return `${declaration.file}:${declaration.node.pos}`;
  }

  const componentKeyCache = new Map();
  /** Declaration keys the public @bakery/ui export of a catalog id resolves to. */
  function componentKeys(id) {
    if (componentKeyCache.has(id)) return componentKeyCache.get(id);
    const entry = entriesById.get(id);
    const keys = new Set(
      entry
        ? resolver.resolveExport(uiRootFile, entry.name).map(declarationKey)
        : [],
    );
    componentKeyCache.set(id, keys);
    return keys;
  }

  function firstReference(references, id) {
    for (const key of componentKeys(id)) {
      if (references.has(key)) return references.get(key);
    }
    return null;
  }

  function validateRawElements() {
    for (const [file, hits] of rawElementHits) {
      for (const hit of hits) {
        guardrailFindings.push({
          rule: "ui/raw-element-in-app",
          file,
          subject: hit.element,
          node: hit.node,
          message: `<${hit.element}> is raw markup; use ${
            describeCatalogComponents(entriesByElement.get(hit.element))
          } from @bakery/ui`,
        });
      }
    }
  }

  function validateCompositions() {
    for (const composition of catalogCompositions) {
      const globs = [];
      const componentIds = [];
      for (const target of composition.appliesTo ?? []) {
        if (entriesById.has(target)) componentIds.push(target);
        else globs.push(globToRegExp(target));
      }
      for (const [file, references] of uiReferences) {
        const relativeFile = relative(root, file).split(sep).join("/");
        const applies = globs.some((glob) => glob.test(relativeFile)) ||
          componentIds.some((id) => firstReference(references, id));
        if (!applies) continue;
        const appliedIds = appliedCompositions.get(relativeFile) ?? [];
        appliedIds.push(composition.id);
        appliedCompositions.set(relativeFile, appliedIds);
        const source = project.source(file);
        const missing = (composition.requires ?? []).filter((group) =>
          !group.anyOf.some((id) => firstReference(references, id))
        );
        if (missing.length) {
          guardrailFindings.push({
            rule: "ui/composition-missing-required",
            file,
            subject: composition.id,
            node: source,
            message: `composition ${composition.id} requires ${
              missing.map((group) => `one of ${group.anyOf.join(", ")}`)
                .join("; and ")
            }; not rendered in this module`,
          });
        }
        for (const id of composition.forbids ?? []) {
          const reference = firstReference(references, id);
          if (!reference) continue;
          guardrailFindings.push({
            rule: "ui/composition-forbidden",
            file,
            subject: composition.id,
            node: reference,
            message: `composition ${composition.id} forbids ${id}`,
          });
        }
      }
    }
  }

  /**
   * Reports guardrail findings beyond what the ratchet ledger allows for the
   * same rule, module and subject, and ledger counts the code no longer needs.
   */
  function applyGuardrailBaseline() {
    const groups = new Map();
    for (const finding of guardrailFindings) {
      const relativeFile = relative(root, finding.file).split(sep).join("/");
      const key = baselineKey(finding.rule, relativeFile, finding.subject);
      const list = groups.get(key) ?? [];
      list.push(finding);
      groups.set(key, list);
    }
    for (const [key, list] of groups) {
      const allowed = guardrailBaseline?.get(key) ?? 0;
      for (const finding of list.slice(allowed)) {
        report(
          finding.file,
          finding.node,
          finding.rule,
          allowed
            ? `${finding.message} (${list.length} in this module, ledger allows ${allowed})`
            : finding.message,
        );
      }
    }
    for (const [key, allowed] of guardrailBaseline ?? []) {
      const actual = groups.get(key)?.length ?? 0;
      if (actual >= allowed) continue;
      diagnostics.push({
        file: GUARDRAIL_BASELINE_PATH,
        line: 1,
        column: 1,
        rule: "ui/guardrail-baseline-stale",
        message:
          `${key} allows ${allowed} but ${actual} remain; lower the ledger count to ${actual}`,
      });
    }
    return new Map([...groups].map(([key, list]) => [key, list.length]));
  }

  function resolveTypeDeclaration(file, name) {
    const qualified = ts.isQualifiedName?.(name) ||
      ts.isPropertyAccessExpression(name);
    if (qualified) {
      const qualifier = name.expression ?? name.left;
      const member = name.name ?? name.right;
      if (!ts.isIdentifier(qualifier)) return [];
      const source = project.source(file);
      const namespace = qualifier.text;
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
          continue;
        }
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause.namedBindings;
        if (!bindings || !ts.isNamespaceImport(bindings)) continue;
        if (bindings.name.text !== namespace) continue;
        const target = resolver.resolveModule(
          file,
          statement.moduleSpecifier.text,
        );
        if (!target?.path) continue;
        return resolver.resolveExport(target.path, member.text, new Set(), {
          types: true,
        });
      }
      return [];
    }
    if (!ts.isIdentifier(name)) return [];
    return resolver.resolveLocal(file, name.text, new Set(), { types: true });
  }

  function isContractDeclaration(declaration) {
    return declaration.file === sectionNavigationSource &&
      ts.isTypeAliasDeclaration(declaration.node) &&
      declaration.node.name?.text === CONTRACT_TYPE_NAME;
  }

  function contractReference(file, node, depth = 0, seenAliases = new Set()) {
    if (!node || depth > ALIAS_DEPTH_LIMIT) return null;
    if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) {
      const name = node.typeName ?? node.exprName;
      for (const declaration of resolveTypeDeclaration(file, name)) {
        if (isContractDeclaration(declaration)) {
          return { file, referenceNode: node };
        }
        const declarationNode = declaration.node;
        const aliasName = declarationNode.name?.text;
        const aliasKey = `${declaration.file}:${aliasName}`;
        if (
          aliasName &&
          (ts.isTypeAliasDeclaration(declarationNode) ||
            ts.isInterfaceDeclaration(declarationNode)) &&
          !seenAliases.has(aliasKey)
        ) {
          const nested = contractReference(
            declaration.file,
            declarationNode,
            depth + 1,
            new Set(seenAliases).add(aliasKey),
          );
          if (nested) return nested;
        }
      }
    }
    let found = null;
    node.forEachChild((child) => {
      if (found) return;
      found = contractReference(file, child, depth, seenAliases);
    });
    return found;
  }

  function arrayElementTypeNode(node) {
    while (node && ts.isParenthesizedTypeNode(node)) node = node.type;
    if (!node) return null;
    if (ts.isArrayTypeNode(node)) return node.elementType;
    if (
      ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.ReadonlyKeyword
    ) {
      return arrayElementTypeNode(node.type);
    }
    if (
      ts.isTypeReferenceNode(node) &&
      node.typeArguments?.length === 1 &&
      ts.isIdentifier(node.typeName) &&
      ["Array", "ReadonlyArray"].includes(node.typeName.text)
    ) {
      return node.typeArguments[0];
    }
    return null;
  }

  function literalText(node) {
    return node && ts.isStringLiteral(node) ? node.text : null;
  }

  function unwrapExpression(expression) {
    while (
      expression &&
      (ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression))
    ) {
      expression = expression.expression;
    }
    return expression;
  }

  function propertyAssignment(object, name) {
    return object.properties.find((property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    );
  }

  function collectAppRoutes(source, file) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.name.text !== APP_ROUTE_COVERAGE_NAME
        ) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (
          !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
          !initializer ||
          !ts.isArrayLiteralExpression(initializer)
        ) {
          report(
            file,
            declaration,
            "ui/app-route-invalid",
            `${APP_ROUTE_COVERAGE_NAME} must be an exported literal array`,
          );
          continue;
        }
        appRouteArrays.push({ file, node: declaration, initializer });
      }
    }

    function walk(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createRoute"
      ) {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const pathProperty = propertyAssignment(options, "path");
          const path = literalText(pathProperty?.initializer);
          if (path !== null) {
            appRouteDefinitions.push({
              file,
              node: pathProperty.initializer,
              path,
            });
          }
        }
      }
      node.forEachChild(walk);
    }
    walk(source);
  }

  function extractAppRoutes() {
    for (const array of appRouteArrays) {
      for (const element of array.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          report(
            array.file,
            element,
            "ui/app-route-invalid",
            "app route entries must be object literals",
          );
          continue;
        }
        const idProperty = propertyAssignment(element, "id");
        const pathProperty = propertyAssignment(element, "path");
        const classificationProperty = propertyAssignment(
          element,
          "classification",
        );
        const statesProperty = propertyAssignment(element, "states");
        const id = literalText(idProperty?.initializer);
        const path = literalText(pathProperty?.initializer);
        const classification = literalText(
          classificationProperty?.initializer,
        );
        const statesExpression = unwrapExpression(statesProperty?.initializer);
        if (
          id === null || path === null || classification === null ||
          !statesExpression || !ts.isArrayLiteralExpression(statesExpression)
        ) {
          report(
            array.file,
            element,
            "ui/app-route-invalid",
            "app route entries require literal id, path, classification, and states",
          );
          continue;
        }
        if (!id.trim() || !path.startsWith("/")) {
          report(
            array.file,
            element,
            "ui/app-route-invalid",
            "app route id must be nonblank and path must be absolute",
          );
          continue;
        }
        if (!APP_ROUTE_CLASSIFICATIONS.has(classification)) {
          report(
            array.file,
            classificationProperty.initializer,
            "ui/app-route-classification",
            `app route classification must be "production" or "fixture"`,
          );
          continue;
        }
        const fixturePath = path.startsWith("/__fixtures__/");
        if (
          (classification === "fixture") !== fixturePath
        ) {
          report(
            array.file,
            classificationProperty.initializer,
            "ui/app-route-classification",
            `${classification} route ${path} has the wrong path namespace`,
          );
        }
        const states = [];
        for (const stateNode of statesExpression.elements) {
          const state = literalText(stateNode);
          if (state === null || !APP_ROUTE_STATES.has(state)) {
            report(
              array.file,
              stateNode,
              "ui/route-state-invalid",
              `route states must use the approved literal names`,
            );
            continue;
          }
          if (states.includes(state)) {
            report(
              array.file,
              stateNode,
              "ui/route-state-duplicate",
              `route state ${state} is declared more than once for ${id}`,
            );
            continue;
          }
          states.push(state);
        }
        if (!states.length) {
          report(
            array.file,
            statesExpression,
            "ui/route-state-missing",
            `app route ${id} must retain at least one observable state`,
          );
        }
        appRoutes.push({
          file: relative(root, array.file).split(sep).join("/"),
          sourceFile: array.file,
          node: element,
          id,
          path,
          classification,
          states,
        });
      }
    }
  }

  function validateAppRoutes() {
    extractAppRoutes();
    const byId = new Map();
    const byPath = new Map();
    for (const route of appRoutes) {
      const priorId = byId.get(route.id);
      if (priorId) {
        report(
          route.sourceFile,
          route.node,
          "ui/app-route-duplicate-id",
          `app route id ${route.id} is already declared by ${priorId.file}`,
        );
      } else {
        byId.set(route.id, route);
      }
      const priorPath = byPath.get(route.path);
      if (priorPath) {
        report(
          route.sourceFile,
          route.node,
          "ui/app-route-duplicate-path",
          `app route path ${route.path} is already declared by ${priorPath.id}`,
        );
      } else {
        byPath.set(route.path, route);
      }
    }
    const coverageFiles = new Set(appRouteArrays.map((array) => array.file));
    const definitions = appRouteDefinitions.filter((definition) =>
      coverageFiles.has(definition.file)
    );
    const definitionPaths = new Set(
      definitions.map((definition) => definition.path),
    );
    for (const route of appRoutes) {
      if (definitionPaths.has(route.path)) continue;
      report(
        route.sourceFile,
        route.node,
        "ui/app-route-missing-specimen",
        `app route ${route.path} has no createRoute specimen in its owning module`,
      );
    }
    for (const definition of definitions) {
      if (byPath.has(definition.path)) continue;
      report(
        definition.file,
        definition.node,
        "ui/app-route-untracked-specimen",
        `createRoute specimen ${definition.path} is absent from ${APP_ROUTE_COVERAGE_NAME}`,
      );
    }
  }

  function fixtureRouteMatches(candidatePath) {
    const parts = candidatePath.split("/");
    return appRoutes.some((route) => {
      if (route.classification !== "fixture") return false;
      const routeParts = route.path.split("/");
      return routeParts.length === parts.length &&
        routeParts.every((part, index) =>
          part.startsWith("$") ? parts[index] !== "" : part === parts[index]
        );
    });
  }

  function validateRouteReferences() {
    const ledgerFile = join(root, ROUTE_REFERENCES_PATH);
    if (!isFile(ledgerFile)) return null;
    const ledgerText = readFileSync(ledgerFile, "utf8");
    const ledgerLines = ledgerText.split("\n");
    const flag = (routeId, rule, message) => {
      const needle = routeId === null
        ? null
        : `"routeId": ${JSON.stringify(routeId)}`;
      const index = needle === null
        ? -1
        : ledgerLines.findIndex((line) => line.includes(needle));
      diagnostics.push({
        file: ROUTE_REFERENCES_PATH,
        line: index < 0 ? 1 : index + 1,
        column: 1,
        rule,
        message,
      });
    };
    let raw;
    try {
      raw = JSON.parse(ledgerText);
    } catch (cause) {
      flag(
        null,
        "ui/route-reference-invalid",
        `ledger is not valid JSON: ${cause.message}`,
      );
      return null;
    }
    const parsed = parseRouteReferenceLedger(raw);
    if (!parsed.success) {
      for (const issue of parsed.issues) {
        flag(null, "ui/route-reference-invalid", issue);
      }
      return null;
    }
    const entries = parsed.ledger.entries;
    const production = new Map(
      appRoutes
        .filter((route) => route.classification === "production")
        .map((route) => [route.id, route]),
    );
    const byId = new Map(entries.map((entry) => [entry.routeId, entry]));
    for (const route of production.values()) {
      if (byId.has(route.id)) continue;
      report(
        route.sourceFile,
        route.node,
        "ui/route-reference-missing",
        `production route ${route.id} (${route.path}) has no entry in ${ROUTE_REFERENCES_PATH}`,
      );
    }
    const manifests = new Map();
    const manifestCases = (name) => {
      if (!manifests.has(name)) {
        const manifest = readJsonIfPresent(
          join(root, ROUTE_REFERENCE_MANIFEST_PATHS[name]),
        );
        manifests.set(
          name,
          manifest
            ? new Map((manifest.cases ?? []).map((entry) => [entry.id, entry]))
            : null,
        );
      }
      return manifests.get(name);
    };
    // One baseline case scores at most one route: a planned entry must not
    // shadow a case another entry owns (any status).
    const claimedBy = new Map();
    // Each group is one manifest's cases (and frames) for an entry: the
    // entry's own manifest, then any additional manifests of a baselined
    // route whose frames live in more than one Paper source.
    const caseGroups = (entry) => [
      { manifest: entry.manifest, frames: entry.frames, cases: entry.cases },
      ...(entry.additionalManifests ?? []),
    ];
    for (const entry of entries) {
      for (const group of caseGroups(entry)) {
        for (const id of group.cases ?? []) {
          claimCase(entry, group.manifest, id);
        }
      }
    }
    function claimCase(entry, manifest, id) {
      const key = `${manifest}:${id}`;
      const owner = claimedBy.get(key);
      if (owner === entry.routeId) {
        flag(
          entry.routeId,
          "ui/route-reference-invalid",
          `case ${id} of the ${manifest} manifest is listed more than once by ${entry.routeId}`,
        );
      } else if (owner !== undefined) {
        flag(
          entry.routeId,
          "ui/route-reference-invalid",
          `case ${id} of the ${manifest} manifest is claimed by both ${owner} and ${entry.routeId}`,
        );
      } else {
        claimedBy.set(key, entry.routeId);
      }
    }
    for (const entry of entries) {
      const route = production.get(entry.routeId);
      if (entry.status === "planned") {
        if (route) {
          flag(
            entry.routeId,
            "ui/route-reference-planned-present",
            `planned route ${entry.routeId} now exists in ${APP_ROUTE_COVERAGE_NAME}; baseline it`,
          );
        }
        // Goldens exist for a planned route: each listed case must be in the
        // named manifest once that file is present.
        const plannedCases = manifestCases(entry.manifest);
        if (!plannedCases) {
          flag(
            entry.routeId,
            "ui/route-reference-invalid",
            `planned route ${entry.routeId} names manifest ${entry.manifest} but ${
              ROUTE_REFERENCE_MANIFEST_PATHS[entry.manifest]
            } is missing`,
          );
        } else {
          for (const id of entry.cases ?? []) {
            if (!plannedCases.has(id)) {
              flag(
                entry.routeId,
                "ui/route-reference-invalid",
                `planned case ${id} is absent from the ${entry.manifest} manifest`,
              );
            }
          }
        }
        continue;
      }
      // A debt entry may name a route that ships on a later branch (its
      // frames are accepted as debt before the route lands), exactly as a
      // planned entry may. Once the route is present, the normal rules apply.
      if (!route && entry.status === "debt") continue;
      if (!route) {
        flag(
          entry.routeId,
          "ui/route-reference-stale",
          `${entry.status} entry ${entry.routeId} names no production route in ${APP_ROUTE_COVERAGE_NAME}`,
        );
        continue;
      }
      if (route.path !== entry.path) {
        flag(
          entry.routeId,
          "ui/route-reference-stale",
          `entry ${entry.routeId} path ${entry.path} differs from ${APP_ROUTE_COVERAGE_NAME} path ${route.path}`,
        );
      }
      if (entry.status !== "baselined") continue;
      for (const group of caseGroups(entry)) {
        checkBaselinedGroup(entry, group);
      }
    }
    return entries;

    // Every case of the group exists in its manifest with a fixture candidate
    // route, and every frame of the group has a listed case with its frameId.
    function checkBaselinedGroup(entry, group) {
      const cases = manifestCases(group.manifest);
      if (!cases) {
        flag(
          entry.routeId,
          "ui/route-reference-unbaselined",
          `baselined route ${entry.routeId} names manifest ${group.manifest} but ${
            ROUTE_REFERENCE_MANIFEST_PATHS[group.manifest]
          } is missing`,
        );
        return;
      }
      const listed = [];
      for (const id of group.cases ?? []) {
        const found = cases.get(id);
        if (!found) {
          flag(
            entry.routeId,
            "ui/route-reference-unbaselined",
            `case ${id} is absent from the ${group.manifest} manifest`,
          );
          continue;
        }
        listed.push(found);
        const candidateRoute = found.candidate?.route;
        if (typeof candidateRoute !== "string" || !candidateRoute) {
          flag(
            entry.routeId,
            "ui/route-reference-unbaselined",
            `case ${id} has no candidate.route`,
          );
        } else if (!fixtureRouteMatches(candidateRoute)) {
          flag(
            entry.routeId,
            "ui/route-reference-unbaselined",
            `case ${id} candidate route ${candidateRoute} matches no fixture route in ${APP_ROUTE_COVERAGE_NAME}`,
          );
        }
      }
      for (const frame of group.frames) {
        if (!listed.some((found) => found.frameId === frame.frameId)) {
          flag(
            entry.routeId,
            "ui/route-reference-unbaselined",
            `frame ${frame.frameId} of ${entry.routeId} has no listed baseline case with that frameId in the ${group.manifest} manifest`,
          );
        }
      }
    }
  }

  function collectSectionRoutes(source, file) {
    if (underPath(file, uiPackageDir)) return;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const typeNodes = [];
        if (declaration.type) typeNodes.push(declaration.type);
        let expression = declaration.initializer;
        while (expression) {
          if (ts.isParenthesizedExpression(expression)) {
            expression = expression.expression;
            continue;
          }
          if (
            ts.isSatisfiesExpression(expression) ||
            ts.isAsExpression(expression)
          ) {
            typeNodes.push(expression.type);
            expression = expression.expression;
            continue;
          }
          break;
        }
        if (!expression || !ts.isArrayLiteralExpression(expression)) continue;
        let reference = null;
        for (const typeNode of typeNodes) {
          const elementNode = arrayElementTypeNode(typeNode);
          if (!elementNode) continue;
          const candidate = contractReference(file, elementNode);
          if (!candidate) continue;
          reference = { elementNode, contract: candidate };
          break;
        }
        if (!reference) continue;
        if (reference.contract.file === file) {
          const checker = project.checker(file);
          const elementType = checker.getTypeFromTypeNode(
            reference.elementNode,
          );
          const contractType = checker.getTypeFromTypeNode(
            reference.contract.referenceNode,
          );
          if (!checker.isTypeAssignableTo(elementType, contractType)) continue;
        }
        routeArrays.push({ file, statement, initializer: expression });
      }
    }
  }

  function extractRouteItems(file, initializer) {
    const items = [];
    for (const element of initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        report(
          file,
          element,
          "ui/section-route-invalid",
          "section route entries must be object literals with literal id and href values",
        );
        continue;
      }
      let id = null;
      let idNode = null;
      let href = null;
      let hrefNode = null;
      const matches = [];
      let invalid = false;
      for (const property of element.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
        if (name === "id") {
          id = literalText(property.initializer);
          idNode = property.initializer;
        } else if (name === "href") {
          href = literalText(property.initializer);
          hrefNode = property.initializer;
        } else if (name === "matches") {
          if (!ts.isArrayLiteralExpression(property.initializer)) {
            report(
              file,
              property.initializer,
              "ui/section-route-invalid",
              "section route matches must be an array of literal paths",
            );
            invalid = true;
            continue;
          }
          for (const member of property.initializer.elements) {
            const value = literalText(member);
            if (value === null) {
              report(
                file,
                member,
                "ui/section-route-invalid",
                "section route matches must be an array of literal paths",
              );
              invalid = true;
              continue;
            }
            matches.push({ value, node: member });
          }
        }
      }
      if (invalid) continue;
      if (id === null || href === null) {
        report(
          file,
          element,
          "ui/section-route-invalid",
          "section route entries must declare literal id and href values",
        );
        continue;
      }
      items.push({ id, idNode, href, hrefNode, matches });
    }
    return items;
  }

  function validateRouteItem(file, item) {
    const hrefPath = comparablePath(item.href);
    for (const match of item.matches) {
      const matchPath = comparablePath(match.value);
      const descendant = matchPath === hrefPath ||
        matchPath.startsWith(
          hrefPath.endsWith("/") ? hrefPath : `${hrefPath}/`,
        );
      if (!descendant) {
        report(
          file,
          match.node,
          "ui/section-route-nondescendant",
          `retention path ${matchPath} is not a descendant of ${hrefPath}`,
        );
      }
    }
  }

  function validateSectionRoutes() {
    const ownersById = new Map();
    const ownersByHref = new Map();
    const claimsByPath = new Map();
    const filesWithRoutes = new Set();
    for (const array of routeArrays) {
      filesWithRoutes.add(array.file);
      const items = extractRouteItems(array.file, array.initializer);
      routeItems.set(array, items);
      items.forEach((item, itemIndex) => {
        const itemKey = `${array.file}:${array.statement.pos}:${itemIndex}`;
        validateRouteItem(array.file, item);
        if (ownersById.has(item.id)) {
          report(
            array.file,
            item.idNode,
            "ui/section-route-duplicate-id",
            `section route id ${item.id} is declared more than once`,
          );
        } else {
          ownersById.set(item.id, { file: array.file });
        }
        const hrefPath = comparablePath(item.href);
        if (ownersByHref.has(hrefPath)) {
          report(
            array.file,
            item.hrefNode,
            "ui/section-route-duplicate-path",
            `section route path ${hrefPath} is declared more than once`,
          );
        } else {
          ownersByHref.set(hrefPath, { file: array.file });
        }
        const claims = claimsByPath.get(hrefPath) ?? [];
        claims.push({
          file: array.file,
          node: item.hrefNode,
          href: true,
          itemKey,
        });
        claimsByPath.set(hrefPath, claims);
        for (const match of item.matches) {
          const matchPath = comparablePath(match.value);
          const matchClaims = claimsByPath.get(matchPath) ?? [];
          matchClaims.push({
            file: array.file,
            node: match.node,
            href: false,
            itemKey,
          });
          claimsByPath.set(matchPath, matchClaims);
        }
      });
    }
    for (const [path, claims] of claimsByPath) {
      if (claims.length < 2) continue;
      if (claims.every((claim) => claim.href)) continue;
      const firstItem = claims[0].itemKey;
      for (const claim of claims.slice(1)) {
        if (claim.itemKey === firstItem) continue;
        report(
          claim.file,
          claim.node,
          "ui/section-route-conflict",
          `retention path ${path} is owned by more than one section`,
        );
      }
    }
    for (const file of filesWithRoutes) {
      if (sectionNavigationUses.has(file)) continue;
      const array = routeArrays.find((entry) => entry.file === file);
      report(
        file,
        array.statement,
        "ui/section-route-unrendered",
        "section routes must be rendered by SectionNavigation in the owning module",
      );
    }
  }

  try {
    for (const file of files) {
      const source = project.source(file);
      analyzeImports(source, file);
      analyzeJsx(source, file);
      collectCompositionFacts(source, file);
      collectSectionRoutes(source, file);
      collectAppRoutes(source, file);
    }
    validateSectionRoutes();
    validateAppRoutes();
    routeReferenceEntries = validateRouteReferences();
    validateRawElements();
    validateCompositions();
    guardrailCounts = applyGuardrailBaseline();
  } finally {
    project.close();
  }

  const sectionRoutes = [];
  for (const array of routeArrays) {
    const relativeFile = relative(root, array.file).split(sep).join("/");
    const fixture = isFixturePath(relativeFile);
    for (const item of routeItems.get(array) ?? []) {
      sectionRoutes.push({
        file: relativeFile,
        id: item.id,
        href: item.href,
        matches: item.matches.map((match) => match.value),
        fixture,
      });
    }
  }

  const runtime = readJsonIfPresent(join(root, RUNTIME_PATH));
  const paperBaselines = readJsonIfPresent(join(root, PAPER_BASELINES_PATH));
  const identitySets = {
    "catalog-id": new Set((catalog?.entries ?? []).map((entry) => entry.id)),
    "required-case": new Set(
      (catalog?.entries ?? []).flatMap((entry) =>
        (entry.requiredCases ?? []).map((required) =>
          `${entry.id}:${required.id}`
        )
      ),
    ),
    "runtime-case-context-edge": new Set(
      (runtime?.cases ?? []).map((entry) => `${entry.id}:${entry.context}`),
    ),
    "runtime-context": new Set(Object.keys(runtime?.contexts ?? {})),
    "viewport-profile": new Set(
      Object.values(runtime?.contexts ?? {}).map(viewportProfile),
    ),
    "visual-baseline": new Set(
      (paperBaselines?.cases ?? []).map((entry) => entry.id),
    ),
    "section-route": new Set(sectionRoutes.map(routeIdentity)),
    "ui-consumer": new Set(consumerPackages),
    "app-route": new Set(
      appRoutes.map((route) =>
        `${route.file}|${route.classification}|${route.id}|${route.path}`
      ),
    ),
    "route-state": new Set(
      appRoutes.flatMap((route) =>
        route.states.map((state) => `${route.file}|${route.id}|${state}`)
      ),
    ),
    "route-reference": new Set(
      (routeReferenceEntries ?? []).map((entry) => entry.routeId),
    ),
    "catalog-rule": catalogRuleIdentities(catalog),
  };
  const routeReferenceDebt = routeReferenceEntries === null ? null : new Set(
    routeReferenceEntries
      .filter((entry) => entry.status === "debt")
      .map((entry) => entry.routeId),
  );

  diagnostics.sort((a, b) =>
    `${a.file}:${a.line}:${a.column}`.localeCompare(
      `${b.file}:${b.line}:${b.column}`,
    )
  );
  for (const diagnostic of diagnostics) {
    print(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.message}`,
    );
  }
  if (!diagnostics.length) {
    const fixtureRoutes = sectionRoutes.filter((route) => route.fixture).length;
    const appFixtureRoutes = appRoutes.filter((route) =>
      route.classification === "fixture"
    ).length;
    print(
      `UI architecture check passed (${files.length} modules, ${consumerPackages.size} UI consumers, ${sectionRoutes.length} section routes, ${fixtureRoutes} fixture-proven, ${appRoutes.length} app routes, ${appFixtureRoutes} app fixtures).`,
    );
  }
  return {
    diagnostics,
    files,
    consumers: [...consumerPackages].sort(),
    sectionRoutes,
    appRoutes,
    identitySets,
    routeReferenceDebt,
    guardrailCounts,
    guardrailBaseline,
    appliedCompositions,
  };
}

/**
 * Identities of the catalog fields that make guardrail rules strict. Removing
 * one weakens a rule, so each needs a removal ledger record: a replaced
 * element tag (`replaces:<entry>:<tag>`), a composition (`composition:<id>`),
 * a requires group keyed by its sorted alternatives
 * (`requires:<id>:a|b`), a forbidden id (`forbids:<id>:<entry>`) and an
 * applies-to pattern (`applies:<id>:<pattern>`). Widening a requires group
 * changes its key, so it reads as removing the old group. Adding passes.
 */
export function catalogRuleIdentities(catalog) {
  const identities = new Set();
  for (const entry of catalog?.entries ?? []) {
    for (const tag of entry.usage?.replacesElements ?? []) {
      identities.add(`replaces:${entry.id}:${tag}`);
    }
  }
  for (const composition of catalog?.compositions ?? []) {
    identities.add(`composition:${composition.id}`);
    for (const group of composition.requires ?? []) {
      const key = [...(group.anyOf ?? [])].sort().join("|");
      identities.add(`requires:${composition.id}:${key}`);
    }
    for (const id of composition.forbids ?? []) {
      identities.add(`forbids:${composition.id}:${id}`);
    }
    for (const pattern of composition.appliesTo ?? []) {
      identities.add(`applies:${composition.id}:${pattern}`);
    }
  }
  return identities;
}

/**
 * A candidate requires group whose alternatives are a non-empty subset of a
 * base group is as strict or stricter, so the base group still counts as
 * present. Returns the candidate rule identities extended with those.
 */
function withNarrowedRequiresGroups(baseRules, candidateRules) {
  const extended = new Set(candidateRules);
  const parse = (identity) => {
    const match = /^requires:([^:]*):(.*)$/.exec(identity);
    return match ? { id: match[1], alternatives: match[2].split("|") } : null;
  };
  const candidateGroups = [...candidateRules].map(parse).filter(Boolean);
  for (const identity of baseRules) {
    const group = parse(identity);
    if (!group) continue;
    const covered = candidateGroups.some((candidate) =>
      candidate.id === group.id &&
      candidate.alternatives.every((alt) => group.alternatives.includes(alt))
    );
    if (covered) extended.add(identity);
  }
  return extended;
}

/** Thrown by `describeFile` for a path the analyzer never parsed. */
export class NotAnalyzedModuleError extends Error {
  constructor(path) {
    super(`${path} is not an analyzed UI module`);
    this.name = "NotAnalyzedModuleError";
    this.path = path;
  }
}

function relativeInside(root, path) {
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute).split(sep).join("/");
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`${path} is outside ${root}`);
  }
  return relativePath;
}

/**
 * Everything the checker knows about one module: its diagnostics and the
 * catalog compositions that apply to it. One whole-workspace analysis, the
 * same one `checkUiArchitecture` runs, filtered to the file. Throws
 * `NotAnalyzedModuleError` for a directory, non-source file or file outside
 * the analyzed packages, so "no diagnostics" never means "not looked at".
 */
export function describeFile(path, { root = ROOT } = {}) {
  const relativePath = relativeInside(root, path);
  const { diagnostics, appliedCompositions, files } = discoverUiIdentities({
    root,
    print: () => {},
  });
  if (!files.includes(resolve(root, relativePath))) {
    throw new NotAnalyzedModuleError(relativePath);
  }
  return {
    file: relativePath,
    diagnostics: diagnostics.filter((entry) => entry.file === relativePath),
    compositions: appliedCompositions.get(relativePath) ?? [],
  };
}

/**
 * Diagnostics for one module from the same analysis `checkUiArchitecture`
 * runs. The merge-base contraction check is not part of a single-file answer.
 */
export function checkFile(path, { root = ROOT } = {}) {
  return describeFile(path, { root }).diagnostics;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepository(root) {
  try {
    git(root, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function resolveMergeBase(root, baseRef) {
  const candidates = baseRef.startsWith("origin/")
    ? [baseRef]
    : [`origin/${baseRef}`, baseRef];
  for (const candidate of candidates) {
    try {
      const sha = git(root, ["merge-base", "--", candidate, "HEAD"]).trim();
      if (sha) return sha;
    } catch {
      continue;
    }
  }
  if (!isShallowCheckout(root)) return null;
  try {
    git(root, ["fetch", "--no-tags", "--unshallow", "origin"]);
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      const sha = git(root, ["merge-base", "--", candidate, "HEAD"]).trim();
      if (sha) return sha;
    } catch {
      continue;
    }
  }
  return null;
}

function isShallowCheckout(root) {
  try {
    const gitDir = git(root, ["rev-parse", "--git-dir"]).trim();
    const gitPath = isAbsolute(gitDir) ? gitDir : join(root, gitDir);
    return isFile(join(gitPath, "shallow"));
  } catch {
    return false;
  }
}

function isRelevantBasePath(path) {
  if (path.includes("node_modules") || path.includes("storybook-static")) {
    return false;
  }
  if (path === "package.json" || path.endsWith("/package.json")) return true;
  if (path === "tsconfig.json" || path.endsWith("/tsconfig.json")) return true;
  if (
    path.startsWith(`${BASELINE_DIRECTORY}/`) && path.endsWith(".json") &&
    path !== `${REMOVAL_LEDGER_PATH}`
  ) {
    return true;
  }
  return /(?:^|\/)src\//.test(path) && SOURCE_EXTENSIONS.test(path);
}

function materializeBase(root, baseSha, target) {
  const tree = git(root, ["ls-tree", "-r", baseSha]);
  const paths = [];
  for (const line of tree.split("\n")) {
    if (!line) continue;
    const [meta, path] = line.split("\t");
    const type = meta.split(" ")[1];
    if (type !== "blob") continue;
    if (!isRelevantBasePath(path)) continue;
    paths.push(path);
  }
  for (const path of paths) {
    const content = git(root, ["show", `${baseSha}:${path}`]);
    const targetPath = join(target, path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
  return paths.length;
}

function linkBaseNodeModules(root, tempRoot) {
  const links = [[join(root, "node_modules"), join(tempRoot, "node_modules")]];
  for (const dir of discoverPackages(tempRoot)) {
    const rel = relative(tempRoot, dir);
    links.push([join(root, rel, "node_modules"), join(dir, "node_modules")]);
  }
  for (const [from, to] of links) {
    if (!statSync(from, { throwIfNoEntry: false })?.isDirectory()) continue;
    try {
      symlinkSync(from, to, "dir");
    } catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
    }
  }
}

function loadRemovalLedger(root) {
  const path = join(root, REMOVAL_LEDGER_PATH);
  if (!isFile(path)) return { schemaVersion: 1, records: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateContraction(
  {
    baseSha,
    baseSets,
    candidateSets,
    ledger,
  },
) {
  const errors = [];
  const authorized = new Set();
  if (ledger.schemaVersion !== 1) {
    errors.push("coverage removal ledger must declare schemaVersion 1");
  }
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  if (!records) {
    errors.push("coverage removal ledger records must be an array");
  }
  const seen = new Set();
  for (const record of records ?? []) {
    const kind = record?.kind;
    const identity = record?.identity;
    if (!REMOVAL_KINDS.includes(kind)) {
      errors.push(`unknown removal kind ${JSON.stringify(kind) ?? "missing"}`);
      continue;
    }
    if (typeof identity !== "string" || !identity.trim()) {
      errors.push(`removal identity must be a nonblank string (${kind})`);
      continue;
    }
    if (identity.includes("*")) {
      errors.push(`wildcard removal identity ${identity}`);
      continue;
    }
    if (record.baseSha !== baseSha) {
      errors.push(
        `stale base SHA ${
          JSON.stringify(record.baseSha ?? null)
        } for ${kind} ${identity}; expected ${baseSha}`,
      );
      continue;
    }
    if (typeof record.rationale !== "string" || !record.rationale.trim()) {
      errors.push(`blank rationale for ${kind} ${identity}`);
      continue;
    }
    const replacement = typeof record.replacement === "string" &&
      record.replacement.trim().length > 0;
    const retired = record.retired === true;
    if (replacement === retired) {
      errors.push(
        `ambiguous disposition for ${kind} ${identity}; supply exactly one of replacement or retired: true`,
      );
      continue;
    }
    const key = `${kind}\n${identity}`;
    if (seen.has(key)) {
      errors.push(`duplicate removal record for ${kind} ${identity}`);
      continue;
    }
    seen.add(key);
    if (!baseSets[kind]?.has(identity)) {
      errors.push(
        `removal record for ${kind} ${identity} names an identity absent from the merge base`,
      );
      continue;
    }
    if (candidateSets[kind]?.has(identity)) {
      errors.push(
        `removal record for ${kind} ${identity} is already present in the candidate`,
      );
      continue;
    }
    authorized.add(key);
  }
  const unauthorized = [];
  for (const kind of REMOVAL_KINDS) {
    for (const identity of baseSets[kind] ?? []) {
      if (
        !candidateSets[kind]?.has(identity) &&
        !authorized.has(`${kind}\n${identity}`)
      ) {
        unauthorized.push(`unauthorized removal of ${kind} ${identity}`);
      }
    }
  }
  return { errors, unauthorized };
}

/**
 * Route reference debt may only shrink. A base without a ledger has no debt
 * baseline, so the ledger-introducing branch is not measured against itself.
 */
export function validateDebtContraction({ baseDebt, candidateDebt }) {
  if (baseDebt === null || candidateDebt === null) return [];
  return [...candidateDebt]
    .filter((routeId) => !baseDebt.has(routeId))
    .sort()
    .map((routeId) =>
      `[ui/route-reference-debt-grew] route ${routeId} is new route reference debt versus the merge base; baseline it or classify it no-mock`
    );
}

export function checkUiArchitecture(
  { root = ROOT, print = console.log, base } = {},
) {
  const candidate = discoverUiIdentities({ root, print });
  if (!isGitRepository(root)) return candidate;
  const baseRef = base ?? (process.env.GITHUB_BASE_REF || "main");
  const baseSha = resolveMergeBase(root, baseRef);
  if (!baseSha) {
    throw new Error(
      `cannot resolve contraction base ${JSON.stringify(baseRef)} from ${root}`,
    );
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "bakery-ui-base-"));
  try {
    const materialized = materializeBase(root, baseSha, tempRoot);
    linkBaseNodeModules(root, tempRoot);
    const baseDiscovery = discoverUiIdentities({
      root: tempRoot,
      print: () => {},
    });
    const ledger = loadRemovalLedger(root);
    const outcome = validateContraction({
      baseSha,
      baseSets: baseDiscovery.identitySets,
      candidateSets: {
        ...candidate.identitySets,
        "catalog-rule": withNarrowedRequiresGroups(
          baseDiscovery.identitySets["catalog-rule"],
          candidate.identitySets["catalog-rule"],
        ),
      },
      ledger,
    });
    const debtGrowth = validateDebtContraction({
      baseDebt: baseDiscovery.routeReferenceDebt,
      candidateDebt: candidate.routeReferenceDebt,
    });
    const baselineGrowth = validateGuardrailContraction({
      baseCounts: baseDiscovery.guardrailBaseline,
      candidateCounts: candidate.guardrailBaseline,
    });
    if (
      outcome.errors.length || outcome.unauthorized.length ||
      debtGrowth.length || baselineGrowth.length
    ) {
      throw new Error(
        [
          ...outcome.errors,
          ...outcome.unauthorized,
          ...debtGrowth,
          ...baselineGrowth,
        ].join("\n"),
      );
    }
    print(
      `Contraction base ${baseSha} (${materialized} files materialized): no unauthorized removals.`,
    );
    return { ...candidate, baseSha };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const baseIndex = args.indexOf("--base");
    const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
    const { diagnostics } = checkUiArchitecture({ base });
    if (diagnostics.length) process.exitCode = 1;
  } catch (cause) {
    console.error(`UI architecture check failed: ${cause.message}`);
    process.exitCode = 1;
  }
}
