-- #38 slice 2: explicit epoch rollover for collaborative drafts.
-- drafts.rollover closes the current epoch and opens the next one from a
-- checkpoint that is already published, so the app role may now update a
-- draft's epoch. The checkpoint, update and receipt rows of the old epoch stay
-- as they are; they are keyed by epoch and never mix with the new one.
grant update (epoch) on bakery.artifact_drafts to bakery_app;
