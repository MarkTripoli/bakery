-- Issue 82 / #409 slice 3: admit tickets from more than one provider.
--
-- Structure only: no CHECK, no trigger, no default that decides a provider.
--
-- A ticket source stops assuming GitHub. The columns that only GitHub fills
-- become nullable, so a source that has no GitHub application and no repository
-- row is still a valid source, and anything a provider needs to remember about
-- its own container lives in provider_metadata rather than in a column this
-- schema would have to widen again for the next provider.
--
-- inbound_events.registration_id becomes nullable for the same reason: today
-- every inbound delivery arrives through a GitHub app registration, but a
-- provider that verifies a webhook with a shared secret has no registration to
-- point at and must still be able to record the receipt.
--
-- The provider default is dropped rather than changed to another provider: a
-- source states its provider, and a default would quietly admit a row that
-- never said.

alter table bakery.ticket_sources
  alter column application_id drop not null,
  alter column provider drop default,
  add column provider_metadata jsonb;

-- The receipt key has to keep refusing a redelivery now that the registration
-- may be null, and a plain unique treats every null as distinct: two
-- redeliveries of the same null-registration webhook would both land, and the
-- receipt would prove nothing for exactly the rows this change introduces.
-- NULLS NOT DISTINCT is PostgreSQL 15+; every target here is 16.
--
-- Dropped and added in one statement so no concurrent insert sees a table
-- without the key, and so a failure leaves the old constraint in place.
alter table bakery.inbound_events
  alter column registration_id drop not null,
  drop constraint inbound_events_delivery_unique,
  add constraint inbound_events_delivery_unique
    unique nulls not distinct (registration_id, external_delivery_id);
