import type { Page } from "@playwright/test";

/**
 * Mocks a bootstrapped installation alone — no identity, so the session
 * stays anonymous. Every fixtures-oriented spec that navigates a real page
 * needs at least this much against a *fresh* database: `GET
 * /v1/installation/status` genuinely answers `{bootstrapped:false}` there
 * (there is no seed step ahead of these specs, unlike `auth-journey.spec.ts`'s
 * own `beforeAll`), and the root `beforeLoad` (`router.tsx`) redirects every
 * path except `/setup` to `/setup` until it sees `true` — which an
 * already-bootstrapped local database hides. `mockAuthenticatedSession`
 * below calls this for the same reason plus a signed-in identity.
 */
export async function mockBootstrappedInstallation(page: Page): Promise<void> {
  await page.route("**/v1/installation/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bootstrapped: true }),
    }));
  await mockFeatureAvailability(page);
}

/** Compatibility fixture controls mapped to supported installation policies. */
export type MockFeatureAvailability = {
  signups: boolean;
  organizationCreation: boolean;
};

/**
 * Mocks the public installation capabilities read. The returned object is live:
 * mutate its fields to change what the next read answers.
 */
export async function mockFeatureAvailability(
  page: Page,
  initial: Partial<MockFeatureAvailability> = {},
): Promise<MockFeatureAvailability> {
  const state: MockFeatureAvailability = {
    signups: true,
    organizationCreation: true,
    ...initial,
  };
  await page.route("**/v1/installation/capabilities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        registration: state.signups ? "invitation" : "closed",
        organizationCreation: state.organizationCreation
          ? "any_user"
          : "installation_admins",
        ssoAvailable: false,
      }),
    }));
  return state;
}

export const MOCK_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
export const MOCK_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000001";

/** The stored `GET/PATCH /v1/user-preferences` record the mock serves. */
export type MockUserPreferences = {
  id: string | null;
  organizationId: string;
  principalId: string;
  theme: "system" | "light" | "dark";
  locale: string | null;
  timeZone: string | null;
  effectiveLocale: string;
  direction: "ltr" | "rtl";
  availableLocales: string[];
  casVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * Mocks `GET`/`PATCH /v1/user-preferences` against one in-memory record, so
 * a saved choice is served back on the next read. `onPatch` sees each
 * request body (including `expectedCasVersion`). The returned record is live.
 */
export async function mockUserPreferences(
  page: Page,
  initial: Partial<MockUserPreferences> = {},
  onPatch?: (body: Record<string, unknown>) => void,
): Promise<MockUserPreferences> {
  const record: MockUserPreferences = {
    id: null,
    organizationId: MOCK_ORGANIZATION_ID,
    principalId: MOCK_PRINCIPAL_ID,
    theme: "system",
    locale: null,
    timeZone: null,
    effectiveLocale: "en",
    direction: "ltr",
    availableLocales: ["en", "en-XA", "ar-XB"],
    casVersion: 1,
    createdAt: null,
    updatedAt: null,
    ...initial,
  };
  await page.route("**/v1/user-preferences", (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      onPatch?.(body);
      for (const key of ["theme", "locale", "timeZone"] as const) {
        if (key in body) {
          (record as Record<string, unknown>)[key] = body[key];
        }
      }
      record.casVersion += 1;
      record.id ??= "00000000-0000-4000-8000-0000000000aa";
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(record),
    });
  });
  return record;
}

