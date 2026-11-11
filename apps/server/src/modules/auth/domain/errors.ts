export const AuthErrorCode = Object.freeze(
  {
    IdentityUnavailable: "AUTH_IDENTITY_UNAVAILABLE",
    BootstrapConflict: "AUTH_BOOTSTRAP_CONFLICT",
    BootstrapLegacyAmbiguous: "AUTH_BOOTSTRAP_LEGACY_IDENTITY_AMBIGUOUS",
    BootstrapUnavailable: "AUTH_BOOTSTRAP_IDENTITY_UNAVAILABLE",
    BootstrapMarkerInvalid: "AUTH_BOOTSTRAP_MARKER_INVALID",
    BootstrapFailed: "AUTH_BOOTSTRAP_FAILED",
    BootstrapInputInvalid: "AUTH_BOOTSTRAP_INPUT_INVALID",
    PrincipalConvergenceFailed: "AUTH_PRINCIPAL_CONVERGENCE_FAILED",
    BootstrapMemberConvergenceFailed:
      "AUTH_BOOTSTRAP_MEMBER_CONVERGENCE_FAILED",
    ProviderUserNotFound: "AUTH_PROVIDER_USER_NOT_FOUND",
    BootstrapCancelled: "AUTH_BOOTSTRAP_CANCELLED",
    BootstrapPasswordMismatch: "AUTH_BOOTSTRAP_PASSWORD_MISMATCH",
    PrincipalSyncFailed: "AUTH_PRINCIPAL_SYNC_FAILED",
    ProviderError: "AUTH_PROVIDER_ERROR",
    ConfigRequired: "AUTH_CONFIG_REQUIRED",
    SignupsDisabled: "AUTH_SIGNUPS_DISABLED",
    InteractiveStdinRequired: "AUTH_BOOTSTRAP_INTERACTIVE_STDIN_REQUIRED",
  } as const,
);

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];
