GRANT UPDATE (active_version_id, active_version_revision, generation, invalidation_generation, version, expires_at, verified_provider_account_id, verified_login, updated_at) ON bakery.secrets TO bakery_app;
GRANT UPDATE (allowed_principals, allowed_actions, policy_revision, invalidation_generation, version, updated_at) ON bakery.secrets TO bakery_app;
