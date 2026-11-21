/**
 * The installation integrations screen's own fixtures: the GitHub App
 * registration and the Slack app's settings behind it. Lifted out of the spec so
 * the stills run ({@link ../slack-app-stills.spec.ts}) shows the same states the
 * tests assert, rather than a second, drifting set of fakes.
 */
import { type Page, type Route } from "@playwright/test";
import { MOCK_PRINCIPAL_ID, mockAuthenticatedSession } from "./mock-session.ts";

export const INTEGRATIONS_PAGE_PATH = "/settings/installation/integrations";
export const GITHUB_REGISTRATION_URL =
  "https://github.com/settings/apps/new?state=state-from-bakery";
export const GITHUB_MANIFEST = JSON.stringify({
  name: "Bakery",
  url: "https://bakery.test",
});

export const unregistered = {
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
};

export const registered = {
  ...unregistered,
  status: "registered",
  appId: 912345,
  slug: "bakery-test-912345",
  name: "Bakery Test 912345",
  clientId: "Iv23liPublicClientId",
  ownerLogin: "bakery-owner",
  ownerId: 4242,
  ownerType: "Organization",
  htmlUrl: "https://github.com/apps/bakery-test-912345",
  permissions: { metadata: "read", contents: "write", issues: "write" },
  events: ["pull_request"],
  clientSecretConfigured: true,
  privateKeyConfigured: true,
  webhookSecretConfigured: true,
  clientSecretRevision: 2,
  privateKeyRevision: 1,
  webhookSecretRevision: 1,
  registeredByPrincipalId: MOCK_PRINCIPAL_ID,
  registeredAt: "2026-10-26T18:00:00.000Z",
  version: 1,
};

/** One issue as the server serializes it: `path` is an array of segments. */
export type ServerIssue = {
  path: readonly string[];
  code: string;
  message: string;
};

export function problem(
  status: number,
  code: string,
  reason?: string,
  issues?: readonly ServerIssue[],
) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "https://bakery.example/problems/test",
      title: "Request refused",
      detail: "Request refused.",
      status,
      code,
      retryable: false,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      ...(reason === undefined ? {} : { reason }),
      ...(issues === undefined ? {} : { issues }),
    }),
  };
}

/** A refused put: status, problem code, optional conflict reason and issues. */
export type PutRefusal = {
  status: number;
  code: string;
  reason?: string;
  issues?: readonly ServerIssue[];
};

/** The Slack app as the section reads it: not set up, or set up. */
export const slackUnset = {
  appId: null,
  clientId: null,
  configured: false,
  signingSecretSavedAt: null,
  clientSecretSavedAt: null,
  detailsCheckedAt: null,
  detailsCheckResult: null,
  lastRequestAt: null,
  lastRequestFailedAt: null,
  // The addresses the server serves, not the page's guesses: the redirect the
  // identity flow mounts, and the two webhook paths Slack reports to.
  redirectUrl:
    "https://bakery.test/v1/integration-auth/slack/identity-callback",
  eventsUrl: "https://bakery.test/v1/webhooks/slack/events",
  interactivityUrl: "https://bakery.test/v1/webhooks/slack/interactions",
  version: 0,
};

export const slackSet = {
  ...slackUnset,
  appId: "A0123ABCD",
  clientId: "1234567890.1234567890",
  configured: true,
  signingSecretSavedAt: "2026-11-19T09:00:00.000Z",
  clientSecretSavedAt: "2026-11-19T09:00:00.000Z",
  version: 1,
};

/**
 * Mocks the Slack app's own settings (#415): the read, the put with its version
 * header, the check and the delete. `slackState` holds what the next read says
 * and what each write recorded.
 */
