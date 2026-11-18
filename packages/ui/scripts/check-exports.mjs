import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fail,
  isFile,
  TypeScriptProject,
} from "../../../scripts/lib/typescript-project.mjs";
import { parseComponentCatalog } from "../catalog/schema.ts";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE_DIR, "../..");
const CATALOG = join(
  ROOT,
  "docs/technical-design/ui-baselines/components.json",
);
const LEVELS = new Set(["atom", "molecule", "organism", "template"]);
const ATOMIC_DIRS = ["atoms", "molecules", "organisms", "templates"];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;
const EXCLUDED_SOURCE_FILES =
  /\.(?:story|stories|spec|test|d)\.(?:ts|tsx|mts|cts)$/;
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  "__mocks__",
  "__stories__",
  "__tests__",
  "stories",
  "tests",
]);

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function outcome(file, node, typeOnly, ts) {
  return {
    file,
    node,
    typeOnly: typeOnly || hasModifier(node, ts.SyntaxKind.DeclareKeyword),
  };
}

function distinct(outcomes) {
  return [...new Map(outcomes.map((item) => [
    `${item.file}:${item.node.getStart?.() ?? item.node.pos ?? 0}`,
    item,
  ])).values()];
}

function declarationKey(file, node) {
  return `${resolve(file)}:${node.getStart?.() ?? node.pos ?? 0}`;
}

function discoverSourceComponents(uiPackage, project) {
  const components = new Map();
  const srcDir = join(uiPackage, "src");
  const ts = project.ts;

  function scanDirectory(dir, level) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) continue;
        scanDirectory(fullPath, level);
        continue;
      }
      if (
        !SOURCE_EXTENSIONS.test(entry.name) ||
        EXCLUDED_SOURCE_FILES.test(entry.name)
      ) continue;
      const source = project.source(fullPath);
      const checker = project.checker(fullPath);
      for (const statement of source.statements) {
        if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
        if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;

        let name = null;
        if (
          ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)
        ) {
          name = statement.name?.text;
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              checker.getSignaturesOfType(
                checker.getTypeAtLocation(declaration.name),
                0,
              ).length
            ) {
              addComponent(
                declaration.name.text,
                fullPath,
                level,
                declaration,
              );
            }
          }
        }

        if (
          name &&
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement))
        ) addComponent(name, fullPath, level, statement);
      }
    }
  }

  function addComponent(name, file, level, declaration) {
    if (!/^[A-Z]/.test(name)) return;
    if (components.has(name)) {
      const existing = components.get(name);
      throw new Error(
        `${file}: duplicate component ${name} (already defined in ${existing.file})`,
      );
    }
    components.set(name, { name, level, file, declaration });
  }

  for (const dirName of ATOMIC_DIRS) {
    const levelDir = join(srcDir, dirName);
    if (!statSync(levelDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const level = dirName.slice(0, -1);
    scanDirectory(levelDir, level);
  }

  return components;
}

function resolveModule(from, specifier, source, packageDir, node) {
  if (!specifier.startsWith(".")) {
    fail(
      from,
      source,
      node,
      `unsupported non-relative export target ${JSON.stringify(specifier)}`,
    );
  }
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts"].map((extension) =>
      `${base}${extension}`
    ),
    ...["index.ts", "index.tsx", "index.mts", "index.cts"].map((name) =>
      join(base, name)
    ),
  ];
  const target = candidates.find(isFile);
  if (!target) {
    fail(
      from,
      source,
      node,
      `cannot resolve export target ${JSON.stringify(specifier)}`,
    );
  }
  const pathFromPackage = relative(packageDir, target);
  if (pathFromPackage === ".." || pathFromPackage.startsWith(`..${sep}`)) {
    fail(from, source, node, `export target escapes package root: ${target}`);
  }
  return resolve(target);
}

function localDeclaration(source, name, ts) {
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) && statement.name?.text === name
    ) return outcome(source.fileName, statement, false, ts);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) && declaration.name.text === name
        ) {
          return outcome(
            source.fileName,
            declaration,
            hasModifier(statement, ts.SyntaxKind.DeclareKeyword),
            ts,
          );
        }
      }
    }
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === name
    ) return outcome(source.fileName, statement, true, ts);
  }
}

