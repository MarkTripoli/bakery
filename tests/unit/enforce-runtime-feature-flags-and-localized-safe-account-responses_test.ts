import { assertEquals } from "@std/assert";
import {
  decideRegistration,
  RegistrationAction,
  RegistrationErrorCode,
  type RegistrationStore,
} from "../../apps/server/src/modules/auth/domain/registration.ts";
import {
  createTranslator,
  type MessageKey,
  messageKeys,
  parseAcceptLanguage,
  resolvePreferredLocale,
  supportedLocales,
} from "../../packages/i18n/src/index.ts";
import {
  type ProblemCode,
  StandardError,
  toProblem,
} from "../../packages/contracts/src/http.ts";

function countingStore(overrides: Partial<RegistrationStore> = {}) {
  let hasLiveInvitationCalls = 0;
  const store: RegistrationStore = {
    hasLiveInvitation: (email, now) => {
      hasLiveInvitationCalls += 1;
      return overrides.hasLiveInvitation?.(email, now) ?? Promise.resolve(true);
    },
    hasEnabledPrincipal: overrides.hasEnabledPrincipal ??
      (() => Promise.resolve(true)),
  };
  return { store, calls: () => hasLiveInvitationCalls };
}

Deno.test("paused signups reject create-user before touching the invitation store", async () => {
  const { store, calls } = countingStore();
  const decision = await decideRegistration(
    {
      action: RegistrationAction.CreateUser,
      email: "person@example.com",
      hasRequest: true,
      now: new Date(),
      signupsEnabled: false,
    },
    store,
  );
  assertEquals(decision, { error: RegistrationErrorCode.SignupsDisabled });
  assertEquals(calls(), 0);
});

Deno.test("CLI bootstrap create-user without a request is exempt from the signups flag", async () => {
  const { store } = countingStore();
  const decision = await decideRegistration(
    {
      action: RegistrationAction.CreateUser,
      hasRequest: false,
      now: new Date(),
      signupsEnabled: false,
    },
    store,
  );
  assertEquals(decision, undefined);
});

Deno.test("sign-in and link-account are never gated by the signups flag", async () => {
  const { store } = countingStore();
  for (
    const action of [RegistrationAction.SignIn, RegistrationAction.LinkAccount]
  ) {
    const decision = await decideRegistration(
      {
        action,
        providerUserId: "provider-1",
        hasRequest: true,
        now: new Date(),
        signupsEnabled: false,
      },
      store,
    );
    assertEquals(decision, undefined);
  }
});

Deno.test("parseAcceptLanguage orders by q and drops the wildcard", () => {
  assertEquals(
    parseAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5"),
    ["fr-CH", "fr", "en"],
  );
});

Deno.test("parseAcceptLanguage drops a zero-weighted tag as not acceptable", () => {
  assertEquals(parseAcceptLanguage("en;q=0, ar-XB"), ["ar-XB"]);
});

Deno.test("parseAcceptLanguage drops malformed, oversized, and unparsable entries", () => {
  const overlong = "a".repeat(36);
  assertEquals(
    parseAcceptLanguage(`not_a_tag!, ${overlong}, en;q=bogus, ar-XB`),
    ["ar-XB"],
  );
});

Deno.test("parseAcceptLanguage truncates to the first 16 entries", () => {
  const tags = Array.from({ length: 20 }, (_, index) => `en-x${index}`);
  assertEquals(parseAcceptLanguage(tags.join(", ")), tags.slice(0, 16));
});

Deno.test("parseAcceptLanguage returns an empty list for blank input", () => {
  assertEquals(parseAcceptLanguage(""), []);
  assertEquals(parseAcceptLanguage(null), []);
  assertEquals(parseAcceptLanguage(undefined), []);
});

Deno.test("resolvePreferredLocale falls through an unsupported preference to Accept-Language", () => {
  assertEquals(
    resolvePreferredLocale({ preferred: "fr", acceptLanguage: "ar-XB" }),
    "ar-XB",
  );
});

Deno.test("resolvePreferredLocale prefers the person's setting over Accept-Language", () => {
  assertEquals(
    resolvePreferredLocale({ preferred: "en-XA", acceptLanguage: "ar-XB" }),
    "en-XA",
  );
});

Deno.test("resolvePreferredLocale prefers an explicit override over the person's setting", () => {
  assertEquals(
    resolvePreferredLocale({
      explicit: "ar-XB",
      preferred: "en-XA",
      acceptLanguage: "en-XA",
    }),
    "ar-XB",
  );
});

Deno.test("resolvePreferredLocale defaults to en with no candidates", () => {
  assertEquals(resolvePreferredLocale({}), "en");
});

Deno.test("toProblem localizes title and detail without changing machine-readable fields", () => {
  const error = new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const options = {
    requestId: "req-1",
    traceId: "trace-1",
    publicBaseUrl: "https://bakery.example",
  };
  const english = toProblem(error, options);
  const arabic = toProblem(error, { ...options, locale: "ar-XB" as const });
  assertEquals(arabic.code, english.code);
  assertEquals(arabic.type, english.type);
  assertEquals(arabic.status, english.status);
  assertEquals(arabic.title, `⟪${english.title}⟫`);
  assertEquals(arabic.detail, `⟪${english.detail}⟫`);
});

Deno.test("every Problem code formats through the translator in every locale", () => {
  // toProblem formats with no arguments, so a placeholder authored into a
  // Problem title or description makes the translator throw and the response
  // silently fall back to the raw string with its braces showing. Expecting
  // the translator's own output — not the raw catalog value — is what makes
  // this fail instead of agreeing with the fallback.
  const codes = messageKeys
    .filter((key) => key.startsWith("problems.") && key.endsWith(".title"))
    .map((key) => key.slice("problems.".length, -".title".length))
    .filter((code) => code !== "UNKNOWN") as ProblemCode[];
  assertEquals(codes.length > 30, true);

  for (const code of codes) {
    for (const locale of supportedLocales) {
      const translate = createTranslator({ locale, surface: "problem-test" });
      const problem = toProblem(new StandardError({ code }), {
        requestId: "req-1",
        traceId: "trace-1",
        publicBaseUrl: "https://bakery.example",
        locale,
      });
      assertEquals(
        problem.title,
        translate(`problems.${code}.title` as MessageKey),
        `${code} title in ${locale}`,
      );
      assertEquals(
        problem.detail,
        translate(`problems.${code}.description` as MessageKey),
        `${code} detail in ${locale}`,
      );
    }
  }
});
