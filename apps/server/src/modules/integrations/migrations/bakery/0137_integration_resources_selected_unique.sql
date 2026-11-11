-- One organization at a time per installation repository (issue #485).
-- Connections of several organizations can share one installation, and each
-- holds its own resource row for a repository the installation covers. Only
-- one live row per (installation_id, kind, external_id) may be selected:
-- disabling a connection keeps its selections and so its reservation;
-- deselecting or archiving releases it. A concurrent second selection waits
-- on the first and fails with a unique violation that integrationResources
-- .update reports as resource_unavailable, the same refusal as an
-- unselectable repository. Structure only: no CHECK constraints, triggers
-- or functions.
create unique index integration_resources_selected_unique
  on bakery.integration_resources (installation_id, kind, external_id)
  where selected and archived_at is null;
