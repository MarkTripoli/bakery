export const SessionAssurance = Object.freeze(
  {
    Verified: "verified",
    Pending: "pending",
  } as const,
);

export type SessionAssurance =
  typeof SessionAssurance[keyof typeof SessionAssurance];

export function resolveSessionAssurance(
  state: { twoFactorEnabled: boolean; factorVerifiedAt: Date | null },
): SessionAssurance {
  return state.twoFactorEnabled && state.factorVerifiedAt === null
    ? SessionAssurance.Pending
    : SessionAssurance.Verified;
}
