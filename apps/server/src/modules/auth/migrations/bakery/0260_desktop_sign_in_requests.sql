-- Browser sign-in requests of the first-party desktop app (issue #77, FS25).
--
-- One row is one request the app opened. The lifecycle lives in TypeScript
-- (`domain/desktop-sign-in.ts`), not in CHECK constraints or triggers:
--   client_id          the built-in desktop client the request is bound to;
--   code_challenge     PKCE S256 challenge; the verifier is never stored;
--   redirect_uri       loopback or app-link address the browser hands the
--                      one-time code to;
--   computer_name      shown on the confirmation page and in Active sessions;
--   expires_at         ten minutes after opening (set by the writer);
--   decision           null until the person answers: approved or cancelled;
--   principal_id       the signed-in person who approved;
--   factor_verified_at copied from the approving browser session, so the
--                      issued sign-in carries the same assurance;
--   code_hash          SHA-256 hex of the one-time code; the plaintext lives
--                      only in the redirect the browser follows;
--   consumed_at        set by the one exchange attempt that spent the row;
--   session_id         the public.session row the exchange issued. No foreign
--                      key: revoking that session must not touch this row.
create table bakery.desktop_sign_in_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  code_challenge text not null,
  redirect_uri text not null,
  computer_name text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decision text,
  decided_at timestamptz,
  principal_id uuid,
  factor_verified_at timestamptz,
  code_hash text,
  consumed_at timestamptz,
  session_id uuid,
  constraint desktop_sign_in_requests_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint desktop_sign_in_requests_code_hash_unique unique (code_hash)
);

create index desktop_sign_in_requests_principal_idx
  on bakery.desktop_sign_in_requests (principal_id);

create index desktop_sign_in_requests_expires_idx
  on bakery.desktop_sign_in_requests (expires_at);

grant select, insert, update on bakery.desktop_sign_in_requests to bakery_app;
