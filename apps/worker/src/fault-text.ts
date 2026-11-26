export const PROBLEM_TITLE_MAX_LENGTH = 200;
export const PROBLEM_DETAIL_MAX_LENGTH = 2000;
export const PROBLEM_ISSUES_MAX_ITEMS = 50;
export const ISSUE_PATH_MAX_LENGTH = 500;
export const ISSUE_CODE_MAX_LENGTH = 100;
export const ISSUE_MESSAGE_MAX_LENGTH = 500;

const ELLIPSIS = "…";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fitText(value: unknown, maxLength: number): unknown {
  if (typeof value !== "string" || value.length <= maxLength) return value;
  let cut = maxLength - ELLIPSIS.length;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return value.slice(0, cut) + ELLIPSIS;
}

function fitIssue(issue: unknown): unknown {
  if (!isRecord(issue)) return issue;
  return {
    ...issue,
    ...("path" in issue
      ? { path: fitText(issue.path, ISSUE_PATH_MAX_LENGTH) }
      : {}),
    ...("code" in issue
      ? { code: fitText(issue.code, ISSUE_CODE_MAX_LENGTH) }
      : {}),
    ...("message" in issue
      ? { message: fitText(issue.message, ISSUE_MESSAGE_MAX_LENGTH) }
      : {}),
  };
}

export function fitFaultText(fault: unknown): unknown {
  if (!isRecord(fault)) return fault;
  return {
    ...fault,
    ...("title" in fault
      ? { title: fitText(fault.title, PROBLEM_TITLE_MAX_LENGTH) }
      : {}),
    ...("detail" in fault
      ? { detail: fitText(fault.detail, PROBLEM_DETAIL_MAX_LENGTH) }
      : {}),
    ...(Array.isArray(fault.issues)
      ? {
        issues: fault.issues.slice(0, PROBLEM_ISSUES_MAX_ITEMS).map(fitIssue),
      }
      : {}),
  };
}
