grant select, insert, update, delete
on table
  public."user",
  public.session,
  public.account,
  public.verification,
  public.organization,
  public.member,
  public.invitation
to bakery_app;