export async function slackFixture(
  page: Page,
  initial: Record<string, unknown> | "forbidden" | "error" = slackUnset,
) {
  const slack = {
    current: initial,
    reads: 0,
    puts: [] as {
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }[],
    checks: [] as Record<string, string>[],
    deletes: [] as Record<string, string>[],
    putAnswer: "ok" as "ok" | PutRefusal,
    checkAnswer: "accepted" as "accepted" | "client_id_refused",
    /** What the next removal answers; `null` removes as usual. */
    deleteRefusal: null as { status: number; code: string } | null,
  };
  await page.route("**/v1/integrations/slack/app", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      slack.puts.push({
        body: request.postDataJSON(),
        headers: request.headers(),
      });
      if (slack.putAnswer !== "ok") {
        const answer = slack.putAnswer;
        return route.fulfill(
          problem(answer.status, answer.code, answer.reason, answer.issues),
        );
      }
      const typed = request.postDataJSON() as Record<string, unknown>;
      slack.current = {
        ...slackSet,
        appId: String(typed.appId),
        clientId: String(typed.clientId),
        version: Number((slack.current as { version?: number }).version ?? 0) +
          1,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(slack.current),
      });
    }
    if (request.method() === "DELETE") {
      slack.deletes.push(request.headers());
      if (slack.deleteRefusal !== null) {
        const refusal = slack.deleteRefusal;
        return route.fulfill(problem(refusal.status, refusal.code));
      }
      slack.current = { ...slackUnset };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(slack.current),
      });
    }
    slack.reads++;
    if (slack.current === "forbidden") {
      return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    }
    if (slack.current === "error") {
      return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(slack.current),
    });
  });
  await page.route("**/v1/integrations/slack/app/check", (route) => {
    slack.checks.push(route.request().headers());
    const result = slack.checkAnswer;
    slack.current = {
      ...(slack.current as Record<string, unknown>),
      detailsCheckResult: result,
      detailsCheckedAt: "2026-11-20T10:00:00.000Z",
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result, checkedAt: "2026-11-20T10:00:00.000Z" }),
    });
  });
  return slack;
}

/**
 * Mocks the registration read, the begin action and GitHub's registration
 * page. `current` is what the next read answers; `beginAnswer` is what the
 * next begin answers.
 */
export async function integrationsFixture(
  page: Page,
  initial: Record<string, unknown> | "forbidden" | "error" = unregistered,
) {
  await mockAuthenticatedSession(page);
  const slack = await slackFixture(page);
  const state = {
    current: initial,
    beginAnswer: "ok" as "ok" | "conflict" | "forbidden" | "error",
    putAnswer: "ok" as "ok" | PutRefusal,
    reads: 0,
    begins: [] as unknown[],
    puts: [] as {
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }[],
    githubPosts: [] as { url: string; method: string; body: URLSearchParams }[],
  };
  await page.route("**/v1/integration-app-registrations/github", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      state.puts.push({
        body: request.postDataJSON(),
        headers: request.headers(),
      });
      const answer = state.putAnswer;
      if (answer !== "ok") {
        return route.fulfill(
          problem(answer.status, answer.code, answer.reason, answer.issues),
        );
      }
      state.current = {
        ...registered,
        version: typeof state.current === "object" &&
            state.current.status === "registered"
          ? Number(state.current.version) + 1
          : 1,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.current),
      });
    }
    state.reads++;
    if (state.current === "forbidden") {
      return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    }
    if (state.current === "error") {
      return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state.current),
    });
  });
  await page.route(
    "**/v1/integration-app-registrations/github/manifest",
    (route: Route) => {
      state.begins.push(route.request().postDataJSON());
      if (state.beginAnswer === "conflict") {
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      if (state.beginAnswer === "forbidden") {
        return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
      }
      if (state.beginAnswer === "error") {
        return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          provider: "github",
          registrationUrl: GITHUB_REGISTRATION_URL,
          manifest: GITHUB_MANIFEST,
          state: "state-from-bakery",
          expiresAt: "2026-10-26T19:00:00.000Z",
        }),
      });
    },
  );
  await page.route("https://github.com/**", (route) => {
    const request = route.request();
    state.githubPosts.push({
      url: request.url(),
      method: request.method(),
      body: new URLSearchParams(request.postData() ?? ""),
    });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>GitHub</title><p>Create GitHub App</p>",
    });
  });
  // `slack` is a live handle, not a snapshot: a test that sets
  // `fixture.slack.current` must reach the routes, so the object is assigned
  // rather than spread into a copy.
  return Object.assign(state, { slack });
}

export type Fixture = Awaited<ReturnType<typeof integrationsFixture>>;
