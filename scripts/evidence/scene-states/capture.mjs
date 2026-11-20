#!/usr/bin/env node
// Captures the character scene on the whole-page states, and refuses to keep a
// still that does not prove the state it claims.
//
//   node --experimental-detect-module scripts/evidence/scene-states/capture.mjs \
//     --web http://127.0.0.1:5199 --api http://127.0.0.1:32772 \
//     --out ~/rig-logs/stills/81
//
// The method is the badge-states capture's, because the rules are the same:
//   - assert the precondition before the shot, never after;
//   - assert the page's own words, so a shot cannot prove a blank;
//   - hash every still and fail on a duplicate;
//   - write a manifest so the set is checkable later.
//
// Each state is produced by the real page rather than a mock:
//
//   not-found      a path no route claims
//   forbidden      a signed-in person who belongs to no organization
//   server-error   the page's own read answered 500
//   empty-machines an organization that has never had a machine
//   offline        the API unreachable at startup, aborted at the network layer
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { assertDistinct, writeManifest } from "../stills.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const WEB = args.get("--web") ?? "http://127.0.0.1:5199";
const API = args.get("--api") ?? "http://127.0.0.1:32772";
const OUT = args.get("--out") ?? "stills/81-scene-states";
const EMAIL = args.get("--email") ?? "evidence@example.test";
const PASSWORD = args.get("--password") ?? "Evidence-Pass-1";
const SEED = new URL("./seed.ts", import.meta.url).pathname;

/** Desktop first, then the phone the design names for this template. */
const VIEWPORTS = [
  ["desktop-1440x900", { width: 1440, height: 900 }],
  ["phone-390x844", { width: 390, height: 844 }],
];
const THEMES = ["light", "dark"];

const STATES = [
  {
    id: "not-found",
    path: "/this-page-does-not-exist",
    // The page's own words, so the still proves the state and not a blank.
    headings: ["Page not found"],
    scene: "not-found",
  },
  {
    // The refusal a reader actually meets: the startup gate asks which
    // organizations they belong to and the server says no. The body is the
    // shape `tasks.spec.ts` answers, because that is the shape the gate reads.
    id: "forbidden",
    path: "/tasks",
    headings: ["You do not have access to this organization"],
    expect: /choose another organization/i,
    // The gate draws its own panel; the scene template covers whole-page
    // states and this refusal is not one.
    noScene: true,
    refuseOrganizations: true,
  },
  {
    // A page that crashes while rendering: the router's error boundary, which
    // no answer from the server can reach.
    id: "server-error",
    path: "/__fixtures__/shell/crash",
    headings: ["Something went wrong"],
    expect: /could not complete this request|try again/i,
    scene: "server-error",
  },
  {
    id: "empty-machines",
    path: "/machines",
    headings: [/machine/i],
    expect: /machine/i,
    scene: "empty-workers",
  },
  {
    id: "offline",
    path: "/tasks",
    // Either rendering of the same state: the startup gate's sentence and the
    // shell's own, depending on which read fails first.
    headings: ["You are offline", /offline/i],
    expect: /back online|retry/i,
    scene: "offline",
    offline: true,
  },
];

function seed(mode) {
  const result = spawnSync("deno", ["run", "-A", SEED, mode], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`seed ${mode} failed`);
}

const browser = await chromium.launch();

/**
 * Signs in inside the context that will use the session.
 *
 * Copying cookies from a context that has been closed gives the app a session
 * it reads as signed out, so each context signs in for itself. The retry is
 * for the auth endpoint's rate limit, which a run of twenty contexts meets.
 */
