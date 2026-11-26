export const UNNAMED_IMPORT = "imported-skill";

export type SourceForm = {
  readonly address: string;
  readonly name: string;
  readonly licence: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly folder: string;
};

export const EMPTY_SOURCE_FORM: SourceForm = {
  address: "",
  name: "",
  licence: "",
  sourceId: "",
  revision: "",
  folder: "",
};

export type SourceProblem =
  | "address"
  | "notHttps"
  | "name"
  | "licence"
  | "choose"
  | "revision";

export type SourceProblems = Partial<Record<keyof SourceForm, SourceProblem>>;

export function httpsAddress(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    const plain = url.protocol === "https:" && url.port === "" &&
      url.username === "" && url.password === "" && url.search === "" &&
      url.hash === "";
    return plain ? url : null;
  } catch {
    return null;
  }
}

export function sourceProblems(
  form: SourceForm,
  saved: boolean,
): SourceProblems {
  const empty = (value: string) => value.trim() === "";
  const repository: SourceProblems = saved
    ? empty(form.sourceId) ? { sourceId: "choose" } : {}
    : {
      ...(empty(form.address)
        ? { address: "address" }
        : httpsAddress(form.address) === null
        ? { address: "notHttps" }
        : {}),
      ...(empty(form.name) ? { name: "name" } : {}),
      ...(empty(form.licence) ? { licence: "licence" } : {}),
    };
  return {
    ...repository,
    ...(empty(form.revision) ? { revision: "revision" } : {}),
  };
}

export function cleanFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function importedName(folder: string): string {
  return cleanFolder(folder).split("/").at(-1) || UNNAMED_IMPORT;
}

export type ImportFailure =
  | "invalid"
  | "invalidAtTop"
  | "unavailable"
  | "timeout"
  | "origin"
  | "limit"
  | "moved"
  | "missingRevision"
  | "shortCommit"
  | "removed"
  | "other";

const FAILURE_KINDS: Readonly<Record<string, ImportFailure>> = {
  SOURCE_INVALID: "invalid",
  SOURCE_UNAVAILABLE: "unavailable",
  SOURCE_TIMEOUT: "timeout",
  SOURCE_ORIGIN_REJECTED: "origin",
  SOURCE_LIMIT_EXCEEDED: "limit",
  SOURCE_REVISION_MISMATCH: "moved",
  SOURCE_REVISION_NOT_FOUND: "missingRevision",
  RESOURCE_NOT_FOUND: "removed",
  PRECONDITION_FAILED: "removed",
};

const SHORT_COMMIT = /^[0-9a-f]{4,39}$/i;

export function importFailureKind(
  code: string | null,
  folder: string,
  revision: string,
): ImportFailure {
  const kind = FAILURE_KINDS[code ?? ""] ?? "other";
  if (kind === "missingRevision" && SHORT_COMMIT.test(revision)) {
    return "shortCommit";
  }
  return kind === "invalid" && cleanFolder(folder) === ""
    ? "invalidAtTop"
    : kind;
}