/**
 * Mocks a bootstrapped installation and a signed-in `PrincipalIdentity` so
 * an otherwise-anonymous fixtures-oriented spec renders the authenticated
 * shell deterministically in both lanes (real API up, per `BAKERY_REAL_API`,
 * or the fixtures lane's no-backend dev server).
 *
 * Without this, `requireSession`'s `beforeLoad` sees whatever `identity()`
 * actually resolves to: with no backend at all, the request fails as a
 * transport error and the session status stays `"unknown"` — which
 * `requireSession` deliberately lets through (`apps/web/src/app/
 * auth-required.tsx`'s own comment: every protected query still enforces
 * auth server-side, so letting `unknown` through cannot leak protected
 * data to an anonymous visitor). That is a fixtures-lane-only accident of
 * there being no server to answer at all, not a designed "anonymous
 * access allowed" state — once a real API answers a genuine 401, the same
 * anonymous visit correctly becomes session status `"anonymous"` and
 * `requireSession` redirects to `/sign-in`, which unmocked anonymous specs
 * (written against the no-backend fixtures lane) don't expect.
 */
export async function mockAuthenticatedSession(page: Page): Promise<void> {
  await mockBootstrappedInstallation(page);
  await mockUserPreferences(page);
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        principalId: MOCK_PRINCIPAL_ID,
        principalType: "human",
        displayName: "Fixture Admin",
        locale: "en",
        timeZone: null,
        direction: "ltr",
        catalogVersion: "2",
        twoFactorEnabled: false,
        email: "fixture-admin@example.test",
        backupCodesRemaining: null,
      }),
    }));
  // `SessionsSettingsPage` (route `/settings/sessions`) issues its own
  // protected `GET /v1/me/sessions` call beyond identity — without a stub
  // it hits the real backend with no real cookie, gets a genuine 401, and
  // bounces the whole shell back to `/sign-in` out from under the caller.
  await page.route("**/v1/me/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          id: "00000000-0000-4000-8000-000000000002",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          userAgent: "Fixture Browser/1.0",
          ipAddress: "127.0.0.1",
        }],
      }),
    }));
  // `ConnectedClientsPage` (`/settings/clients`, and `/settings/clients/revoke`
  // after its redirect) throws an auth problem to the route error boundary,
  // which drops the settings navigation. Against the real API
  // (`BAKERY_REAL_API=1`) an unstubbed `GET /v1/me/connected-clients` gets a
  // genuine 401; with no backend it fails as transport and the nav survives,
  // so only the real-API lane exposed it. An empty list renders the empty state.
  await page.route("**/v1/me/connected-clients", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }));
  // `InstallationIntegrationsPage` (`/settings/installation/integrations`)
  // reads the GitHub App registration; an unstubbed call is a 404 in the
  // fixtures lane and a 401 against the real API. Unregistered renders the
  // Create action.
  await page.route(
    "**/v1/integration-app-registrations/github",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          provider: "github",
          status: "unregistered",
          appId: null,
          slug: null,
          name: null,
          clientId: null,
          ownerLogin: null,
          ownerId: null,
          ownerType: null,
          htmlUrl: null,
          permissions: null,
          events: null,
          clientSecretConfigured: false,
          privateKeyConfigured: false,
          webhookSecretConfigured: false,
          clientSecretRevision: null,
          privateKeyRevision: null,
          webhookSecretRevision: null,
          registeredByPrincipalId: null,
          registeredAt: null,
          version: 0,
        }),
      }),
  );
  // The Object storage section of the same page reads the installation skill
  // storage settings; unconfigured renders the configure form.
  await page.route(
    "**/v1/installation/skill-storage",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          backend: "filesystem",
          configured: false,
          accountId: null,
          bucket: null,
          credentialUpdatedAt: null,
          credentialRevision: null,
          updatedAt: null,
          version: 0,
        }),
      }),
  );
  // `OrganizationsPage` (route `/organizations`) issues its own protected
  // `GET /v1/organizations` list call for the same reason; a real `POST`
  // there (organization creation) is left unmocked since no caller of
  // this helper creates organizations.
  await page.route("**/v1/organizations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          id: MOCK_ORGANIZATION_ID,
          name: "Fixture Org",
          slug: "fixture-org",
          logo: null,
          defaultLocale: null,
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
          role: "admin",
        }],
        nextCursor: null,
      }),
    });
  });
}
