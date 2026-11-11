import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { transform } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkArtifactsSourceBytes } from "../scripts/render-artifacts-references.mjs";
const { enterpriseLaunchOptions } = await import(
  new URL("../scripts/render-enterprise-references.mjs", import.meta.url).href
);

const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../../docs/technical-design/artifacts-mocks/source-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("artifacts source pins every authored frame and font", async () => {
  assert.deepEqual(await checkArtifactsSourceBytes(manifest), []);
  const changed = structuredClone(manifest);
  changed.screens[0].sha256 = "0".repeat(64);
  assert.match(
    (await checkArtifactsSourceBytes(changed)).join("\n"),
    /source hash mismatch/,
  );
  changed.screens[0].source = "missing-frame.jsx";
  assert.match(
    (await checkArtifactsSourceBytes(changed)).join("\n"),
    /missing-frame.jsx: missing or source hash mismatch/,
  );
});

test("artifacts source rejects removed and duplicate frames", async () => {
  const missing = structuredClone(manifest);
  missing.screens.pop();
  assert.ok(
    (await checkArtifactsSourceBytes(missing)).includes(
      "source frame inventory mismatch",
    ),
  );
  const duplicate = structuredClone(manifest);
  duplicate.screens[1].nodeId = duplicate.screens[0].nodeId;
  assert.ok(
    (await checkArtifactsSourceBytes(duplicate)).includes(
      "duplicate source frame id",
    ),
  );
});

test("task references retain the flush task shell and responsive artifact pane", async () => {
  const browser = await chromium.launch(enterpriseLaunchOptions());
  try {
    for (const device of ["desktop", "phone"]) {
      const phone = device === "phone";
      const page = await browser.newPage({
        viewport: { width: phone ? 390 : 1440, height: 960 },
        hasTouch: phone,
      });
      try {
        for (
          const screen of manifest.screens.filter((screen) =>
            screen.id === "task-run" && screen.device === device
          )
        ) {
          const source = await readFile(
            new URL(
              `../../../docs/technical-design/artifacts-mocks/source/${screen.source}`,
              import.meta.url,
            ),
            "utf8",
          );
          const { code } = await transform(`const view = ${source};`, {
            loader: "jsx",
            jsxFactory: "createElement",
          });
          const view = new Function("createElement", `${code}; return view;`)(
            createElement,
          );
          await page.setContent(
            "<style>*{box-sizing:border-box}html,body{margin:0;padding:0}</style>" +
              renderToStaticMarkup(view),
          );
          const geometry = await page.evaluate(() => {
            const box = (selector) => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x,
                width: rect.width,
                padding: getComputedStyle(element).padding,
              };
            };
            return {
              header: box("[data-shell-header]"),
              main: box("main"),
              title: box("h1"),
              inspector: box("[data-shell-inspector]"),
              pane: box('aside[aria-label="Artifact"]'),
              preview: document.querySelector(
                '[role="region"][aria-label="Artifact text preview"]',
              )?.textContent,
              coarse: matchMedia("(pointer: coarse)").matches,
              width: document.documentElement.scrollWidth,
            };
          });
          assert.equal(geometry.main?.padding, "0px", screen.frameName);
          assert.equal(geometry.header?.width, phone ? 390 : 735);
          assert.equal(geometry.main?.width, phone ? 390 : 735);
          assert.equal(geometry.title?.x, phone ? 20 : 232);
          assert.equal(geometry.pane?.x, phone ? 20 : 944);
          assert.equal(geometry.pane?.width, phone ? 350 : 496);
          if (phone) assert.equal(geometry.inspector, null);
          else {
            assert.equal(geometry.inspector?.x, 943);
            assert.equal(geometry.inspector?.width, 497);
          }
          assert.match(geometry.preview ?? "", /Artifact retention/);
          assert.equal(geometry.coarse, phone);
          assert.equal(geometry.width, phone ? 390 : 1440);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
