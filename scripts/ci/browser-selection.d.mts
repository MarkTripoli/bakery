export type BrowserSelection = {
  readonly full: boolean;
  readonly webSpecs: readonly string[];
  readonly storybook: boolean;
  readonly reason: string;
};
export type BrowserChange = {
  readonly status: string;
  readonly paths: readonly string[];
};
export function selectBrowserChecks(
  entries: readonly BrowserChange[],
): BrowserSelection;
export function readBrowserSelection(
  env?: Readonly<Record<string, string | undefined>>,
  git?: (
    command: string,
    args: readonly string[],
    options: { readonly encoding: "utf8" },
  ) => string,
): BrowserSelection;
export function retainExistingConsumers(
  selection: BrowserSelection,
  testExists: (spec: string) => boolean,
): BrowserSelection;
