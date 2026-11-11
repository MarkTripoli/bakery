import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requireFrom = (cwd) =>
  createRequire(pathToFileURL(resolve(cwd, "package.json")));

function loadTypeScript(cwd) {
  const require = requireFrom(cwd);
  const sync = require("typescript/unstable/sync");
  const ts = require("typescript/unstable/ast");
  return { API: sync.API, ts, TypeFlags: sync.TypeFlags };
}

export function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

export function fail(file, source, node, message) {
  const position = node?.getStart?.() ?? 0;
  const line = source.getLineAndCharacterOfPosition(position);
  throw new Error(`${file}:${line.line + 1}:${line.character + 1}: ${message}`);
}

export class TypeScriptProject {
  constructor({ cwd, files }) {
    this.cwd = resolve(cwd);
    const { API, ts, TypeFlags } = loadTypeScript(this.cwd);
    this.ts = ts;
    this.TypeFlags = TypeFlags;
    this.api = new API({ cwd: this.cwd });
    this.snapshot = this.api.updateSnapshot({
      openFiles: files.map((f) => resolve(f)),
    });
    this.sources = new Map();
  }

  source(file) {
    const path = resolve(file);
    if (this.sources.has(path)) return this.sources.get(path);
    const project = this.snapshot.getDefaultProjectForFile(path);
    if (!project) {
      throw new Error(`${path}: TypeScript could not create a project`);
    }
    const source = project.program.getSourceFile(path);
    if (!source) throw new Error(`${path}: TypeScript could not parse source`);
    const diagnostics = project.program.getSyntacticDiagnostics(path);
    if (diagnostics.length) {
      fail(
        path,
        source,
        { getStart: () => diagnostics[0].start ?? 0 },
        "invalid TypeScript source",
      );
    }
    this.sources.set(path, source);
    return source;
  }

  checker(file) {
    const path = resolve(file);
    const project = this.snapshot.getDefaultProjectForFile(path);
    if (!project) {
      throw new Error(`${path}: TypeScript could not create a project`);
    }
    return project.checker;
  }

  program(file) {
    const path = resolve(file);
    const project = this.snapshot.getDefaultProjectForFile(path);
    if (!project) {
      throw new Error(`${path}: TypeScript could not create a project`);
    }
    return project.program;
  }

  close() {
    this.snapshot.dispose();
    this.api.close();
  }
}
