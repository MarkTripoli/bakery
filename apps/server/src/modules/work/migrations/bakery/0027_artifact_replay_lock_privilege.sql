-- Row-level replay locking requires only the locked row identity to be
-- updateable by the runtime role; replay payloads remain immutable.
grant update (id) on bakery.artifact_publication_replays to bakery_app;