function resolveFactory(project, packageDir) {
  const ts = project.ts;

  function resolveExport(file, name, stack = new Set()) {
    const key = `${file}:${name}`;
    if (stack.has(key)) return [];
    const nextStack = new Set(stack).add(key);
    const source = project.source(file);
    const explicit = [];
    const wildcard = [];

    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          if (
            statement.exportClause && ts.isNamedExports(statement.exportClause)
          ) {
            for (const item of statement.exportClause.elements) {
              if (item.name.text !== name) continue;
              if (statement.isTypeOnly || item.isTypeOnly) {
                explicit.push(outcome(file, item, true, ts));
              } else {
                explicit.push(
                  ...resolveLocal(
                    file,
                    source,
                    item.propertyName?.text ?? item.name.text,
                    nextStack,
                  ),
                );
              }
            }
          }
          continue;
        }
        const target = resolveModule(
          file,
          statement.moduleSpecifier.text,
          source,
          packageDir,
          statement,
        );
        if (
          statement.exportClause && ts.isNamedExports(statement.exportClause)
        ) {
          for (const item of statement.exportClause.elements) {
            if (item.name.text !== name) continue;
            if (statement.isTypeOnly || item.isTypeOnly) {
              explicit.push(outcome(file, item, true, ts));
            } else {
              explicit.push(
                ...resolveExport(
                  target,
                  item.propertyName?.text ?? item.name.text,
                  nextStack,
                ),
              );
            }
          }
        } else if (!statement.exportClause && name !== "default") {
          wildcard.push(
            ...resolveExport(target, name, nextStack).map((item) => ({
              ...item,
              typeOnly: statement.isTypeOnly || item.typeOnly,
            })),
          );
        } else if (statement.exportClause) {
          fail(
            file,
            source,
            statement,
            "unsupported export clause; use named or wildcard exports",
          );
        }
        continue;
      }

      if (
        ts.isExportAssignment(statement) && !statement.isExportEquals &&
        name === "default" && ts.isIdentifier(statement.expression)
      ) {
        explicit.push(
          ...resolveLocal(file, source, statement.expression.text, nextStack),
        );
        continue;
      }
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
          ? name === "default"
          : statement.name?.text === name)
      ) explicit.push(outcome(file, statement, false, ts));
      else if (ts.isVariableStatement(statement) && name !== "default") {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) && declaration.name.text === name
          ) {
            explicit.push(
              outcome(
                file,
                declaration,
                hasModifier(statement, ts.SyntaxKind.DeclareKeyword),
                ts,
              ),
            );
          }
        }
      } else if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === name
      ) explicit.push(outcome(file, statement, true, ts));
    }

    const runtimeExplicit = explicit.filter((item) => !item.typeOnly);
    if (runtimeExplicit.length) return runtimeExplicit;
    const runtimeWildcard = wildcard.filter((item) => !item.typeOnly);
    if (runtimeWildcard.length) return distinct(runtimeWildcard);
    return explicit.length ? explicit : wildcard;
  }

  function resolveLocal(file, source, name, stack) {
    const declaration = localDeclaration(source, name, ts);
    if (declaration) return [declaration];
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) || !statement.importClause ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) continue;
      const clause = statement.importClause;
      const target = resolveModule(
        file,
        statement.moduleSpecifier.text,
        source,
        packageDir,
        statement,
      );
      if (clause.name?.text === name) {
        return clause.isTypeOnly
          ? [outcome(file, clause.name, true, ts)]
          : resolveExport(target, "default", stack);
      }
      if (!clause.namedBindings) continue;
      if (
        ts.isNamespaceImport(clause.namedBindings) &&
        clause.namedBindings.name.text === name
      ) {
        return clause.isTypeOnly
          ? [outcome(file, clause.namedBindings, true, ts)]
          : [outcome(target, clause.namedBindings, false, ts)];
      }
      if (!ts.isNamedImports(clause.namedBindings)) continue;
      for (const item of clause.namedBindings.elements) {
        if (item.name.text !== name) continue;
        if (clause.isTypeOnly || item.isTypeOnly) {
          return [outcome(file, item, true, ts)];
        }
        return resolveExport(
          target,
          item.propertyName?.text ?? item.name.text,
          stack,
        );
      }
    }
    return [];
  }

  return resolveExport;
}

