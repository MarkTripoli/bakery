import { type Context, Hono } from "hono";
import {
  createTranslator,
  directionForLocale,
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
  BAKERY_LOCKUP_DARK,
  BAKERY_LOCKUP_LIGHT,
} from "./desktop-sign-in-brand.ts";
import {
  type AuthVariables,
  type BrowserSessionAuth,
  createBrowserSessionMiddleware,
  readSessionToken,
} from "../../middleware.ts";

/** Web routes the pages link to; kept literal so the server needs no web import. */
const SIGN_IN_PATH = "/sign-in";
const SIGN_OUT_PATH = "/sign-out";
const SECURITY_SETTINGS_PATH = "/settings/security";
/** The web app's return-path key (`apps/web/src/app/auth-return.ts`). */
const AUTH_RETURN_TO_KEY = "bakery.auth.returnTo.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageContext = Context<{ Variables: AuthVariables }>;

type Page = {
  status: number;
  title: MessageKey;
  body?: MessageKey;
  /** Body markup, already escaped; used instead of `body`. */
  bodyHtml?: string;
  content?: string;
  /** Inline script source, run under this response's CSP nonce. */
  script?: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Colours are the design tokens of `packages/ui/src/foundations/theme.css`
 * (light, then dark), copied in as values: these pages load no app CSS.
 */
const STYLE = `
:root{color-scheme:light dark;--fg:#141A24;--fg-muted:#5D6675;--canvas:#F5F6F8;--surface:#FFFFFF;--border:#E3E6EB;--control-border:#8A939F;--primary:#141A24;--primary-fg:#FFFFFF;--primary-hover:#262E3B;--focus:#0B63C6;font-family:Geist,system-ui,sans-serif;line-height:1.5;color:var(--fg);background:var(--canvas)}
@media (prefers-color-scheme:dark){:root{--fg:#F2F4F8;--fg-muted:#A3ACBA;--canvas:#0B0E14;--surface:#12161E;--border:#2D3542;--control-border:#59657A;--primary:#F2F4F8;--primary-fg:#0B0E14;--primary-hover:#DCE0E7;--focus:#4A93E6}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:32rem;width:100%;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:32px}
.brand{display:block;margin:0 0 24px}
.brand svg{height:32px;width:auto;display:block}
.brand .dark{display:none}
@media (prefers-color-scheme:dark){.brand .light{display:none}.brand .dark{display:block}}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 12px}
p{margin:0 0 12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0}
dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere;color:var(--fg-muted)}
form{display:flex;flex-direction:row-reverse;justify-content:flex-end;gap:12px;margin:24px 0 16px}
@media (max-width:480px){form{flex-direction:column}form button{width:100%;justify-content:center}}
a{color:var(--focus)}
button,.button{min-height:44px;padding:0 20px;font:inherit;font-weight:500;border-radius:4px;border:1px solid var(--control-border);background:var(--surface);color:var(--fg);text-decoration:none;display:inline-flex;align-items:center;cursor:pointer}
.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
.primary:hover{background:var(--primary-hover)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export function render(
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
${page.script ? `<script nonce="${nonce}">${page.script}</script>` : ""}
</head>
<body>
<main>
<header class="brand" role="img" aria-label="Bakery"><span class="light">${BAKERY_LOCKUP_LIGHT}</span><span class="dark">${BAKERY_LOCKUP_DARK}</span></header>
<h1>${escapeHtml(translate(page.title))}</h1>
${
    page.bodyHtml !== undefined
      ? `<p>${page.bodyHtml}</p>`
      : page.body
      ? `<p>${escapeHtml(translate(page.body))}</p>`
      : ""
  }
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
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
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
  cancelled: {
    status: 409,
    title: "auth.desktopSignIn.cancelled.title",
    body: "auth.desktopSignIn.cancelled.body",
  },
} as const satisfies Record<string, Page>;

/** "Already used", with Account and security as a link to that page. */
function usedPage(locale: SupportedLocale): Page {
  const translate = createTranslator({ locale, surface: "auth" });
  const marker = "\u0000link\u0000";
  const link = `<a href="${SECURITY_SETTINGS_PATH}">${
    escapeHtml(translate("auth.desktopSignIn.used.link"))
  }</a>`;
  return {
    status: 409,
    title: "auth.desktopSignIn.used.title",
    bodyHtml: escapeHtml(
      translate("auth.desktopSignIn.used.body", { link: marker }),
    ).replace(marker, link),
  };
}

function refusalPage(
  locale: SupportedLocale,
  state: "missing" | "expired" | "used" | "cancelled",
): Page {
  return state === "used" ? usedPage(locale) : refusalPages[state];
}

/** Whole minutes since `then`, never negative. */
export function minutesSince(then: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
}

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

/**
 * Signed out: one Sign in button. When the request id is a UUID, pressing it
 * first stores this page as the web app's return path, so sign-in lands back
 * on the question (the web app accepts only this exact path).
 */
export function signInPage(locale: SupportedLocale, requestId?: string): Page {
  const translate = createTranslator({ locale, surface: "auth" });
  const returnTo = requestId !== undefined && UUID.test(requestId)
    ? `${DESKTOP_SIGN_IN_PAGE_PATH}?request=${requestId.toLowerCase()}`
    : null;
  return {
    status: 401,
    title: "auth.desktopSignIn.signedOut.title",
    body: "auth.desktopSignIn.signedOut.body",
    content:
      `<p><a id="sign-in" class="button primary" href="${SIGN_IN_PATH}">${
        escapeHtml(translate("core.actions.signIn"))
      }</a></p>`,
    ...(returnTo === null ? {} : {
      script:
        `document.addEventListener("DOMContentLoaded",function(){document.getElementById("sign-in").addEventListener("click",function(){try{sessionStorage.setItem(${
          JSON.stringify(AUTH_RETURN_TO_KEY)
        },${JSON.stringify(returnTo)})}catch(_){}})})`,
    }),
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
    now?: Date;
  },
): Response {
  const translate = createTranslator({ locale, surface: "auth" });
  const { name, email } = input;
  const asked = translate("auth.desktopSignIn.confirm.askedAgo", {
    minutes: minutesSince(input.createdAt, input.now ?? new Date()),
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
<button type="submit" name="decision" value="continue" class="primary" autofocus>${
      escapeHtml(translate("auth.desktopSignIn.confirm.continue"))
    }</button>
<button type="submit" name="decision" value="cancel">${
      escapeHtml(translate("auth.desktopSignIn.confirm.cancel"))
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
      return render(locale, refusalPage(locale, view.state));
    }
    if (!await assuredSession(context, options.store, options.secret)) {
      return render(
        locale,
        signInPage(locale, context.req.query("request")),
      );
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
      return render(locale, signInPage(locale, request));
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
    return render(locale, refusalPage(locale, result.state));
  });
  return app;
}
