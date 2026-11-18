#!/usr/bin/env node
// Captures the bell's four badge states on the real top bar, and refuses to
// keep a still that does not prove the state it claims.
//
//   node scripts/evidence/notification-badge-states/capture.mjs \
//     --web http://127.0.0.1:5199 --api http://127.0.0.1:32800 \
//     --out /tmp/badge-states
//
// It runs the whole set in one process, seeding between phases:
//
//   base      -> B1  a count in the badge
//   bulk      -> B2  past the 99 cap, so the badge reads "99+"
//   read-all  -> B0  a true zero, so no badge at all
//   (no seed) -> B3  the count request failing, so a hollow ring
//
// Before every shot it asserts the state two ways: the server's own count (so
// the seed really produced the number) and the page's accessible name plus
// drawn badge (so the still shows it). B3 is the exception: its precondition is
// that the count request fails, which the capture causes at the network layer.
//
// The rules this encodes, so the next seat inherits the method rather than the
// war stories:
//   - assert the precondition before the shot, never after;
//   - assert both channels (the name and the drawing), because a badge is a
//     drawn cap and the name is where the true count lives;
//   - hash every still and fail on a duplicate, because two identical frames
//     under two names prove nothing;
//   - write a manifest so the set is checkable later.
//
// Environment: the stack's `.env.<project>` must be sourced first, because the
// seed runs as a child process and reads DATABASE_URL from it.
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { assertDistinct, writeManifest } from "../stills.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const WEB = args.get("--web") ?? "http://127.0.0.1:5199";
const API = args.get("--api") ?? "http://127.0.0.1:32800";
const OUT = args.get("--out") ?? "/tmp/badge-states";
const EMAIL = args.get("--email") ?? "evidence@example.test";
const PASSWORD = args.get("--password") ?? "Evidence-Pass-1";
const SEED = new URL("./seed.ts", import.meta.url).pathname;

/** The unread count `bulk` leaves behind; keep in step with seed.ts. */
const BULK_UNREAD = 120;

/**
 * Each state: the seed that produces it, the count the server must report, and
 * what the page must show. `count: null` means the count request must fail.
 */
const STATES = [
  {
    id: "b1",
    seed: "base",
    count: 6,
    name: "Notifications, 6 unread",
    badge: "6",
    unknown: false,
  },
  {
    id: "b2",
    seed: "bulk",
    count: BULK_UNREAD,
    name: `Notifications, ${BULK_UNREAD} unread`,
    badge: "99+",
    unknown: false,
  },
  {
    id: "b0",
    seed: "read-all",
    count: 0,
    name: "Notifications",
    badge: null,
    unknown: false,
  },
  {
    id: "b3",
    seed: null,
    count: null,
    name: "Notifications, count unavailable",
    badge: null,
    unknown: true,
  },
];

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];
const THEMES = ["light", "dark"];

function seed(mode) {
  const result = spawnSync(
    "deno",
    ["run", "-A", SEED, mode],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`seed ${mode} failed with ${result.status}`);
  }
}

const browser = await chromium.launch();

