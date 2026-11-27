export function passedOnFromJoin(request: string, alias: string): string {
  return `left join lateral (
    select coalesce(first_request.audience_name, first_recipient.display_name)
             as name
      from bakery.person_request_next_asks next_claim
      join lateral (
        select min(sibling.created_at) as first_asked_at
          from bakery.person_requests sibling
         where sibling.organization_id = ${request}.organization_id
           and sibling.run_id = ${request}.run_id
           and sibling.step_key = ${request}.step_key
           and sibling.step_iteration = ${request}.step_iteration
      ) first_ask on true
      join bakery.person_requests first_request
        on first_request.organization_id = ${request}.organization_id
       and first_request.run_id = ${request}.run_id
       and first_request.step_key = ${request}.step_key
       and first_request.step_iteration = ${request}.step_iteration
       and first_request.created_at = first_ask.first_asked_at
      join bakery.principals first_recipient
        on first_recipient.id = first_request.recipient_id
     where next_claim.organization_id = ${request}.organization_id
       and next_claim.run_id = ${request}.run_id
       and next_claim.step_key = ${request}.step_key
       and next_claim.step_iteration = ${request}.step_iteration
       and ${request}.created_at > first_ask.first_asked_at
       and ${request}.created_at >= next_claim.asked_at
     order by first_request.created_at, first_request.id
     limit 1
  ) ${alias} on true`;
}
