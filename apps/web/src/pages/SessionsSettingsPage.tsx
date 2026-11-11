import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatDate } from "@bakery/i18n";
import { authProblemCode } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { browserSessionsListQueryOptions } from "../api/query.ts";
import { SESSION_REVOKE_PATH } from "../app/auth-paths.ts";
import { deviceKind, otherSessions } from "../app/browser-sessions.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { SessionsSettingsScreen } from "../screens/SessionsSettingsScreen.tsx";

/**
 * `/settings/sessions`: the list is a scoped query — an expired
 * session rethrows to `ProtectedRouteError`, any other transport failure
 * renders in place with a retry. Revoking happens on the confirmation page:
 * each row's Revoke link opens it for that session (`?session=<id>`), the
 * button opens it for every other session, and it returns here with
 * `?revoked=1` after signing out a single session so the page opens with the
 * "signed out" notice.
 */
export function SessionsSettingsPage(
  { revoked }: { readonly revoked: boolean },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { locale, timeZone, translate } = useI18n();

  const sessions = useQuery({
    ...browserSessionsListQueryOptions(api, scope),
    throwOnError: (error) => authProblemCode(error) !== null,
  });

  const others = sessions.data
    ? otherSessions(sessions.data).map((session) => ({
      id: session.id,
      device: deviceKind(session.userAgent),
      // The design names the device class, never the raw user agent.
      title: translate(
        session.userAgent === null
          ? "auth.sessions.unknownDevice"
          : deviceKind(session.userAgent) === "phone"
          ? "auth.sessions.mobileBrowser"
          : "auth.sessions.otherDesktop",
      ),
      description: translate("auth.sessions.lastActive", {
        time: formatDate(new Date(session.updatedAt), locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone,
        }),
      }),
    }))
    : [];

  return (
    <SessionsSettingsScreen
      onRetry={() => void sessions.refetch()}
      onRevokeOthers={() => void navigate({ to: SESSION_REVOKE_PATH })}
      others={others}
      revoked={revoked}
      state={sessions.isPending
        ? "loading"
        : sessions.isError
        ? "error"
        : "ready"}
    />
  );
}
