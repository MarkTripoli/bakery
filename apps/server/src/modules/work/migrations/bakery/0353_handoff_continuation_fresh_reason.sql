-- Why a handoff continuation started fresh (issue #72, design revision 3).
--
-- `mode` already says whether the continuation will resume exactly or start a
-- fresh session. When it is fresh, the server knew why at the moment it decided
-- (the reason set in handoff-eligibility.ts), but only the audit row and the
-- event kept it, so a replayed continue could not say it and the page could not
-- tell a person why their step did not pick up where it stopped.
--
-- Rules for this column:
-- * Written once, by the insert that admits the continuation, and never
--   edited: the application role keeps INSERT and SELECT only.
-- * Null for an exact resume, and for every continuation admitted before this
--   column existed (their reason stays in the audit row).
-- * The value set is the FreshReason union in handoff-eligibility.ts; the
--   PostgreSQL boundary rail forbids CHECK constraints and triggers.
alter table bakery.handoff_continuations
  add column fresh_reason text;
