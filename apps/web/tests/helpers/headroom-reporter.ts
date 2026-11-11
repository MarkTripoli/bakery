import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { basename } from "node:path";

interface Row {
  ratio: number;
  label: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Reports per-test duration against the effective test timeout and the
 * duration of `first render` steps. Informational: never fails the run.
 */
export default class HeadroomReporter implements Reporter {
  private readonly rows: Row[] = [];
  private readonly firstRender: number[] = [];
  private firstRenderFailed = 0;

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "test.step" || step.title !== "first render") return;
    this.firstRender.push(step.duration);
    if (step.error) this.firstRenderFailed += 1;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped" || !test.timeout) return;
    const project = test.parent.project()?.name ?? "";
    this.rows.push({
      ratio: result.duration / test.timeout,
      label: `${(result.duration / test.timeout).toFixed(2)} ${project} ${
        basename(test.location.file)
      }:${test.location.line} ${test.title} ${
        Math.round(result.duration)
      }/${test.timeout}`,
    });
  }

  onEnd(_result: FullResult): void {
    const sorted = [...this.rows].sort((a, b) => b.ratio - a.ratio);
    const over = sorted.filter((row) => row.ratio > 0.5).length;
    const top = sorted[0];
    console.log(
      `headroom: ${sorted.length} tests, ${over} over half budget, max ${
        top ? top.label : "none"
      }`,
    );
    for (const row of sorted.slice(0, 15)) {
      console.log(`headroom:   ${row.label}`);
    }
    const durations = [...this.firstRender].sort((a, b) => a - b);
    console.log(
      `first-render: ${durations.length} steps, ${this.firstRenderFailed} failed, p50 ${
        Math.round(percentile(durations, 0.5))
      } p99 ${Math.round(percentile(durations, 0.99))} max ${
        Math.round(durations.at(-1) ?? 0)
      }`,
    );
  }
}
