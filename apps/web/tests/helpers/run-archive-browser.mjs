import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { enterpriseLaunchOptions } from "../../../../packages/ui/scripts/render-enterprise-references.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const {
  baseUrl,
  taskId,
  organizationId,
  sessionCookie,
  streamId,
  segments,
  canary,
  phase,
} = JSON.parse(input);
const browser = await chromium.launch({
  headless: true,
  ...enterpriseLaunchOptions(),
});
try {
  for (
    const viewport of [{ width: 1440, height: 1100 }, {
      width: 390,
      height: 844,
    }]
  ) {
    const context = await browser.newContext({
      viewport,
      acceptDownloads: true,
    });
    try {
      const split = sessionCookie.indexOf("=");
      await context.addCookies([{
        name: sessionCookie.slice(0, split),
        value: sessionCookie.slice(split + 1).split(";", 1)[0],
        domain: new URL(baseUrl).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }]);
      await context.addInitScript(({ organizationId }) => {
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          organizationId,
        );
      }, { organizationId });
      const page = await context.newPage();
      await page.goto(baseUrl + "/tasks/" + taskId, {
        waitUntil: "networkidle",
      });
      const selector = page.getByRole("combobox", {
        name: "Output stream",
        exact: true,
      });
      const panel = page.locator('[data-ui-component="runOutputPanel"]');
      // networkidle is not render: the panel arrives through chained run,
      // step and stream queries, 1-2.5 s after idle on a fast host. The stream
      // selector renders with it, so count it only once the panel is there.
      const selectStream = async () => {
        await panel.waitFor({ state: "attached", timeout: 45_000 });
        if (await selector.count()) await selector.selectOption(streamId);
      };
      await selectStream();
      await expect(panel).toHaveAttribute(
        "data-state",
        phase === "retained" ? "truncated" : "reset",
      );
      assert(!(await panel.innerText()).includes(canary));
      if (phase === "retained") {
        // 8 MiB replays in <=256 KiB pages at the server's 500 ms cadence:
        // at least 16 seconds before the terminal marker can arrive.
        await expect(panel.getByText(
          "Truncated · sequence " + segments.at(-1).lastSequence,
          { exact: true },
        )).toBeVisible({ timeout: 45_000 });
        await expect(
          panel.getByText("Native output truncated: display-byte-limit.", {
            exact: true,
          }),
        ).toHaveCount(1);
        await page.reload({ waitUntil: "networkidle" });
        await selectStream();
        // 8 MiB replays in <=256 KiB pages at the server's 500 ms cadence:
        // at least 16 seconds before the terminal marker can arrive.
        await expect(panel.getByText(
          "Truncated · sequence " + segments.at(-1).lastSequence,
          { exact: true },
        )).toBeVisible({ timeout: 45_000 });
        await expect(
          panel.getByText("Native output truncated: display-byte-limit.", {
            exact: true,
          }),
        ).toHaveCount(1);
      }
      const reconstructed = [];
      for (const segment of segments) {
        const action = panel.getByRole("button", {
          name: `Download transcript ${
            segment.segmentIndex + 1
          } · sequences ${segment.firstSequence}–${segment.lastSequence}`,
          exact: true,
        });
        if (phase === "expired") {
          await action.click();
          await expect(
            panel.getByText(
              "Transcript bytes expired. Immutable version metadata remains available.",
              { exact: true },
            ),
          ).toHaveCount(segment.segmentIndex + 1);
          continue;
        }
        const waiting = page.waitForEvent("download");
        await action.click();
        const download = await waiting;
        const reader = await download.createReadStream();
        assert(reader);
        const chunks = [];
        for await (const chunk of reader) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, segment.sizeBytes);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          segment.sha256,
        );
        assert(!bytes.toString().includes(canary));
        const transcript = JSON.parse(bytes.toString());
        assert.equal(transcript.streamId, streamId);
        assert.equal(transcript.firstSequence, segment.firstSequence);
        assert.equal(transcript.lastSequence, segment.lastSequence);
        reconstructed.push(...transcript.batches);
      }
      if (phase !== "expired") {
        assert.equal(
          new Set(reconstructed.map((batch) => batch.sequence)).size,
          reconstructed.length,
        );
        const text = reconstructed.flatMap((batch) =>
          batch.parts.map((part) => part.text)
        ).join("");
        assert(text.includes("[REDACTED]"));
        assert(text.includes("Native output truncated: display-byte-limit."));
      }
      await mkdir(".omo/evidence/run-integration-resume", { recursive: true });
      await page.screenshot({
        path:
          `.omo/evidence/run-integration-resume/archive-${phase}-${viewport.width}.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
