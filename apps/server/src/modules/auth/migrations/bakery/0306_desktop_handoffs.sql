-- One-use handoffs from the desktop app's credential to a browser session in
-- its own window (issue #77, FS25 slice 5).
--
-- The desktop window loads the server's web pages, which authenticate with the
-- browser cookie, never a bearer value. The app trades its credential for a
-- code that lives seconds, opens the handoff page with it, and the server sets
-- an ordinary browser session for the same person. The lifecycle lives in
-- TypeScript (`adapters/desktop-handoff-postgres.ts`), not in CHECK
-- constraints or triggers:
--   code_hash          SHA-256 hex of the code; the plaintext is returned once
--                      to the app and travels only in the handoff URL;
--   desktop_session_id the desktop sign-in (public.session) that asked for
--                      it; the handoff is refused once that session is gone.
--                      No foreign key: ending that session must not touch this
--                      row, it only makes the code useless;
--   principal_id       the person, kept for audit and cleanup;
--   return_to          the same-origin path the browser is sent to;
--   expires_at         seconds after creation (set by the writer);
--   consumed_at        set by the one attempt that spent the code;
--   browser_session_id the public.session row the handoff issued; a replay
--                      deletes it.
create table bakery.desktop_handoffs (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  desktop_session_id uuid not null,
  principal_id uuid not null,
  return_to text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  browser_session_id uuid,
  constraint desktop_handoffs_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint desktop_handoffs_code_hash_unique unique (code_hash)
);

create index desktop_handoffs_principal_idx
  on bakery.desktop_handoffs (principal_id);

create index desktop_handoffs_expires_idx
  on bakery.desktop_handoffs (expires_at);

grant select, insert, update on bakery.desktop_handoffs to bakery_app;
