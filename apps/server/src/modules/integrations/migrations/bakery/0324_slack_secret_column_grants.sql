-- The secret columns a save, a rotation and a revoke write, and no others (#415).
--
-- 0303 granted update on the whole secrets row, which is more than any of these
-- paths need: the same grant lets the application rename a secret, and the
-- security suite exists to keep that door shut. Column grants are the narrow
-- grant this codebase already uses for secrets (0050), so the privilege names
-- exactly what the server writes. The revoke is here for stacks that applied
-- the earlier, wider 0303: their row grant is withdrawn before the narrow one
-- is added, and re-running the pair changes nothing.

revoke update on bakery.secrets from bakery_app;

grant update (
  active_version_id,
  active_version_revision,
  allowed_actions,
  allowed_principals,
  expires_at,
  generation,
  invalidation_generation,
  policy_revision,
  revoked_at,
  updated_at,
  verified_login,
  verified_provider_account_id,
  version
) on bakery.secrets to bakery_app;
