export const browserCore: readonly (readonly [string, string, string])[];
export const AUTH_BOOTSTRAP_PROJECT: "desktop-auth-bootstrap";
export function coreGrep(project: string): RegExp;
export function coreCoverageIssues(
  tests: readonly {
    readonly project: string;
    readonly file: string;
    readonly title: string;
    readonly outcome: string;
    readonly status: string | undefined;
  }[],
  options?: { readonly presentOnly?: boolean },
): string[];
export function coreListingIssues(
  tests: readonly {
    readonly project: string;
    readonly file: string;
    readonly title: string;
  }[],
): string[];
