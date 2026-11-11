import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { createBakeryClient } from "@bakery/contracts/client";
import {
  type ApiFailure,
  authProblemCode,
  toApiFailure,
} from "../api/client.ts";
import {
  rememberCurrentReturnTo,
  SIGN_IN_PATH,
} from "../app/auth-required.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

const NIL_INVITATION_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The fixture talks to the real registered action through the generated client
 * and the same-origin proxy, so a session-less visitor observes exactly what
 * the API returns. `organizationInvitations.recipientGet` is the
 * `Authenticated` action that answers `401 AUTH_REQUIRED` before any lookup, so
 * the boundary exercises the sign-in path rather than an authorization denial.
 */
const client = createBakeryClient({ baseUrl: "" });

export function ApiBoundaryFixture() {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const operation = useMutation({
    // Answered 401 on purpose: the sign-in path is the expected outcome.
    meta: { report: false },
    mutationFn: () =>
      client.actions["organizationInvitations.recipientGet"]({
        id: NIL_INVITATION_ID,
      }),
    retry: false,
  });
  const failure: ApiFailure | null = operation.error === null
    ? null
    : toApiFailure(operation.error);
  const problem = failure?.kind === "problem" ? failure.problem : null;
  const authRequired = failure !== null &&
    authProblemCode(failure) === "AUTH_REQUIRED";

  useEffect(() => {
    if (!authRequired) return;
    rememberCurrentReturnTo();
    void navigate({ to: SIGN_IN_PATH });
  }, [authRequired, navigate]);

  return (
    <UI.Stack data-testid="synthetic-fixture" gap="spacious">
      <UI.StatusLabel status="queued">
        {translate("shell.states.fixtureLabel")}
      </UI.StatusLabel>
      <UI.Heading level="page" tabIndex={-1}>
        {translate("shell.states.fixtureApiBoundary")}
      </UI.Heading>
      <UI.Button
        busy={operation.isPending}
        onClick={() => operation.mutate()}
      >
        {translate("core.actions.open")}
      </UI.Button>
      {failure && !authRequired
        ? (
          <UI.ErrorState
            data-testid="api-boundary-error"
            description={
              <UI.Stack gap="compact">
                <UI.Text>
                  {failure.kind === "network"
                    ? translate("shell.health.offline")
                    : translate("problems.UNKNOWN.description")}
                </UI.Text>
                {problem
                  ? (
                    <>
                      <UI.DataText data-testid="api-boundary-code">
                        {problem.code}
                      </UI.DataText>
                      <UI.DataText data-testid="api-boundary-request-id">
                        {translate("problems.UNKNOWN.requestId", {
                          requestId: problem.requestId,
                        })}
                      </UI.DataText>
                      <UI.DataText>
                        {translate("problems.UNKNOWN.traceId", {
                          traceId: problem.traceId,
                        })}
                      </UI.DataText>
                    </>
                  )
                  : null}
              </UI.Stack>
            }
            title={translate("problems.UNKNOWN.title")}
            variant="page"
          />
        )
        : null}
    </UI.Stack>
  );
}
