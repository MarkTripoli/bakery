import { useQuery } from "@tanstack/react-query";
import type { SkillResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { effectiveAccessQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useSession } from "../../app/session-context.tsx";

export function useCanChangeSkill(
  skill: SkillResponse | undefined,
): boolean | undefined {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const identity = useSession().identity;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  if (skill === undefined || access.isPending) return undefined;
  if (skill.scope === "organization") return access.data?.role === "admin";
  return skill.scope === "personal" &&
    identity?.principalId === skill.ownerPrincipalId;
}
