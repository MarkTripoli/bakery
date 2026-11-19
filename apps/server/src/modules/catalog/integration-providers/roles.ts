/**
 * This provider's role names, mapped to the ladder the ticket contract compares.
 *
 * It lives in the provider package rather than beside the reader or in the
 * contract, because these four words are this provider's and nobody else's: the
 * port carries a rank, so a tracker that calls its roles something else fits
 * without admission learning either vocabulary.
 */
const ROLE_RANK = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
} as const;

/** The rank a permission name of this provider sits at on the ladder. */
export function roleRank(permission: keyof typeof ROLE_RANK) {
  return ROLE_RANK[permission];
}
