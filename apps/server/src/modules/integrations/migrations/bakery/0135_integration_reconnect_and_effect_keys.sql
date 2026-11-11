-- Reconnect and effect-ledger identity keys (issue #484).
-- * A reconnect for the same verified GitHub account keeps the connection.
--   A same-account reinstall arrives as a new installation id, so the
--   connection's installation_id and external_authorization_id gain an
--   update grant. The composite foreign key from 0132 still references the
--   installation's (id, external_authorization_id, external_account_id) and
--   external_account_id stays without an update grant, so a connection can
--   only move to another installation of the same account. A different
--   account creates a new connection and never rebinds the old one; that
--   rule is enforced in TypeScript.
-- * integration_resources follow their connection's installation: the
--   (connection_id, installation_id) key is re-created with ON UPDATE
--   CASCADE and keeps ON DELETE CASCADE.
-- Structure only: no CHECK constraints, triggers or functions.
grant update (installation_id, external_authorization_id)
  on bakery.integration_connections to bakery_app;

alter table bakery.integration_resources
  drop constraint integration_resources_installation_fk,
  add constraint integration_resources_installation_fk
    foreign key (connection_id, installation_id)
    references bakery.integration_connections (id, installation_id)
    on update cascade on delete cascade;

-- External effect ledger keys that 0127 deferred until integration tables
-- existed. Every effect row keeps the connection and that connection's
-- resource it ran through: both keys are NO ACTION, so suspending, revoking
-- or reconnecting a connection never touches an effect, and a direct delete
-- of a referenced connection or resource is refused. An organization delete
-- still removes them together (NO ACTION is checked at statement end). The
-- resource key includes the connection, so an effect cannot name another
-- connection's resource. integration_install_id (text) names the integration
-- gate's deployed-integration install, not a uuid integration_installations
-- row, and no grants table exists, so integration_install_id and
-- integration_grant_id stay without keys; credential_version_id stays
-- unwritten until the token broker records credential provenance.
alter table bakery.integration_resources
  add constraint integration_resources_connection_unique
    unique (id, connection_id);

alter table bakery.external_effects
  add constraint external_effects_integration_connection_fk
    foreign key (organization_id, integration_connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete no action,
  add constraint external_effects_integration_resource_fk
    foreign key (integration_resource_id, integration_connection_id)
    references bakery.integration_resources (id, connection_id)
    on delete no action;

-- Plain btree indexes behind the new referencing keys (0127 precedent).
create index external_effects_integration_connection_idx
  on bakery.external_effects (organization_id, integration_connection_id);
create index external_effects_integration_resource_idx
  on bakery.external_effects (integration_resource_id,
    integration_connection_id);
