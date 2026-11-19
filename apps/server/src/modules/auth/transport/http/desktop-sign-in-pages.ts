import { type Context, Hono } from "hono";
import {
  createTranslator,
  directionForLocale,
  formatDate,
  type MessageKey,
  type SupportedLocale,
} from "@bakery/i18n";
import type { PgDatabase } from "../../../../platform/database.ts";
import { requestLocale } from "../../../../platform/locale.ts";
import type { IdentityStore } from "../../application/identity.ts";
import type { SessionStore } from "../../adapters/postgres.ts";
import {
  decideDesktopSignIn,
  DESKTOP_SIGN_IN_PAGE_PATH,
  viewDesktopSignIn,
} from "../../adapters/desktop-sign-in-postgres.ts";
import {
  resolveSessionAssurance,
  SessionAssurance,
} from "../../domain/assurance.ts";
import { DesktopSignInDecision } from "../../domain/desktop-sign-in.ts";
import {
  type AuthVariables,
  type BrowserSessionAuth,
  createBrowserSessionMiddleware,
  readSessionToken,
} from "../../middleware.ts";

/** Web routes the pages link to; kept literal so the server needs no web import. */
const SIGN_IN_PATH = "/sign-in";
const SIGN_OUT_PATH = "/sign-out";

type PageContext = Context<{ Variables: AuthVariables }>;

type Page = {
  status: number;
  title: MessageKey;
  body?: MessageKey;
  content?: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const STYLE = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:32rem;width:100%}
