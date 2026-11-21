-- GHI-42: a skill made by copying another keeps where it came from: the source
-- skill and the exact version the copy started from. Both are null for a skill
-- that was not copied. They are written once, in the insert that makes the copy,
-- and never changed: bakery_app's update on bakery.skills is column-scoped (0055)
-- and names neither column. A source skill or version that has a copy cannot be
-- deleted out from under it.
alter table bakery.skills
  add column copied_from_skill_id uuid,
  add column copied_from_version_id uuid,
  add constraint skills_copied_from_skill_fk
    foreign key (organization_id, copied_from_skill_id)
    references bakery.skills (organization_id, id) on delete restrict,
  add constraint skills_copied_from_version_fk
    foreign key (organization_id, copied_from_version_id, copied_from_skill_id)
    references bakery.skill_versions (organization_id, id, skill_id)
    on delete restrict;