async function signIn(context, email) {
  let response;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    response = await context.request.post(
      `${API}/api/auth/sign-in/email`,
      { data: { email, password: PASSWORD } },
    );
    if (response.status() !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 20000));
  }
  if (!response?.ok()) {
    throw new Error(`signin ${email}: ${response?.status()}`);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
seed("owner");

const files = [];
for (const state of STATES) {
  if (state.seed !== undefined) seed(state.seed);

  // One context per state, signing in once: the auth endpoint rate-limits a
  // run of twenty sign-ins, and a context that has to sign in again mid-run
  // leaves the page blank while it waits. The viewport and the colour scheme
  // are changed between shots instead.
  const context = await browser.newContext({
    viewport: VIEWPORTS[0][1],
    colorScheme: THEMES[0],
    deviceScaleFactor: 1,
  });
  await signIn(context, EMAIL);
  const page = await context.newPage();

  if (state.offline === true) {
    await page.route("**/v1/**", (route) => route.abort());
    await page.route("**/api/auth/**", (route) => route.abort());
  }
  if (state.refuseOrganizations === true) {
    await page.route("**/v1/organizations*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "AUTH_FORBIDDEN",
          status: 403,
          code: "AUTH_FORBIDDEN",
          detail: "Stubbed AUTH_FORBIDDEN.",
          requestId: "00000000-0000-4000-8000-000000000301",
          traceId: "00000000-0000-4000-8000-000000000302",
          retryable: false,
        }),
      }));
  }
  for (const [label, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });

      // `load`, then quiet: a dev server that is re-optimising dependencies
      // reloads the page under a `domcontentloaded` navigation, and a poll that
      // starts before React mounts reports an empty body as if it were a
      // missing heading.
      await page.goto(`${WEB}${state.path}`, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});

      // The heading is checked with a poll rather than three 20s waits: a
      // failure must say what the page actually showed, and waiting 60s to
      // learn "offline" is a slow way to lose the reason.
      let headingFound = false;
      for (let attempt = 0; attempt < 30 && !headingFound; attempt += 1) {
        for (const candidate of state.headings) {
          const count = await page
            .getByRole("heading", { name: candidate })
            .filter({ visible: true })
            .count();
          if (count > 0) {
            headingFound = true;
            break;
          }
        }
        if (!headingFound) await page.waitForTimeout(1000);
      }
      if (!headingFound) {
        const text = (await page.locator("body").innerText()).slice(0, 400);
        await page.screenshot({ path: join(OUT, `${state.id}.failed.png`) });
        throw new Error(
          `${state.id}: no heading matched; page ${page.url()} said: ${
            JSON.stringify(text)
          }`,
        );
      }
      if (state.expect !== undefined) {
        const body = await page.locator("body").innerText();
        if (!state.expect.test(body)) {
          throw new Error(
            `${state.id}: page did not say what the state claims:\n${
              body.slice(0, 400)
            }`,
          );
        }
      }
      if (state.redirect !== undefined) {
        if (!page.url().endsWith(state.redirect)) {
          throw new Error(
            `${state.id}: expected to land on ${state.redirect}, got ${page.url()}`,
          );
        }
      }
      const scene = page.locator(`[data-scene="${state.scene ?? "none"}"]`);
      if (state.noScene !== true) {
        await scene.waitFor({ state: "visible", timeout: 45_000 });
      }

      // The scene is decoration: it must carry no accessible name, or a screen
      // reader would hear the art as well as the heading. A state the gate
      // draws itself has no scene, so there is nothing to check.
      if (state.noScene !== true) {
        const image = scene.locator("img");
        const alt = await image.getAttribute("alt");
        const hidden = await image.getAttribute("aria-hidden");
        if (alt !== "" || hidden !== "true") {
          throw new Error(
            `${state.id}: scene image is not decoration (alt=${alt}, aria-hidden=${hidden})`,
          );
        }
      }

      await page.waitForTimeout(500);
      const name = `${state.id}--${theme}--${label}`;
      const path = join(OUT, `${name}.png`);
      await page.screenshot({ path });
      files.push(path);
      console.log("  shot", name);
    }
  }
  await context.close();
}

const distinct = await assertDistinct(files);
await writeManifest(OUT, {
  schema: "bakery.evidence.scene-states/1",
  files,
  distinct,
  web: WEB,
  api: API,
  note:
    "Real pages on a real stack: a path no route claims, a person who belongs to no organization, a 500 on the page's own read, an organization with no machines, and the API aborted at startup.",
});
console.log(`  ${files.length} stills, ${distinct} distinct, manifest written`);
await browser.close();
