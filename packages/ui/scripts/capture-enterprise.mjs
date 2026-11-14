// Captures the APP side (the candidate) of the enterprise Paper parity gate
// (and, via capture-settings.mjs, the settings gate, which runs this same code
// under manifestName "settings"):
// one route screenshot per case of enterprise-baselines.json, taken through the
// shared design-case capture in capture-stories.mjs under the same hermetic
// fontconfig the references were rendered with. Output lands in
// artifacts/ui-baseline/enterprise/runtime, beside (never over) the auth
// capture; compare-paper.mjs --manifest enterprise reads it back.
//
// capture-stories.mjs is a pinned K-0 input and is only imported here, never
// edited: its output directory comes from BAKERY_UI_ARTIFACTS_DIR at import
// time, so the enterprise directory is set before the (dynamic) import.
//
//   node scripts/capture-enterprise.mjs --all --web-base-url http://127.0.0.1:5173
//   node scripts/capture-enterprise.mjs --changed --web-base-url ...
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  artifactsDirectoryFor,
  baselinedCases,
  captureViewport,
  debtCases,
  manifestProfile,
  plannedCases,
  readRouteLedger,
} from "./paper-manifests.mjs";
import { enterpriseLaunchOptions } from "./render-enterprise-references.mjs";
import { fontDigests } from "./render-paper-references.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../../..");
const uiRoot = join(root, "packages/ui");
const tokenPath = join(root, "docs/technical-design/ui-baselines/tokens.json");
const MANIFEST_NAME = "enterprise";