h1{font-size:1.5rem;margin:0 0 12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0}
dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
form{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 16px}
button,.button{min-height:44px;padding:0 20px;font:inherit;border-radius:8px;border:1px solid currentColor;background:none;color:inherit;text-decoration:none;display:inline-flex;align-items:center;cursor:pointer}
.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function render(
  locale: SupportedLocale,
  page: Page,
): Response {
  const translate = createTranslator({ locale, surface: "auth" });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="${locale}" dir="${directionForLocale(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(translate("auth.desktopSignIn.pageTitle"))}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(translate(page.title))}</h1>
${page.body ? `<p>${escapeHtml(translate(page.body))}</p>` : ""}
${page.content ?? ""}
</main>
</body>
</html>`;
  return new Response(html, {
    status: page.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": locale,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      Vary: "Cookie, Accept-Language",
    },
  });
}

const refusalPages = {
  missing: {
    status: 404,
    title: "auth.desktopSignIn.missing.title",
    body: "auth.desktopSignIn.missing.body",
  },
  expired: {
    status: 410,
    title: "auth.desktopSignIn.expired.title",
    body: "auth.desktopSignIn.expired.body",
  },
  used: {
    status: 409,
    title: "auth.desktopSignIn.used.title",
    body: "auth.desktopSignIn.used.body",
  },
} as const satisfies Record<string, Page>;

/** The browser session behind this request when it is signed in and fully assured, else null. */
async function assuredSession(
  context: PageContext,
  store: SessionStore,
  secret: string,
): Promise<{ factorVerifiedAt: Date | null } | null> {
  const principal = context.get("principal");
  if (!principal || !context.get("sessionId")) return null;
  const token = await readSessionToken(context.req.raw.headers, secret);
  const state = token ? await store.findSessionState(token) : null;
  if (!state || resolveSessionAssurance(state) === SessionAssurance.Pending) {
    return null;
  }
  return { factorVerifiedAt: state.factorVerifiedAt };
}

function signInPage(locale: SupportedLocale): Page {
  const translate = createTranslator({ locale, surface: "auth" });
  return {
    status: 401,
    title: "auth.desktopSignIn.confirm.title",
    content: `<p><a class="button primary" href="${SIGN_IN_PATH}">${
      escapeHtml(translate("core.actions.signIn"))
    }</a></p>`,
  };
}

/** The confirmation page for one live request and the signed-in person. */
export function renderConfirmPage(
  locale: SupportedLocale,
  input: {
    name: string;
    email: string;
    computerName: string;
    createdAt: Date;
    requestId: string;
  },
): Response {
  const translate = createTranslator({ locale, surface: "auth" });
  const { name, email } = input;
  const asked = formatDate(input.createdAt, locale, {
    // Explicit fields: Intl refuses timeZoneName next to dateStyle/timeStyle.
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const request = escapeHtml(input.requestId);
  return render(locale, {
    status: 200,
    title: "auth.desktopSignIn.confirm.title",
    body: "auth.desktopSignIn.confirm.body",
    content: `<dl>
<dt>${escapeHtml(translate("auth.desktopSignIn.confirm.signedInAs"))}</dt>
<dd>${
      escapeHtml(
        translate("auth.desktopSignIn.confirm.signedInAsValue", {
          name,
          email,
        }),
      )
    }</dd>
<dt>${escapeHtml(translate("auth.desktopSignIn.confirm.computer"))}</dt>
<dd>${escapeHtml(input.computerName)}</dd>
<dt>${escapeHtml(translate("auth.desktopSignIn.confirm.asked"))}</dt>
<dd><time datetime="${input.createdAt.toISOString()}">${
      escapeHtml(asked)
    }</time></dd>
</dl>
<p>${escapeHtml(translate("auth.desktopSignIn.confirm.access"))}</p>
<form method="post" action="${DESKTOP_SIGN_IN_PAGE_PATH}">
<input type="hidden" name="request" value="${request}">
<button type="submit" name="decision" value="cancel">${
      escapeHtml(translate("auth.desktopSignIn.confirm.cancel"))
    }</button>
<button type="submit" name="decision" value="continue" class="primary" autofocus>${
      escapeHtml(translate("auth.desktopSignIn.confirm.continue"))
    }</button>
</form>
<p><a href="${SIGN_OUT_PATH}">${
      escapeHtml(
        translate("auth.desktopSignIn.confirm.otherAccount", { name }),
      )
    }</a></p>`,
  });
}

/**
 * The browser half of the desktop app's sign-in: the one question the
 * person answers (always shown, even on a repeat sign-in), then the done,
 * cancelled or refusal page. Needs a fully assured browser session; a
 * request carrying any Authorization header is refused, so the app itself
 * can never answer the question.
 */
export function createDesktopSignInPages(options: {
  auth: BrowserSessionAuth;
  database: PgDatabase;
  store: IdentityStore & SessionStore;
  publicBaseUrl: string;
  trustedOrigins: readonly string[];
  secret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(DESKTOP_SIGN_IN_PAGE_PATH, async (context, next) => {
    if (context.req.raw.headers.has("authorization")) {
      return render(requestLocale(context.req.raw), refusalPages.missing);
    }
    return await next();
  });
  app.use(
    DESKTOP_SIGN_IN_PAGE_PATH,
    createBrowserSessionMiddleware({
      auth: options.auth,
      store: options.store,
      publicBaseUrl: options.publicBaseUrl,
      trustedOrigins: options.trustedOrigins,
      secret: options.secret,
      allowAnonymous: true,
      assurance: "skip",
    }),
  );

  app.get(DESKTOP_SIGN_IN_PAGE_PATH, async (context) => {
    const principal = context.get("principal");
    const locale = requestLocale(context.req.raw, principal);
    const view = await viewDesktopSignIn(
      options.database,
      context.req.query("request"),
    );
    if (view.state !== "confirm") {
      return render(locale, refusalPages[view.state]);
    }
    if (!await assuredSession(context, options.store, options.secret)) {
      return render(locale, signInPage(locale));
    }
    return renderConfirmPage(locale, {
      name: principal!.displayName,
      email: principal!.email ?? "",
      computerName: view.computerName!,
      createdAt: view.createdAt!,
      requestId: context.req.query("request") ?? "",
    });
  });

  app.post(DESKTOP_SIGN_IN_PAGE_PATH, async (context) => {
    const principal = context.get("principal");
    const locale = requestLocale(context.req.raw, principal);
    const translate = createTranslator({ locale, surface: "auth" });
    let form: FormData;
    try {
      form = await context.req.raw.formData();
    } catch {
      return render(locale, refusalPages.missing);
    }
    const request = form.get("request");
    const decision = form.get("decision");
    if (
      typeof request !== "string" ||
      (decision !== "continue" && decision !== "cancel")
    ) {
      return render(locale, refusalPages.missing);
    }
    const session = await assuredSession(
      context,
      options.store,
      options.secret,
    );
    if (!session || !principal) {
      return render(locale, signInPage(locale));
    }
    const requestId = context.req.header("x-request-id") ||
      crypto.randomUUID();
    const result = await decideDesktopSignIn(
      options.database,
      {
        id: request,
        decision: decision === "continue"
          ? DesktopSignInDecision.Approved
          : DesktopSignInDecision.Cancelled,
        principalId: principal.principalId,
        factorVerifiedAt: session.factorVerifiedAt,
      },
      { requestId, traceId: requestId },
    );
    if (result.state === "approved") {
      return render(locale, {
        status: 200,
        title: "auth.desktopSignIn.done.title",
        body: "auth.desktopSignIn.done.body",
        content: `<p><a class="button primary" href="${
          escapeHtml(result.redirect)
        }" autofocus>${
          escapeHtml(translate("auth.desktopSignIn.done.open"))
        }</a></p>`,
      });
    }
    if (result.state === "cancelled") {
      return render(locale, {
        status: 200,
        title: "auth.desktopSignIn.cancelled.title",
        body: "auth.desktopSignIn.cancelled.body",
      });
    }
    return render(locale, refusalPages[result.state]);
  });
  return app;
}
