import { assertEquals } from "@std/assert";
import { nativeOutputChildFailureMessage } from "./helpers/native-output-child-diagnostics.ts";

const CHILD_TIMEOUT_MS = 180_000;
const CHILD_KILL_GRACE_MS = 5_000;
type ChildTimer = number | NodeJS.Timeout;

async function runBounded(
  command: Deno.Command,
): Promise<{ output: Deno.CommandOutput; timedOut: boolean }> {
  const child = command.spawn();
  let killTimer: ChildTimer | undefined;
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The permissioned child already exited.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The permissioned child exited during its cleanup grace.
      }
    }, CHILD_KILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);
  try {
    return { output: await child.output(), timedOut };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
  }
}

Deno.test("real worker main captures bounded native output through API and PostgreSQL", async () => {
  const retainedReport = Deno.env.get("BAKERY_NATIVE_OUTPUT_REPORT")?.trim();
  const reportPath = retainedReport || await Deno.makeTempFile({
    prefix: "bakery-native-output-report-",
    suffix: ".json",
  });
  const childPath = new URL(
    "./capture-bounded-native-output.child.ts",
    import.meta.url,
  ).pathname;
  const dockerHost = Deno.env.get("DOCKER_HOST")?.trim();
  if (!dockerHost) throw new Error("DOCKER_HOST_REQUIRED");
  try {
    const { output: result, timedOut } = await runBounded(
      new Deno.Command("systemd-run", {
        args: [
          "--user",
          "--scope",
          "--quiet",
          "--property=Delegate=yes",
          `--setenv=DOCKER_HOST=${dockerHost}`,
          `--setenv=BAKERY_NATIVE_OUTPUT_REPORT=${reportPath}`,
          Deno.execPath(),
          "test",
          "--allow-all",
          childPath,
        ],
        stdout: "piped",
        stderr: "piped",
      }),
    );
    if (!result.success) {
      throw new Error(
        nativeOutputChildFailureMessage(result.code, result, timedOut),
      );
    }
    const report = JSON.parse(await Deno.readTextFile(reportPath)) as Record<
      string,
      unknown
    >;
    assertEquals(report.tcpReadiness, true);
    assertEquals(report.ownerSqlAuth, true);
    assertEquals(report.appSqlAuth, true);
    assertEquals(report.badSqlAuthRejected, true);
    assertEquals(report.workerMain, true);
    assertEquals(report.nativeExecutor, true);
    assertEquals(report.productionRoutes, true);
    assertEquals(report.postgresPersistence, true);
    assertEquals(report.cleanupPassed, true);
    assertEquals(report.capture, "complete");
    assertEquals(report.reason, "clean-end");
    assertEquals(
      (report.cancellation as Record<string, unknown>).apiCleanup,
      true,
    );
    const inspection = report.inspection as Record<string, unknown>;
    assertEquals(inspection.inspectionByteIdentity, true);
    assertEquals(
      inspection.parserInputSha256,
      inspection.persistedReportSha256,
    );
    const replacement = report.replacement as Record<string, unknown>;
    assertEquals(replacement.producerReplacement, true);
    assertEquals(replacement.ackLossReplay, true);
    assertEquals(replacement.carryDiscarded, true);
    assertEquals(replacement.workerMainExecutions, 2);
    assertEquals(replacement.authorityTransitions, 2);
    assertEquals(replacement.workerHosts, 2);
    assertEquals(replacement.writerGeneration, "2");
    assertEquals(replacement.highwater, "2");
    assertEquals(
      (report.totalDrain as Record<string, unknown>).totalDrainForced,
      true,
    );
  } finally {
    if (!retainedReport) {
      await Deno.remove(reportPath).catch(() => undefined);
    }
  }
});
