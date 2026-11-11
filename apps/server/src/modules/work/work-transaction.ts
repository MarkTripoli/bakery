import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { AccessScope } from "../auth/application/bindings.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";

export type WorkTransaction = {
  transaction: PgTransactionClient;
  organizationId: string;
  principalId: string;
  /** Set when only resource bindings allowed this list: return nothing else. */
  accessScope?: AccessScope;
};

export function requireWorkTransaction(
  context: ActionContext,
): WorkTransaction {
  const authorized = context as Partial<AuthorizedActionContext>;
  const authority = authorized.authority;
  const transaction = authorized.transaction;
  if (
    !transaction || !authority || !("organizationId" in authority) ||
    !("subject" in authority)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const actor = authority as OrganizationActor;
  return {
    transaction,

    organizationId: actor.organizationId as string,
    principalId: actor.subject.principalId as string,
    ...(actor.accessScope === undefined
      ? {}
      : { accessScope: actor.accessScope }),
  };
}

export type InstallationTransaction = {
  transaction: PgTransactionClient;
  principalId: string;
};

export function requireInstallationTransaction(
  context: ActionContext,
): InstallationTransaction {
  const authorized = context as Partial<AuthorizedActionContext>;
  const authority = authorized.authority;
  const transaction = authorized.transaction;
  if (
    !transaction || !authority || !("subject" in authority) ||
    !("installationAdministrator" in authority) ||
    authority.installationAdministrator !== true
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return {
    transaction,
    principalId: authority.subject.principalId as string,
  };
}