function exportedNamesFactory(project, packageDir) {
  const cache = new Map();
  const ts = project.ts;

  function names(file, stack = new Set()) {
    if (cache.has(file)) return cache.get(file);
    if (stack.has(file)) return new Set();
    const nextStack = new Set(stack).add(file);
    const source = project.source(file);
    const result = new Set();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (
          statement.exportClause && ts.isNamedExports(statement.exportClause)
        ) {
          for (const item of statement.exportClause.elements) {
            if (!statement.isTypeOnly && !item.isTypeOnly) {
              result.add(item.name.text);
            }
          }
        } else if (
          !statement.exportClause && statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly
        ) {
          const target = resolveModule(
            file,
            statement.moduleSpecifier.text,
            source,
            packageDir,
            statement,
          );
          for (const name of names(target, nextStack)) {
            if (name !== "default") result.add(name);
          }
        }
      } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
            ) result.add(declaration.name.text);
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
        ) {
          const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
            ? "default"
            : statement.name?.text;
          if (name) result.add(name);
        }
      }
    }
    cache.set(file, result);
    return result;
  }
  return names;
}

function declarationType(checker, node) {
  if (node.name) return checker.getTypeAtLocation(node.name);
  for (const declaration of node.declarationList.declarations) {
    return checker.getTypeAtLocation(declaration.name);
  }
  return undefined;
}

function assertSemanticProps(project, outcome, name) {
  const checker = project.checker(outcome.file);
  const type = declarationType(checker, outcome.node);
  if (!type) return;
  const signatures = checker.getSignaturesOfType(type, 0);
  if (!signatures.length || !signatures[0].parameters.length) return;
  const propsType = checker.getParameterType(signatures[0], 0);
  const forbidden = [
    ...new Set(forbiddenPropNames(checker, project.TypeFlags, propsType)),
  ];
  for (const propName of forbidden) {
    fail(
      outcome.file,
      project.source(outcome.file),
      outcome.node,
      `${name} props type includes ${propName}; wrap native props in SemanticNativeProps`,
    );
  }
}

function forbiddenPropNames(checker, TypeFlags, type, depth = 0) {
  if (!type || depth > 5) return [];
  const { Union, Intersection, TypeParameter } = TypeFlags;
  if (type.flags & (Union | Intersection)) {
    const found = [];
    for (const constituent of type.getTypes()) {
      found.push(
        ...forbiddenPropNames(checker, TypeFlags, constituent, depth + 1),
      );
    }
    return found;
  }
  if (type.flags & TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type) ??
      checker.getConstraintOfTypeParameter(type);
    return constraint
      ? forbiddenPropNames(checker, TypeFlags, constraint, depth + 1)
      : [];
  }
  const found = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    if (prop.escapedName === "className" || prop.escapedName === "style") {
      found.push(prop.escapedName);
    }
  }
  return found;
}

function readCatalog(path, validateSchema) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (validateSchema) {
    const parsed = parseComponentCatalog(value);
    if (!parsed.success) {
      throw new Error(
        `${path}: catalog violates packages/ui/catalog/schema.ts:\n  ${
          parsed.issues.join("\n  ")
        }`,
      );
    }
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`${path}: catalog entries must be an array`);
  }
  return value.entries;
}

