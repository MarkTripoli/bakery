export const RegistrationAction = Object.freeze(
  {
    CreateUser: "create-user",
    LinkAccount: "link-account",
    SignIn: "sign-in",
  } as const,
);

export type RegistrationAction =
  (typeof RegistrationAction)[keyof typeof RegistrationAction];
export const RegistrationErrorCode = Object.freeze(
  {
    IdentityNotAllowed: "identity_not_allowed",
    SignupsDisabled: "signups_disabled",
  } as const,
);

export type RegistrationErrorCode =
  (typeof RegistrationErrorCode)[keyof typeof RegistrationErrorCode];

export type RegistrationRejection = { readonly error: RegistrationErrorCode };

export type RegistrationStore = {
  hasLiveInvitation(email: string, now: Date): Promise<boolean>;
  hasEnabledPrincipal(providerUserId: string): Promise<boolean>;
};

export type RegistrationDecision = {
  action: RegistrationAction;
  email?: string;
  providerUserId?: string;
  hasRequest: boolean;
  now: Date;
  signupsEnabled: boolean;
};

const rejected: RegistrationRejection = {
  error: RegistrationErrorCode.IdentityNotAllowed,
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function decideRegistration(
  decision: RegistrationDecision,
  store: RegistrationStore,
): Promise<void | RegistrationRejection> {
  if (decision.action === RegistrationAction.CreateUser) {
    if (!decision.hasRequest) return;
    if (!decision.signupsEnabled) {
      return { error: RegistrationErrorCode.SignupsDisabled } as const;
    }
    if (
      decision.email &&
      await store.hasLiveInvitation(
        normalizeEmail(decision.email),
        decision.now,
      )
    ) return;
    return rejected;
  }

  if (
    decision.providerUserId &&
    await store.hasEnabledPrincipal(decision.providerUserId)
  ) return;
  return rejected;
}
