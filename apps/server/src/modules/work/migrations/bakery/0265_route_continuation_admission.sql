-- Route continuation admission (#26 slice 6b/6c): the grants it needs, and why
-- they are this narrow.
--
-- A continuation moves a stalled step to another provider route by re-pricing the
-- step's ONE budget reservation in place: the same intent and the same two
-- reservations, the same dedupe key, new provider, model, billing account and
-- pricing snapshot. Nothing is left held and nothing new is reserved, so there is
-- nothing to leak and claim, settlement and the reconcile sweeps need no change.
--
-- That means writing columns the budget tables deliberately do NOT let the
-- application role write. The budget identity is immutable by grant: 0060 and 0064
-- grant UPDATE only on status and version columns, so a mistaken writer cannot
-- quietly re-attribute spend. These grants lift exactly that wall, for exactly the
-- identity columns a re-price changes and no others. The amounts stay out of
-- reach (`reserved_usd`, `max_usd_reservation`, `max_tokens`), as do the run, the
-- step, the agent version, the content digest and the dedupe key: an admission
-- changes where a step's spend goes, never how much is held or which action it
-- belongs to. The application refuses to re-price anything that has dispatched,
-- and a column grant is only the second wall.
--
--   - `budget_action_intents`: the identity columns of the intent,
--   - `provider_call_intents`: the identity columns of the pending call and the
--     pricing snapshot it points at,
--   - `jobs`: `billing` and `agent_config`, which the claim path requires to equal
--     the intent (a changed pin under an unchanged job is refused at claim),
--   - `route_continuations`: INSERT, the record of the admission. It is written
--     once and never changed or removed: no UPDATE and no DELETE.
--
-- "One continuation per step and incident generation" is the unique constraint
-- 0230 states, and it is what makes a second concurrent winner impossible even if
-- the application's locking were wrong.

grant update (
  provider, billing_account_id, model, billing_route, pricing_metadata_snapshot
) on bakery.budget_action_intents to bakery_app;

grant update (
  provider, billing_account_id, model, billing_type, pricing_snapshot_id,
  pricing_metadata_snapshot
) on bakery.provider_call_intents to bakery_app;

grant update (billing, agent_config) on bakery.jobs to bakery_app;

grant insert on bakery.route_continuations to bakery_app;