export function checkUiExports({
  catalog = CATALOG,
  uiPackage = PACKAGE_DIR,
  cwd = uiPackage,
  print = console.log,
  validateSchema = true,
} = {}) {
  const packageJsonPath = join(uiPackage, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageRoot = resolve(uiPackage, packageJson.exports?.["."] ?? "");
  const packageRootFile = [
    packageRoot,
    ...[".ts", ".tsx", ".mts", ".cts"].map((extension) =>
      `${packageRoot}${extension}`
    ),
  ].find(isFile);
  if (!packageRootFile) {
    throw new Error(`${packageJsonPath}: cannot resolve package root export`);
  }

  const project = new TypeScriptProject({
    cwd,
    files: [packageRootFile, resolve(catalog)],
  });
  try {
    const resolveExport = resolveFactory(project, uiPackage);
    const entries = readCatalog(catalog, validateSchema);
    const componentEntries = entries.filter((entry) => LEVELS.has(entry.level));
    const catalogByName = new Map();
    for (const entry of componentEntries) {
      if (catalogByName.has(entry.name)) {
        throw new Error(
          `${catalog}: duplicate public component catalog entry ${entry.name}`,
        );
      }
      catalogByName.set(entry.name, entry);
    }

    const sourceComponents = discoverSourceComponents(uiPackage, project);
    const componentByDeclaration = new Map();
    for (const component of sourceComponents.values()) {
      componentByDeclaration.set(
        declarationKey(component.file, component.declaration),
        component,
      );
    }

    const bindings = [];
    for (const entry of componentEntries) {
      if (!LEVELS.has(entry.level)) continue;

      const sourceComponent = sourceComponents.get(entry.name);
      if (!sourceComponent) {
        throw new Error(
          `${catalog}: catalog entry ${entry.name} (${entry.id}) has no capitalized source declaration`,
        );
      }
      if (sourceComponent.level !== entry.level) {
        throw new Error(
          `${sourceComponent.file}: ${entry.name} is cataloged as ${entry.level}, but defined in ${sourceComponent.level}s`,
        );
      }

      const outcomes = resolveExport(packageRootFile, entry.name);
      if (!outcomes.length) {
        throw new Error(
          `${packageRootFile}: missing public runtime export ${entry.name} for ${entry.id}`,
        );
      }
      if (outcomes.some((item) => item.typeOnly)) {
        const typeOnlyOutcome = outcomes.find((item) => item.typeOnly);
        fail(
          typeOnlyOutcome.file,
          project.source(typeOnlyOutcome.file),
          typeOnlyOutcome.node,
          `${entry.name} for ${entry.id} is type-only`,
        );
      }
      if (outcomes.length !== 1) {
        throw new Error(
          `${packageRootFile}: ambiguous public export ${entry.name} for ${entry.id}`,
        );
      }
      const definingPath = outcomes[0].file;
      assertSemanticProps(project, outcomes[0], entry.name);
      const pathFromSource = relative(join(uiPackage, "src"), definingPath)
        .split(sep);
      if (pathFromSource[0] !== `${entry.level}s`) {
        throw new Error(
          `${definingPath}: ${entry.name} is cataloged as ${entry.level}, not its defining path`,
        );
      }
      bindings.push(`${entry.id} -> ${relative(uiPackage, definingPath)}`);
    }

    for (const [name, component] of sourceComponents) {
      const entry = catalogByName.get(name);
      if (!entry) {
        throw new Error(
          `${component.file}: source component ${name} is missing from the catalog`,
        );
      }
    }

    const exportedNames = exportedNamesFactory(project, uiPackage)(
      packageRootFile,
    );
    for (const name of exportedNames) {
      const outcomes = resolveExport(packageRootFile, name);
      const runtimeOutcomes = outcomes.filter((item) => !item.typeOnly);
      if (!runtimeOutcomes.length) continue;
      if (runtimeOutcomes.length !== 1) {
        throw new Error(
          `${packageRootFile}: ambiguous public runtime export ${name}`,
        );
      }
      const component = componentByDeclaration.get(
        declarationKey(runtimeOutcomes[0].file, runtimeOutcomes[0].node),
      );
      if (!component) continue;
      const entry = catalogByName.get(component.name);
      if (!entry) {
        throw new Error(
          `${packageRootFile}: public component export ${name} is missing from the catalog`,
        );
      }
      if (name !== component.name) {
        throw new Error(
          `${packageRootFile}: public export ${name} aliases cataloged component ${component.name}; each component may have exactly one public name`,
        );
      }
    }
    bindings.sort();
    print(`Resolved runtime exports (${bindings.length}):`);
    for (const binding of bindings) print(binding);
    return { bindings, sourceComponents };
  } finally {
    project.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    checkUiExports();
  } catch (cause) {
    console.error(`UI export verification failed: ${cause.message}`);
    process.exitCode = 1;
  }
}
