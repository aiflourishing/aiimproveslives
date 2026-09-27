-- Retain votes and existing grants. Submission time is populated by trusted sync.
begin;
alter table private.impacts add column submitted_at timestamptz;

create or replace function public.ranked_impacts()
returns table(impact_id uuid)
language sql stable security definer set search_path = '' as $$
  with votes as (
    select r.impact_id, case when reaction in ('improved','heart') then 1 else -1 end as score
      from private.reactions r
    union all
    select g.impact_id, case when reaction in ('-1','confused') then -1
      when reaction = 'laugh' then 0 else 1 end
      from private.github_reactions g
  )
  select i.id from private.impacts i left join votes v on v.impact_id = i.id
    where i.active group by i.id
    order by coalesce(sum(v.score),0) desc, i.submitted_at desc nulls last, i.id;
$$;

-- Replace the old signature with an optional metadata argument; old callers still work.
drop function public.sync_github_reactions(uuid[], jsonb);
create function public.sync_github_reactions(p_impacts uuid[], p_reactions jsonb, p_submitted_at jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.impacts set active = false;
  insert into private.impacts(id, active, submitted_at)
    select id, true, (p_submitted_at ->> id::text)::timestamptz from unnest(p_impacts) as ids(id)
    on conflict(id) do update set active = true,
      submitted_at = coalesce(excluded.submitted_at, private.impacts.submitted_at);
  delete from private.github_reactions;
  insert into private.github_reactions(reaction_id, impact_id, github_user_id, reaction, created_at)
    select x.reaction_id, x.impact_id, x.github_user_id, x.reaction, x.created_at
    from jsonb_to_recordset(p_reactions) as x(
      reaction_id bigint, impact_id uuid, github_user_id bigint, reaction text, created_at timestamptz
    );
end $$;
revoke all on function public.sync_github_reactions(uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sync_github_reactions(uuid[], jsonb, jsonb) to service_role;
commit;