// Renderer scripts whose change can move every reference of a site-rendered
// manifest: its own renderer, and the enterprise renderer settings builds on.
const RENDERER_SCRIPTS = {
  artifacts: [
    "packages/ui/scripts/render-artifacts-references.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ],
  enterprise: ["packages/ui/scripts/render-enterprise-references.mjs"],
  settings: [
    "packages/ui/scripts/render-settings-references.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ],
  entitlements: [
    "packages/ui/scripts/render-entitlements-references.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ],
  "worker-dark": [
    "packages/ui/scripts/render-worker-dark-references.mjs",
    "packages/ui/scripts/derive-worker-dark-source.mjs",
    "packages/ui/scripts/render-enterprise-references.mjs",
  ],
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalizePath = (path) => path.replaceAll("\\", "/");

// Inputs every production route renders through. A change to one can move any
// route's pixels, so route captures treat them as global.
const ROUTE_SHARED_INPUTS = new Set([
  "apps/web/src/router.tsx",
  "apps/web/src/main.tsx",
  "apps/web/src/index.css",
  "docs/technical-design/ui-baselines/tokens.json",
  "docs/technical-design/ui-baselines/paper-tokens.json",
  "docs/technical-design/ui-baselines/route-references.json",
]);
const ROUTE_SHARED_PREFIXES = [
  "apps/web/src/shell/",
  "apps/web/src/app/",
  "packages/i18n/",
  "packages/contracts/",
];

export function isRouteSharedInput(path) {
  return ROUTE_SHARED_INPUTS.has(path) ||
    ROUTE_SHARED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Paths whose change can alter any captured case: shared UI source, the
// capture and compare scripts, fixtures, baselines, and the workflow itself.
// Mirrors capture-stories.mjs's own global-change list (not exported there).
export function isGlobalChange(paths, { routesOnly = false } = {}) {
  if (routesOnly && paths.some(isRouteSharedInput)) return true;
  return paths.filter((path) =>
    // Route captures judge baseline and mock edits per case instead
    // (selectDesignCases), so those directories are not global for them.
    !routesOnly ||
    !(path.startsWith("docs/technical-design/ui-baselines/") ||
      path.startsWith("docs/technical-design/auth-mocks/"))
  ).some((path) =>
    path.startsWith("docs/technical-design/ui-baselines/") ||
    path.startsWith("docs/technical-design/auth-mocks/") ||
    path.startsWith("packages/ui/.storybook/") ||
    path.startsWith("packages/ui/scripts/") ||
    path === "packages/ui/package.json" ||
    path === "packages/ui/playwright.config.ts" ||
    path.startsWith("packages/ui/src/foundations/") ||
    (path.startsWith("packages/ui/src/") && !path.endsWith(".stories.tsx")) ||
    path === "scripts/verify-ui-stories.ts" ||
    path === "scripts/check-ui-architecture.mjs" ||
    path.startsWith("apps/web/src/fixtures/") ||
    path === "pnpm-lock.yaml" ||
    path === "turbo.json" ||
    path === ".github/workflows/ci.yml"
  );
}

const squash = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// Heuristic for "the ledger route's owning module changed". The ledger names
// the route (id and path) but not its source file, and the architecture
// checker only knows the file holding routeCoverage (router.tsx), which every
// route shares. So a changed apps/web/src file counts as owned by a route when
// its squashed path contains the squashed route id or the route's first static
// path segment (`/tasks/$taskId` -> "tasks", id "task-detail" -> "taskdetail").
// Over-matching only captures an extra case; it never skips one.
export function routeOwnedPaths(entry, paths) {
  const tokens = new Set(
    [
      entry.routeId,
      ...String(entry.path ?? "").split("/").filter((segment) =>
        segment && !segment.startsWith("$")
      ).slice(0, 1),
    ].map(squash).filter((token) => token.length >= 3),
  );
  return paths.filter((path) =>
    path.startsWith("apps/web/src/") &&
    [...tokens].some((token) => squash(path).includes(token))
  );
}

const sameJson = (left, right) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// Design (route) cases that a `--changed` run must capture: every non-planned
// case that is (a) new versus the merge-base manifest, (b) has changed
// reference inputs, or (c) belongs to a ledger route whose owning module
// changed, plus all of them on a global change. A planned case has no route to
// capture, so it is never selected. Without a base manifest every case counts
// as new. Returns the cases in manifest order.
export function selectDesignCases({
  designCases,
  manifestName = MANIFEST_NAME,
  paths,
  baseManifest,
  manifest,
  ledger,
  manifestRepoPath,
}) {
  const planned = plannedCases(ledger, manifestName);
  const debt = debtCases(ledger, manifest, manifestName);
  const candidates = designCases.filter((entry) =>
    !planned.has(entry.id) && !debt.has(entry.id)
  );
  if (!baseManifest || isGlobalChange(paths, { routesOnly: true })) {
    return candidates;
  }
  const baseCases = new Map(
    (baseManifest.cases ?? []).map((entry) => [entry.id, entry]),
  );
  // Inputs that produce every reference of the manifest: its pinned source
  // files and Paper source manifest, and the renderer and generator scripts.
  const sourceInputs = new Set([
    ...(manifest?.source?.inputs ?? []),
    ...(manifest?.source?.manifestPath ? [manifest.source.manifestPath] : []),
    ...(RENDERER_SCRIPTS[manifestName] ?? RENDERER_SCRIPTS[MANIFEST_NAME]),
    "packages/ui/scripts/paper-jsx-to-html.mjs",
    "packages/ui/scripts/image-score.mjs",
  ]);
  const manifestChanged = paths.includes(manifestRepoPath);
  const entryFor = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry.manifest !== manifestName) continue;
    for (const caseId of entry.cases ?? []) entryFor.set(caseId, entry);
  }
  // A baselined ledger case is always captured and scored: the trusted
  // verifier refuses `not-selected` for it.
  const baselined = baselinedCases(ledger, manifestName);
  return candidates.filter((entry) => {
    if (baselined.has(entry.id)) return true;
    const previous = baseCases.get(entry.id);
    if (!previous) return true;
    if (manifestChanged && !sameJson(previous, entry)) return true;
    if (paths.includes(entry.imagePath)) return true;
    if (paths.some((path) => sourceInputs.has(path))) return true;
    const owner = entryFor.get(entry.id);
    return owner ? routeOwnedPaths(owner, paths).length > 0 : false;
  });
}

// The manifest as committed at the merge base of HEAD and the run's base, or
// null when no base is known (a main push) or the manifest did not exist.
export function baseManifestAt({
  repoPath,
  baseSha = process.env.BAKERY_CAPTURE_BASE_SHA,
  baseRef = process.env.GITHUB_BASE_REF,
  git = execFileSync,
}) {
  const ref = baseSha || (baseRef ? `origin/${baseRef}` : null);
  if (!ref) return null;
  try {
    const mergeBase = git("git", ["merge-base", "HEAD", ref], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return JSON.parse(
      git("git", ["show", `${mergeBase}:${repoPath}`], {
        cwd: root,
        encoding: "utf8",
      }),
    );
  } catch {
    return null;
  }
}

// The case handed to the shared capture. A phone case with `deviceChrome` is
// captured at W x (H - top): the web app renders no device chrome, so a
// viewport without the `top` rows is what the reference rows [top, H) show.
// capture-stories.mjs is pinned and reads the viewport from the case object,
// so this returns a derived copy and leaves the manifest case untouched.
export function captureCaseFor(designCase) {
  if (!designCase.deviceChrome) return designCase;
  return { ...designCase, viewport: captureViewport(designCase) };
}

function installationSettingsCapturePage(page, designCase) {
  if (designCase.design?.screen !== "installation-settings") return page;
  const { state, theme } = designCase.design;
  if (
    designCase.candidate?.route !== "/__fixtures__/installation/settings" ||
    designCase.candidate?.session !== "authenticated" ||
    !["default", "save-error", "save-conflict"].includes(state) ||
    !["light", "dark"].includes(theme)
  ) {
    throw new Error("Unsupported installation settings capture recipe");
  }
  const goto = page.goto.bind(page);
  page.goto = async (...args) => {
    const updaterPrincipalId = "00000000-0000-4000-8000-000000000001";
    const principalId = "00000000-0000-4000-8000-000000000002";
    const organizationId = "00000000-0000-4000-8000-000000000003";
    const settings = {
      registrationMode: "invitation",
      organizationCreationPolicy: "installation_admins",
      version: 7,
      updatedByPrincipalId: updaterPrincipalId,
      updatedAt: "2026-10-02T14:12:00.000Z",
    };
    let writes = 0;
    await page.route("**/v1/installation/settings", (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(settings),
        });
      }
      if (request.method() !== "PATCH") return route.abort();
      writes++;
      const body = request.postDataJSON();
      if (
        request.headers()["if-match"] !== '"v7"' ||
        !request.headers()["idempotency-key"] ||
        body.registrationMode !== "closed" ||
        body.organizationCreationPolicy !== "installation_admins"
      ) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: "{}",
        });
      }
      const status = state === "save-conflict" ? 409 : 503;
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/installation-settings",
          title: "Settings were not saved",
          detail: "The fixture refused this settings update.",
          status,
          code: status === 409 ? "VERSION_CONFLICT" : "DEPENDENCY_UNAVAILABLE",
          retryable: status === 503,
          requestId: "00000000-0000-4000-8000-000000000010",
          traceId: "00000000-0000-4000-8000-000000000011",
        }),
      });
    });
    await page.route(
      "**/v1/installation/capabilities",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            registration: "invitation",
            organizationCreation: "installation_admins",
            ssoAvailable: false,
          }),
        }),
    );
    await page.route(
      "**/v1/me",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            principalId,
            principalType: "human",
            displayName: "Alex Morgan",
            locale: "en",
            direction: "ltr",
            catalogVersion: "10",
            twoFactorEnabled: false,
            timeZone: "UTC",
            email: "mark@example.test",
            backupCodesRemaining: null,
          }),
        }),
    );
    await page.route(
      "**/v1/user-preferences*",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: null,
            organizationId,
            principalId,
            theme: "system",
            locale: "en",
            timeZone: "UTC",
            effectiveLocale: "en",
            direction: "ltr",
            availableLocales: ["en", "en-XA", "ar-XB"],
            casVersion: 1,
            createdAt: null,
            updatedAt: null,
          }),
        }),
    );
    const response = await goto(...args);
    await page.waitForSelector(
      '[data-ui-component="installationSettingsForm"][data-state="default"]',
    );
    if (state !== "default") {
      await page.getByRole("radio", { name: /^Closed/ }).check();
      const outcome = page.waitForResponse((result) =>
        new URL(result.url()).pathname === "/v1/installation/settings" &&
        result.request().method() === "PATCH"
      );
      await page.getByRole("button", { name: "Save settings", exact: true })
        .click();
      const result = await outcome;
      const expectedStatus = state === "save-conflict" ? 409 : 503;
      if (result.status() !== expectedStatus || writes !== 1) {
        throw new Error(
          "Installation settings recipe did not exercise its expected PATCH outcome",
        );
      }
      await page.waitForSelector(
        `[data-ui-component="installationSettingsForm"][data-state="${
          state === "save-conflict" ? "conflict" : "error"
        }"]`,
      );
      const retainedDraft = page.locator('[data-policy-group="registration"]');
      if (
        await retainedDraft.getAttribute("data-policy-value") !== "closed" ||
        await retainedDraft.textContent() !== "Closed"
      ) {
        throw new Error("Installation settings recipe lost the rejected draft");
      }
    }
    return response;
  };
  return page;
}

