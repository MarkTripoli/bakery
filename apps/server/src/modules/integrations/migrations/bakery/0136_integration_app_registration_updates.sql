-- Existing GitHub App credentials (issue #480): integrationAppRegistrations.put
-- replaces the registered App's credentials and refreshes its identity from
-- GitHub GET /app. Each replaced secret gets a new bakery.secret_versions
-- revision (earlier revisions are kept); this grant lets the application
-- refresh the App identity, attach a webhook secret the App lacked and bump
-- the version. Structure only: preconditions are enforced in TypeScript.
grant update (slug, name, client_id, owner_login, owner_id, owner_type,
  html_url, permissions, events, webhook_secret_id, updated_at, version)
  on bakery.integration_app_registrations to bakery_app;
