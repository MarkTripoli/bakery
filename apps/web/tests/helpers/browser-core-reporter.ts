import { basename } from "node:path";
import type { FullResult, Reporter, Suite } from "@playwright/test/reporter";
import { coreCoverageIssues } from "../../../../scripts/ci/browser-core.mjs";

export default class BrowserCoreReporter implements Reporter {
  private suite?: Suite;

  onBegin(_config: unknown, suite: Suite): void {
    this.suite = suite;
  }

  onEnd(result: FullResult): Promise<{ status: FullResult["status"] }> {
    const tests = this.suite?.allTests().map((test) => ({
      project: test.parent.project()?.name ?? "",
      file: basename(test.location.file),
      title: test.title,
      outcome: test.outcome(),
      status: test.results.at(-1)?.status,
    })) ?? [];
    const issues = coreCoverageIssues(tests, {
      presentOnly: process.env.BAKERY_BROWSER_CORE_PRESENT_ONLY === "1",
    });
    for (const issue of issues) console.error(`browser core: ${issue}`);
    return Promise.resolve({
      status: issues.length ? "failed" : result.status,
    });
  }
}