// One sign-in for the whole run: the auth endpoint rate-limits repeated
// attempts, and every context can carry the same real session cookie. Cookies
// are host-scoped, not port-scoped, so the session taken against the API's own
// trusted origin is the one the web origin reads.
//
// It is lazy because the first seed is what creates the admin: signing in
// before any seed runs would 401 on a fresh database.
let session;
async function getSession() {
  if (session !== undefined) return session;
  const context = await browser.newContext();
  // The auth endpoint rate-limits repeated attempts, and a harness that dies on
  // a 429 is a harness the next seat works around by hand. Back off and retry.
  let signIn;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    signIn = await context.request.post(
      `${API}/api/auth/sign-in/email`,
      { data: { email: EMAIL, password: PASSWORD } },
    );
    if (signIn.status() !== 429) break;
    const wait = attempt * 20000;
    console.log(`  signin rate-limited; waiting ${wait / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  if (!signIn.ok()) throw new Error(`signin ${signIn.status()}`);
  session = await context.cookies(API);
  await context.close();
  return session;
}

/** The server's own count, so the seed is proven before the page is judged. */
async function serverCount(context) {
  const response = await context.request.get(`${API}/v1/notifications/count`, {
    headers: { "Bakery-Organization-Id": await organizationId(context) },
  });
  if (!response.ok()) throw new Error(`count ${response.status()}`);
  return (await response.json()).unread;
}

// The count route is organization-scoped, so the request needs the header. The
// seeded admin has exactly one organization (its personal one), which is the
// one the seed wrote to.
let cachedOrganizationId;
async function organizationId(context) {
  if (cachedOrganizationId !== undefined) return cachedOrganizationId;
  const response = await context.request.get(`${API}/v1/organizations`);
  if (!response.ok()) throw new Error(`organizations ${response.status()}`);
  const body = await response.json();
  cachedOrganizationId = body.items?.[0]?.id;
  if (cachedOrganizationId === undefined) {
    throw new Error("the seeded admin has no organization");
  }
  return cachedOrganizationId;
}

/**
 * The badge is placed with `inset-inline-start`, so a right-to-left page moves
 * it to the icon's top left. That is a designed position, not a mirror check
 * bolted on afterwards, so it is captured here with the same preconditions as
 * every other still. `dir` has to be set on the theme provider's own wrapper as
 * well as on `<html>`: the wrapper writes an explicit direction and would
 * otherwise win, which is a trap worth paying for once.
 */
async function applyRightToLeft(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute("dir", "rtl");
    const provider = document.querySelector(
      '[data-ui-component="themeProvider"]',
    );
    provider?.setAttribute("dir", "rtl");
  });
}

/**
 * Fails loudly if the page is not in the state the still will claim. The bell
 * reaches the screen two ways — a popover trigger from 744px up, and its own
 * button on a phone — so this asserts on the badge parts and the accessible
 * name, which both draw.
 */
async function assertState(page, state) {
  const trigger = page
    .locator(
      'button[aria-label^="Notifications"], [data-ui-component="notificationBell"] button',
    )
    .first();
  await trigger.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(
    (name) => {
      const button = document.querySelector(
        'button[aria-label^="Notifications"], [data-ui-component="notificationBell"] button',
      );
      return button?.getAttribute("aria-label") === name;
    },
    state.name,
    { timeout: 20000 },
  );
  const name = await trigger.getAttribute("aria-label");
  if (name !== state.name) {
    throw new Error(`${state.id}: name "${name}" != "${state.name}"`);
  }

  const badge = page.locator('[data-ui-part="notificationBadge"]');
  const badgeCount = await badge.count();
  if (state.badge === null) {
    if (badgeCount !== 0) {
      throw new Error(
        `${state.id}: expected no count badge, found ${badgeCount}`,
      );
    }
  } else {
    const text = (await badge.first().textContent())?.trim();
    if (text !== state.badge) {
      throw new Error(`${state.id}: badge "${text}" != "${state.badge}"`);
    }
  }

  const unknown = await page
    .locator('[data-ui-part="notificationBadgeUnknown"]')
    .count();
  if ((unknown > 0) !== state.unknown) {
    throw new Error(`${state.id}: unknown ring present=${unknown > 0}`);
  }
  return trigger;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const state of STATES) {
  if (state.seed !== null) seed(state.seed);

  for (const [label, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
      });
      await context.addCookies(await getSession());
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") {
          console.log("  console:", message.text().slice(0, 140));
        }
      });

      // B3 is the count request failing: abort it at the network layer, which
      // is exactly the condition the state exists for. Everything else loads.
      if (state.count === null) {
        await page.route(
          "**/v1/notifications/count*",
          (route) => route.abort(),
        );
      } else {
        const count = await serverCount(context);
        if (count !== state.count) {
          throw new Error(
            `${state.id}: server count ${count} != ${state.count}; the seed did not produce the state`,
          );
        }
      }

      await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded" });
      const trigger = await assertState(page, state);
      await page.waitForTimeout(600);

      const name = `${state.id}--${theme}--${label}`;
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      console.log("  shot", name);

      // A wide strip of the top bar around the bell: the badge overhangs the
      // button's box, and a tight square is unreadable at review size.
      const box = await trigger.boundingBox();
      if (box !== null) {
        const x = Math.max(0, box.x - 40);
        const y = Math.max(0, box.y - 14);
        await page.screenshot({
          path: join(OUT, `${name}--crop.png`),
          clip: {
            x,
            y,
            width: Math.min(viewport.width - x, 220),
            height: Math.min(viewport.height - y, box.height + 28),
          },
        });
        console.log("  shot", `${name}--crop`);
      }

      // Right to left, at the same state and re-asserted: the badge must move
      // to the icon's top left and stay whole, so a shot that merely "looks
      // mirrored" is not enough. Only the desktop width; the phone flakes at
      // this width in a popover-free bar and RTL placement is not width-scoped.
      if (label === "desktop") {
        await applyRightToLeft(page);
        await page.waitForTimeout(600);
        const rtlTrigger = await assertState(page, state);
        const rtlName = `${name}--rtl`;
        const rtlBox = await rtlTrigger.boundingBox();
        if (rtlBox !== null) {
          const rtlX = Math.max(0, rtlBox.x - 140);
          const rtlY = Math.max(0, rtlBox.y - 14);
          await page.screenshot({
            path: join(OUT, `${rtlName}--crop.png`),
            clip: {
              x: rtlX,
              y: rtlY,
              width: Math.min(viewport.width - rtlX, 220),
              height: Math.min(viewport.height - rtlY, rtlBox.height + 28),
            },
          });
          console.log("  shot", `${rtlName}--crop`);
        }
      }

      await context.close();
    }
  }
}

await browser.close();

const files = (await readdir(OUT))
  .filter((file) => file.endsWith(".png"))
  .sort()
  .map((file) => join(OUT, file));
const distinct = await assertDistinct(files);
const manifest = await writeManifest(OUT, {
  schema: "bakery.notification-badge-states-evidence/v1",
  files,
  states: STATES.map((state) => state.id),
  viewports: VIEWPORTS.map(([label, size]) => ({ label, ...size })),
  themes: THEMES,
  rightToLeft: "desktop only; the badge mirrors to the icon's top left",
  note:
    "B3 is the count request aborted at the network layer; the underlying data was a true zero, so the ring is the app refusing to claim a zero it could not confirm.",
});
console.log(
  `EVIDENCE_MANIFEST=${manifest} files=${files.length} distinct=${distinct}`,
);