// Single sign-on: the three Paper states of the route, driven
// through the fixture route against canned API answers. `list` shows two
// providers, the pending domain record and the require-SSO control; the add
// states open the in-page form and type the mock's values.
const SSO_CAPTURE_STATES = [
  "list",
  "add-oidc",
  "add-saml-and-domain-verification",
];

function ssoCapturePage(page, designCase) {
  if (designCase.design?.screen !== "sso") return page;
  const { state, theme } = designCase.design;
  if (
    designCase.candidate?.route !== "/__fixtures__/organization/sso" ||
    designCase.candidate?.session !== "authenticated" ||
    !SSO_CAPTURE_STATES.includes(state) ||
    !["light", "dark"].includes(theme)
  ) {
    throw new Error("Unsupported single sign-on capture recipe");
  }
  const goto = page.goto.bind(page);
  page.goto = async (...args) => {
    const principalId = "00000000-0000-4000-8000-000000000002";
    const organizationId = "00000000-0000-4000-8000-000000000003";
    const json = (body, status = 200) => ({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route(
      "**/api/auth/bakery-sso/providers**",
      (route) =>
        route.fulfill(json({
          enforce: false,
          providers: [
            {
              providerId: "Okta",
              issuer: "https://acme.okta.example/oauth2/default",
              domain: "acme.example",
              domainVerified: true,
              protocol: "oidc",
            },
            {
              providerId: "Entra",
              issuer: "https://login.example/entra",
              domain: "acme.example",
              domainVerified: false,
              protocol: "saml",
            },
          ],
        })),
    );
    await page.route(
      "**/api/auth/sso/request-domain-verification",
      (route) =>
        route.fulfill(
          json({ domainVerificationToken: "bk-verify=3f9c1a72" }, 201),
        ),
    );
    await page.route(
      "**/v1/installation/status",
      (route) => route.fulfill(json({ bootstrapped: true })),
    );
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() !== "GET"
          ? route.abort()
          : route.fulfill(json({
            items: [{
              id: organizationId,
              name: "Platform team",
              slug: "platform-team",
              logo: null,
              defaultLocale: null,
              metadata: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              version: 1,
              role: "admin",
            }],
            nextCursor: null,
          })),
    );
    await page.route(
      "**/v1/installation/settings",
      (route) =>
        route.fulfill(json({
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
          version: 7,
          updatedByPrincipalId: principalId,
          updatedAt: "2026-10-02T14:12:00.000Z",
        })),
    );
    await page.route(
      "**/v1/installation/capabilities",
      (route) =>
        route.fulfill(json({
          registration: "invitation",
          organizationCreation: "installation_admins",
          ssoAvailable: true,
        })),
    );
    await page.route("**/v1/me", (route) =>
      route.fulfill(json({
        principalId,
        principalType: "human",
        displayName: "Alex Morgan",
        locale: "en",
        direction: "ltr",
        catalogVersion: "10",
        twoFactorEnabled: false,
        timeZone: "UTC",
        email: "mark@example.test",
        backupCodesRemaining: null,
      })));
    await page.route("**/v1/user-preferences*", (route) =>
      route.fulfill(json({
        id: null,
        organizationId,
        principalId,
        theme: "system",
        locale: "en",
        timeZone: "UTC",
        effectiveLocale: "en",
        direction: "ltr",
        availableLocales: ["en", "en-XA", "ar-XB"],
        casVersion: 1,
        createdAt: null,
        updatedAt: null,
      })));
    const response = await goto(...args);
    await page.waitForSelector(
      '[data-testid="organization-sso"] [data-ui-component="ssoSettings"] li',
    );
    if (state === "add-oidc") {
      await page.getByRole("button", { name: "Add OIDC", exact: true }).click();
      await page.getByLabel("Display name").fill("Okta");
      await page.getByLabel("Issuer URL").fill(
        "https://acme.okta.example/oauth2/default",
      );
      await page.getByLabel("Client ID").fill("0oa8k2m4n6p");
      await page.getByLabel("Client secret", { exact: true }).fill(
        "••••••••••••",
      );
      await page.getByLabel("Email domain").fill("acme.example");
    }
    if (state === "add-saml-and-domain-verification") {
      await page.getByRole("button", { name: "Add SAML", exact: true }).click();
      await page.getByLabel("Display name").fill("Entra");
      await page.getByLabel("Email domain").fill("acme.example");
    }
    return response;
  };
  return page;
}

// Organization Access: the Paper states of the route, driven
// through the fixture route against canned API answers. `members` is the full
// page with a freshly created token banner; `empty` an organization with only
// the admin; `loading` holds the member read open; `error` fails it.
const ACCESS_CAPTURE_SCREENS = {
  "access-page": ["members", "empty", "loading", "error"],
};

// The Paper frames name the planned production path; until the organization
// section ships the same page renders through the development alias.
const ACCESS_PLANNED_ROUTE = "/organization/access";
const ACCESS_FIXTURE_ROUTE = "/__fixtures__/organization/access";

export function accessCapturePage(page, designCase) {
  const { screen, state, theme } = designCase.design ?? {};
  if (!Object.hasOwn(ACCESS_CAPTURE_SCREENS, screen)) return page;
  if (
    designCase.candidate?.route !== ACCESS_PLANNED_ROUTE ||
    designCase.candidate?.session !== "authenticated" ||
    !ACCESS_CAPTURE_SCREENS[screen].includes(state) ||
    !["light", "dark"].includes(theme)
  ) {
    throw new Error("Unsupported organization access capture recipe");
  }
  const goto = page.goto.bind(page);
  page.goto = async (...args) => {
    const id = (suffix) => `00000000-0000-4000-8000-${suffix}`;
    const principalId = id("000000000002");
    const organizationId = id("000000000003");
    const adminPrincipal = id("000000000001");
    const developerPrincipal = id("0000000000d1");
    const viewerPrincipal = id("0000000000e1");
    const botPrincipal = id("0000000000b1");
    const applicationId = id("0000000000a1");
    const repositoryId = id("0000000000c1");
    const stamp = "2026-10-01T00:00:00.000Z";
    const json = (body, status = 200) => ({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    const list = (items) => json({ items, nextCursor: null });
    const problem = (status, code) => ({
      status,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: `https://bakery.example/problems/${code}`,
        title: code,
        detail: code,
        status,
        code,
        retryable: false,
        requestId: id("000000000010"),
        traceId: id("000000000011"),
      }),
    });
    const membership = (suffix, member, role) => ({
      id: id(suffix),
      organizationId,
      principalId: member,
      role,
      status: "active",
      joinedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    });
    const person = (member, displayName, principalType = "human") => ({
      id: member,
      principalType,
      displayName,
      disabledAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    });
    const alone = state === "empty";
    const memberships = alone
      ? [membership("000000000257", adminPrincipal, "admin")]
      : [
        membership("000000000257", adminPrincipal, "admin"),
        membership("000000000258", developerPrincipal, "guest"),
        membership("000000000259", viewerPrincipal, "guest"),
      ];
    const principals = alone ? [person(adminPrincipal, "Ada Rivera")] : [
      person(adminPrincipal, "Ada Rivera"),
      person(developerPrincipal, "Jon Okafor"),
      person(viewerPrincipal, "Priya Nair"),
      person(botPrincipal, "ci-deployer", "service"),
    ];
    const withData = !alone;
    const handle = (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const key = `${method} ${path}`;
      const base = `/v1/organizations/${organizationId}`;
      if (key === `GET ${base}/effective-access`) {
        return route.fulfill(json({
          organizationId,
          role: "admin",
          capabilities: ["task:read"],
        }));
      }
      if (key === `GET ${base}`) {
        return route.fulfill(json({
          id: organizationId,
          name: "Acme Bakeries",
          slug: "acme",
          logo: null,
          metadata: {},
          createdAt: stamp,
          updatedAt: stamp,
          version: 1,
          defaultLocale: null,
        }));
      }
      if (key === `GET ${base}/memberships`) {
        if (state === "loading") return new Promise(() => {});
        if (state === "error") {
          return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
        }
        return route.fulfill(list(memberships));
      }
      if (key === `GET ${base}/invitations`) {
        return route.fulfill(list(
          withData
            ? [{
              id: id("000000000267"),
              organizationId,
              email: "sam@example.test",
              role: "guest",
              status: "pending",
              expiresAt: "2026-10-17T00:00:00.000Z",
              inviterPrincipalId: adminPrincipal,
              createdAt: stamp,
            }]
            : [],
        ));
      }
      if (key === "GET /v1/principals") return route.fulfill(list(principals));
      if (key === "GET /v1/access-tokens") {
        return route.fulfill(list(
          withData
            ? [{
              id: id("000000000277"),
              organizationId,
              principalId: botPrincipal,
              createdByPrincipalId: adminPrincipal,
              name: "ci-deployer",
              prefix: "bk_…9d2f",
              scopes: ["bakery:operate"],
              expiresAt: "2026-12-01T00:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
              createdAt: stamp,
              updatedAt: stamp,
              version: 1,
            }]
            : [],
        ));
      }
      if (key === "POST /v1/access-tokens") {
        const body = request.postDataJSON();
        return route.fulfill(json({
          id: id("000000000278"),
          organizationId,
          principalId: body.principalId,
          createdByPrincipalId: adminPrincipal,
          name: body.name,
          prefix: "bk_…e07a",
          scopes: body.scopes,
          expiresAt: body.expiresAt,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          version: 1,
          secret: "bk_live_4c81…e07a",
        }, 201));
      }
      if (key === "GET /v1/access-bindings") {
        return route.fulfill(list(
          withData
            ? [
              {
                id: id("000000000287"),
                organizationId,
                principalId: developerPrincipal,
                roleKey: "developer",
                scopeType: "application",
                scopeId: applicationId,
                grantedByPrincipalId: adminPrincipal,
                createdAt: stamp,
                updatedAt: stamp,
                version: 1,
              },
              ...(withData
                ? [{
                  id: id("000000000289"),
                  organizationId,
                  principalId: botPrincipal,
                  roleKey: "developer",
                  scopeType: "application",
                  scopeId: applicationId,
                  grantedByPrincipalId: adminPrincipal,
                  createdAt: stamp,
                  updatedAt: stamp,
                  version: 1,
                }, {
                  id: id("000000000288"),
                  organizationId,
                  principalId: viewerPrincipal,
                  roleKey: "viewer",
                  scopeType: "repository",
                  scopeId: repositoryId,
                  grantedByPrincipalId: adminPrincipal,
                  createdAt: stamp,
                  updatedAt: stamp,
                  version: 1,
                }]
                : []),
            ]
            : [],
        ));
      }
      if (key === "GET /v1/applications") {
        return route.fulfill(list([{
          id: applicationId,
          slug: "storefront",
          name: "storefront",
          description: "",
          archivedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          version: 1,
        }]));
      }
      if (key === "GET /v1/repositories") {
        return route.fulfill(list([{
          id: repositoryId,
          applicationId,
          slug: null,
          integrationConnectionId: id("0000000000e9"),
          providerRepoId: "1",
          owner: "acme",
          name: "oven-api",
          defaultBranch: "main",
          activeProfileId: null,
          archivedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          version: 1,
        }]));
      }
      if (key === "GET /v1/me/connected-clients") {
        return route.fulfill(json({
          items: withData
            ? [{
              id: id("000000000297"),
              clientId: "bakery-cli",
              clientName: "Bakery CLI · mark@example.test",
              organizationId,
              organizationName: "Platform team",
              scopes: ["bakery:read"],
              authorizedAt: "2026-10-02T00:00:00.000Z",
              lastUsedAt: null,
            }]
            : [],
        }));
      }
      return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
    };
    await page.route(
      "**/v1/installation/status",
      (route) => route.fulfill(json({ bootstrapped: true })),
    );
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() !== "GET" ? route.abort() : route.fulfill(
          list([{
            id: organizationId,
            name: "Platform team",
            slug: "platform-team",
            logo: null,
            defaultLocale: null,
            metadata: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
            role: "admin",
          }]),
        ),
    );
    await page.route("**/v1/me", (route) =>
      route.fulfill(json({
        principalId,
        principalType: "human",
        displayName: "Alex Morgan",
        locale: "en",
        direction: "ltr",
        catalogVersion: "10",
        twoFactorEnabled: false,
        timeZone: "UTC",
        email: "mark@example.test",
        backupCodesRemaining: null,
      })));
    await page.route("**/v1/user-preferences*", (route) =>
      route.fulfill(json({
        id: null,
        organizationId,
        principalId,
        theme: "system",
        locale: "en",
        timeZone: "UTC",
        effectiveLocale: "en",
        direction: "ltr",
        availableLocales: ["en", "en-XA", "ar-XB"],
        casVersion: 1,
        createdAt: null,
        updatedAt: null,
      })));
    for (
      const pattern of [
        `**/v1/organizations/${organizationId}`,
        `**/v1/organizations/${organizationId}/**`,
        "**/v1/principals**",
        "**/v1/access-tokens**",
        "**/v1/access-bindings**",
        "**/v1/applications**",
        "**/v1/repositories**",
        "**/v1/me/connected-clients",
      ]
    ) await page.route(pattern, handle);
    const [target, ...rest] = args;
    const response = await goto(
      String(target).replace(ACCESS_PLANNED_ROUTE, ACCESS_FIXTURE_ROUTE),
      ...rest,
    );
    if (state === "loading") {
      await page.waitForSelector('[data-testid="org-access-loading"]');
      return response;
    }
    if (state === "error") {
      await page.waitForSelector('[data-testid="org-access-error"]');
      return response;
    }
    if (state === "empty") {
      await page.waitForSelector('[data-testid="org-access-empty"]');
      return response;
    }
    await page.waitForSelector('[data-testid="org-access-members"]');
    if (state === "members") {
      await page.getByTestId("org-access-new-token-action").click();
      await page.getByLabel("Token name").fill("deploy");
      await page.getByTestId("org-access-token-create").click();
      await page.waitForSelector('[data-testid="org-access-new-token"]');
    }
    return response;
  };
  clipPhoneScreenshotToFrame(page, designCase);
  return page;
}

