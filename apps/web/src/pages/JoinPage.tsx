import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { installationCapabilitiesQueryOptions } from "../api/query.ts";
import { SIGN_IN_PATH } from "../app/auth-required.tsx";
import { JoinScreen } from "../screens/JoinScreen.tsx";

/**
 * `/register` with no `invitation` search: the disabled-public-signup
 * landing (Paper `join`, `authShell`/brand). Bakery accounts are always
 * created through an invitation; `RegisterRoute`'s component renders this
 * instead of `RegisterPage` whenever `invitation` is missing or not a UUID.
 */
export function JoinPage() {
  const navigate = useNavigate();
  const api = useBakeryApi();
  const availability = useQuery(installationCapabilitiesQueryOptions(api));
  return (
    <JoinScreen
      onSignIn={() => void navigate({ to: SIGN_IN_PATH })}
      registrationPaused={availability.data?.registration === "closed"}
    />
  );
}
