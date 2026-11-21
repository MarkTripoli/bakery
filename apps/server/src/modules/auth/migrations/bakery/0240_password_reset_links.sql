-- Administrator-issued password reset links (issue #241).
--
-- Only an installation administrator issues one, for any human principal; an
-- organization admin cannot, because a person can belong to several
-- organizations and a reset hands over all of them. One row is one link:
--   token_hash   SHA-256 hex of the 32-byte random token. The plaintext lives
--                only in the issue response's URL and is never stored;
--   expires_at   one hour after issue (set by the writer, not a default);
--   used_at      set by the one redemption that consumed the link;
--   revoked_at   set when a newer link was issued for the same person.
-- Lifecycle rules (unused, unrevoked, unexpired) are TypeScript's, not CHECK
-- constraints or triggers.
create table bakery.password_reset_links (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null,
  token_hash text not null,
  issued_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  constraint password_reset_links_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint password_reset_links_issued_by_fk
    foreign key (issued_by_principal_id)
    references bakery.principals (id) on delete restrict,
  constraint password_reset_links_token_hash_unique unique (token_hash)
);

create index password_reset_links_principal_idx
  on bakery.password_reset_links (principal_id);

grant select, insert, update on bakery.password_reset_links to bakery_app;
