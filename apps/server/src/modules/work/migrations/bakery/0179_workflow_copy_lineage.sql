-- Where a copied workflow definition came from (issue #35, AC1 and the copy
-- checklist item). origin_kind 'copy' (0175) says a definition was copied from
-- another; these columns say from which definition, which version of it and
-- what that version's digest was at the moment of the copy, so a later source
-- update can be compared with the fork and never rewrites it.
-- Structure only, like 0175: the pairing rule (a 'copy' carries all three, every
-- other kind carries none) is a property of the one statement that writes them,
-- not a constraint. The columns are written on insert and never updated, and the
-- source ids are plain uuids, not foreign keys: a fork must outlive its source.
alter table bakery.workflow_definitions
  add column origin_source_workflow_id uuid,
  add column origin_source_version_id uuid,
  add column origin_source_digest text;
