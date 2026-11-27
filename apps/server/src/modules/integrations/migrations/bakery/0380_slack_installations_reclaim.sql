alter table bakery.slack_installations
  drop constraint slack_installations_workspace_unique;

create unique index slack_installations_active_workspace_unique
  on bakery.slack_installations (app_id, team_id)
  where status = 'active';
