-- One registration table for every provider's installation-level OAuth
-- registration (#410, the Linear client-credentials settings).
--
-- `integration_app_registrations` was written for the GitHub App, so six columns
-- describe a GitHub App and nothing else: its numeric id, slug, owner, URL,
-- permission set and event list, plus the private key an App signs with. A
-- provider that registers an OAuth application with a client ID and a client
-- secret has none of those. Rather than a parallel table that would duplicate the
-- secret references, the unique provider key and the revision rules, those columns
-- stop being required. Both providers now share the one primitive.
--
-- Nothing about GitHub changes: every GitHub reader filters `provider = 'github'`
-- and every GitHub write still supplies all of them, so a GitHub row is as
-- complete as before. What changes is only that a row for another provider may
-- leave the GitHub-only columns empty. The columns every registration needs stay
-- required: the provider, its display name, the client ID, the client secret
-- reference, the status and who registered it. No CHECK constraint and no trigger:
-- which columns a given provider must fill is the application's rule, stated once
-- by that provider's manifest.

alter table bakery.integration_app_registrations
  alter column external_app_id drop not null,
  alter column slug drop not null,
  alter column owner_login drop not null,
  alter column owner_id drop not null,
  alter column owner_type drop not null,
  alter column html_url drop not null,
  alter column permissions drop not null,
  alter column events drop not null,
  alter column private_key_secret_id drop not null;
