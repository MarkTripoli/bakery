-- Issue #21: a delivery identity is stable across attempts, so uniqueness on it
-- alone made a retry impossible.
--
-- 0185 declared `unique (delivery_identity)` while the dispatch path derived the
-- identity from the subscription, the source event and the attempt. Those two
-- facts agreed only by accident: the identity changed per attempt, so the unique
-- constraint never collided. Fixing the identity to be stable - which is what it
-- has to be, because it is the key a receiver deduplicates on - turned the
-- constraint into a wall: the second attempt at one delivery collided with the
-- first and an uncertain delivery could never be retried at all.
--
-- The table's own key already says what a row is: one attempt of one event from
-- one subscription, `(subscription_id, source_event_id, attempt)`. What repeats
-- across attempts is the identity, deliberately. So the constraint has to be the
-- pair, not the identity alone.
--
-- Dropping and re-adding rather than altering keeps this additive: no row, column
-- or other constraint moves, and the replacement constrains one more column than
-- the one it replaces.
alter table bakery.integration_deliveries
  drop constraint integration_deliveries_identity_unique;

alter table bakery.integration_deliveries
  add constraint integration_deliveries_identity_attempt_unique
  unique (delivery_identity, attempt);