// A phone frame is as tall as Paper drew it, which is rarely the height the
// page needs, and compare-paper rejects a candidate of another size with a
// zero score that says nothing about the layout. The shared capture takes a
// full-page screenshot, so this clips that screenshot to the frame: the
// viewport is raised to the frame height (a shorter page keeps its background
// below the content), the capture is cropped to W x H, and the viewport is put
// back. The score then measures the pixels that differ, not the page height.
function clipPhoneScreenshotToFrame(page, designCase) {
  if (designCase.design?.device !== "phone") return;
  const { width, height } = designCase.artboard ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height)) return;
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (options = {}) => {
    const restore = page.viewportSize();
    await page.setViewportSize({ width, height });
    try {
      return await screenshot({
        ...options,
        fullPage: true,
        clip: { x: 0, y: 0, width, height },
      });
    } finally {
      if (restore) await page.setViewportSize(restore);
    }
  };
}

export function parseCaptureArguments(argv) {
  const args = {
    changed: false,
    only: [],
    webBaseUrl: process.env.BAKERY_WEB_BASE_URL || null,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--changed") args.changed = true;
    else if (argument === "--all") args.changed = false;
    else if (argument === "--web-base-url") args.webBaseUrl = argv[++index];
    // Development loop only: capture just the cases whose id starts with a
    // prefix (e.g. `--only queue.`).
    else if (argument === "--only") args.only.push(argv[++index]);
    else throw new Error(`Unknown capture argument ${argument}`);
  }
  if (!args.webBaseUrl) {
    throw new Error(
      "capture requires --web-base-url (or BAKERY_WEB_BASE_URL)",
    );
  }
  return args;
}

async function untrackedSourceMaterial() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).map(normalizePath);
  const entries = [];
  for (const path of paths) {
    const absolutePath = join(root, path);
    // An untracked nested repo is reported as one opaque directory entry.
    const details = await stat(absolutePath).catch(() => null);
    if (!details?.isFile()) continue;
    entries.push(`${path}\0${sha256(await readFile(absolutePath))}\0`);
  }
  return entries.sort().join("");
}

export async function captureEnterpriseCases(
  {
    args = parseCaptureArguments(process.argv.slice(2)),
    manifestName = MANIFEST_NAME,
  } = {},
) {
  // capture-stories.mjs reads BAKERY_UI_ARTIFACTS_DIR once at import; point it
  // at the enterprise tree first so its images land in enterprise/runtime.
  const baseArtifacts = resolve(
    root,
    process.env.BAKERY_UI_ARTIFACTS_DIR || "artifacts/ui-baseline",
  );
  const enterpriseArtifacts = artifactsDirectoryFor(
    baseArtifacts,
    manifestName,
  );
  process.env.BAKERY_UI_ARTIFACTS_DIR = enterpriseArtifacts;
  const {
    captureDesignCase,
    captureConcurrency,
    changedPaths,
    sourceIdentity,
  } = await import("./capture-stories.mjs");
  const profile = manifestProfile(manifestName);
  const outputDirectory = join(enterpriseArtifacts, "runtime");
  const manifestPath = join(outputDirectory, "manifest.json");
  const tokenManifest = await readJson(tokenPath);
  await mkdir(outputDirectory, { recursive: true });

  const baseline = await readJson(profile.baselinePath);
  const ledger = await readRouteLedger();
  let designCases = (baseline.cases ?? []).filter((entry) =>
    entry.reference === "design" && !entry.candidate?.storyId &&
    (args.only.length === 0 ||
      args.only.some((prefix) => entry.id.startsWith(prefix)))
  );
  // A planned route does not exist yet: nothing to capture, and compare-paper
  // reports its case as `planned` from the ledger.
  const planned = plannedCases(ledger, manifestName);
  const skipped = designCases.filter((entry) => planned.has(entry.id));
  designCases = designCases.filter((entry) => !planned.has(entry.id));
  if (skipped.length) {
    console.log(
      `Skipped ${skipped.length} planned ${manifestName} cases: ${
        skipped.map((entry) => entry.id).join(", ")
      }`,
    );
  }
  // A debt route has a Paper frame but no honest golden to meet yet: its
  // cases are not captured, and compare-paper reports them as `debt`.
  const debt = debtCases(ledger, baseline, manifestName);
  const debtSkipped = designCases.filter((entry) => debt.has(entry.id));
  designCases = designCases.filter((entry) => !debt.has(entry.id));
  if (debtSkipped.length) {
    console.log(
      `Skipped ${debtSkipped.length} debt ${manifestName} cases: ${
        debtSkipped.map((entry) => entry.id).join(", ")
      }`,
    );
  }
  // A --changed run narrows to new, re-referenced or route-owning-module-
  // changed cases, which compare-paper reads back from selection.designCaseIds.
  let selectedDesignIds = null;
  if (args.changed && !args.only.length) {
    designCases = selectDesignCases({
      designCases,
      manifestName,
      paths: changedPaths(),
      baseManifest: baseManifestAt({ repoPath: profile.baselineRepoPath }),
      manifest: baseline,
      ledger,
      manifestRepoPath: profile.baselineRepoPath,
    });
    selectedDesignIds = designCases.map((entry) => entry.id);
  }

  const browser = await chromium.launch({
    headless: true,
    ...enterpriseLaunchOptions(),
  });
  const metadata = {
    ...sourceIdentity(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      execFileSync("git", ["diff", "--binary", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 256,
      }),
      await untrackedSourceMaterial(),
    ),
    storybookBuildDigest: null,
    tokenRevision: tokenManifest.source.revision,
    tokenDigest: tokenManifest.source.digest,
    fontDigests: await fontDigests(),
    browserVersion: browser.version(),
    playwrightVersion: (await readJson(
      join(uiRoot, "node_modules/@playwright/test/package.json"),
    )).version,
    os: `${process.platform}-${process.arch}`,
  };

  const coverageFor = (records) => ({
    expected: 0,
    selected: 0,
    observed: records.length,
    passed: records.filter((record) => record.status === "passed").length,
    failed: records.filter((record) => record.status === "failed").length,
    blocked: records.filter((record) => record.status === "blocked").length,
    missing: [],
    routes: records.filter((record) => record.kind === "route").length,
  });
  const writeCandidateManifest = async (records) => {
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          selection: {
            mode: args.changed ? "changed" : "all",
            caseIds: [],
            ...(selectedDesignIds ? { designCaseIds: selectedDesignIds } : {}),
          },
          coverage: coverageFor(records),
          cases: records,
        },
        null,
        2,
      ) + "\n",
    );
  };

  const routeRecords = new Array(designCases.length);
  try {
    // Each worker keeps a small browser-context pool keyed by immutable device
    // settings; pages stay isolated per case.
    const contexts = new Map();
    const acquire = async (designCase) => {
      // Theme must be part of the pool key: pages inside one context share
      // origin storage, and a light page's persisted theme must never bleed
      // into a dark case's first paint under parallel workers.
      const key = JSON.stringify([
        designCase.dpr,
        designCase.pointer,
        designCase.locale,
        designCase.theme,
      ]);
      let context = contexts.get(key);
      if (!context) {
        context = await browser.newContext({
          deviceScaleFactor: designCase.dpr,
          colorScheme: designCase.theme,
          hasTouch: designCase.pointer === "coarse",
          locale: designCase.locale,
          timezoneId: "UTC",
          reducedMotion: "reduce",
        });
        contexts.set(key, context);
      }
      return {
        newPage: async () =>
          accessCapturePage(
            ssoCapturePage(
              installationSettingsCapturePage(
                await context.newPage(),
                designCase,
              ),
              designCase,
            ),
            designCase,
          ),
      };
    };
    const contextPool = { acquire };
    let next = 0;
    const captureNext = async () => {
      while (next < designCases.length) {
        const index = next;
        next += 1;
        const designCase = designCases[index];
        try {
          routeRecords[index] = await captureDesignCase(
            browser,
            args.webBaseUrl,
            captureCaseFor(designCase),
            metadata,
            contextPool,
          );
        } catch (error) {
          routeRecords[index] = {
            id: designCase.id,
            kind: "route",
            route: designCase.candidate?.route ?? null,
            paperBaselineId: designCase.id,
            status: error?.status ?? "failed",
            reason: error?.reason ?? "route-capture-error",
            evidencePath: error?.evidencePath ?? null,
            description: {
              expected:
                `Route ${designCase.candidate?.route} renders the ${designCase.id} design fixture deterministically and produces a candidate image.`,
              observed: error instanceof Error ? error.message : String(error),
            },
          };
        }
        await writeCandidateManifest(routeRecords.filter(Boolean));
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(captureConcurrency(), designCases.length) },
          captureNext,
        ),
      );
    } finally {
      await Promise.all(
        [...contexts.values()].map((context) => context.close()),
      );
    }
  } finally {
    await browser.close();
    await writeCandidateManifest(routeRecords.filter(Boolean));
  }
  const records = routeRecords.filter(Boolean);
  const coverage = coverageFor(records);
  if (coverage.failed + coverage.blocked > 0) {
    throw new Error(
      `Runtime capture failed closed: ${coverage.failed} failed, ${coverage.blocked} blocked; see ${
        relative(root, manifestPath)
      }`,
    );
  }
  console.log(
    `Captured ${records.length} runtime cases to ${
      relative(root, manifestPath)
    }.`,
  );
  return records;
}

if (import.meta.main) await captureEnterpriseCases();
